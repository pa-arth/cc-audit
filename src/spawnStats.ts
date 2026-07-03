// Per-spawn economics. Every subagent spawn (Agent tool, workflow agent()) starts a
// fresh context and RE-WRITES the standing block — system prompt + CLAUDE.md stack +
// memory + tool schemas — at cache-WRITE prices, plus a slice of uncached input. That
// setup cost is fixed per spawn (~17k tokens median observed) regardless of how much
// work the agent then does, so it's the denominator of every delegation decision.
// Both the always-on tax (alwaysOn.ts) and the delegation-breakeven recommendation
// (recommend.ts) read from here so "what counts as a spawn" lives in one place.

import { getAnthropicPricing } from './vendor/pricing.js';
import type { Session } from './model.js';

/** Fallbacks for unknown models, one consistent family (standard multipliers off a
 *  0.4 $/1M cache-read): input = 10× read, 5-min write = 1.25× input, 1h write = 2×
 *  input. Exported so alwaysOn prices with the SAME fallbacks — keep in lockstep
 *  with vendor/pricing.ts when rates change. */
export const FALLBACK_READ_RATE = 0.4;
export const FALLBACK_INPUT_RATE = 4.0;
export const FALLBACK_WRITE_RATE = 5.0;
export const FALLBACK_WRITE_1H_RATE = 8.0;

/** One subagent spawn's token economics, extracted from its sidechain span. */
export interface SpawnStat {
  /** Turn-1 prefix: input + cacheWrite5m + cacheWrite1h — the standing block this
   *  spawn re-wrote (plus its task prompt, small next to the ~17k standing context). */
  prefixTok: number;
  /** Turn-1 cache-write tokens only (the fresh cache the spawn paid for). */
  writeTok: number;
  /** Turn-1 uncached input tokens. */
  inputTok: number;
  /** New tokens over the whole span: input + cacheWrite5m + cacheWrite1h + output
   *  (cache reads excluded — they're re-reads, not new material). */
  newTok: number;
  /** Total output tokens over the span. */
  outTok: number;
  /** Model of the spawn's first turn (spawns rarely switch models mid-run). */
  model: string | null;
  /** Turn-1 cache writes in USD, each bucket at its own rate (5-min vs 1h). */
  writeUsd: number;
  /** Fixed setup cost in USD: writeUsd + turn-1 uncached input at the input rate.
   *  What the spawn burned before doing any work — the cost inline execution would
   *  not have paid. */
  setupUsd: number;
}

/** Middle element of the sorted list (upper median); 0 on empty. Shared with
 *  alwaysOn.ts, which historically kept a private copy. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** One spawn = one sidechain span with at least one counted turn. Covers both
 *  transcript formats: sidechain rows inlined in the parent session file (legacy)
 *  and separate <session>/subagents/agent-*.jsonl files that parse as their own
 *  all-sidechain Sessions (CC v2.1.x). The turns-length guard is load-bearing:
 *  the adapter's global message-id dedup leaves a re-parsed duplicate span with
 *  zero turns, so a spawn logged in two files is still counted once. */
export function collectSpawnStats(sessions: Session[]): SpawnStat[] {
  const out: SpawnStat[] = [];
  for (const s of sessions) {
    for (const span of s.spans) {
      if (!span.isSidechain || span.turns.length === 0) continue;
      const t1 = span.turns[0]!;
      const writeTok = t1.usage.cacheWrite5m + t1.usage.cacheWrite1h;
      const inputTok = t1.usage.input;
      let newTok = 0;
      let outTok = 0;
      for (const t of span.turns) {
        newTok += t.usage.input + t.usage.cacheWrite5m + t.usage.cacheWrite1h + t.usage.output;
        outTok += t.usage.output;
      }
      const p = t1.model ? getAnthropicPricing(t1.model) : null;
      const writeUsd =
        (t1.usage.cacheWrite5m * (p ? p.cacheWrite5min : FALLBACK_WRITE_RATE) +
          t1.usage.cacheWrite1h * (p ? p.cacheWrite1hr : FALLBACK_WRITE_1H_RATE)) /
        1_000_000;
      const setupUsd = writeUsd + (inputTok * (p ? p.input : FALLBACK_INPUT_RATE)) / 1_000_000;
      out.push({
        prefixTok: inputTok + writeTok,
        writeTok,
        inputTok,
        newTok,
        outTok,
        model: t1.model,
        writeUsd,
        setupUsd,
      });
    }
  }
  return out;
}
