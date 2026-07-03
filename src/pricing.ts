// Per-turn cost in USD, reusing the vendored config-cost authoritative pricing
// tables (src/vendor/pricing.ts). We compute directly from the pricing object
// (not computeCost) so we can bill the 5-minute vs 1-hour cache-write buckets at
// their distinct rates — that precision matters for the ±5% reconciliation gate.

import { getAnthropicPricing, getOpenAIPricing } from './vendor/pricing.js';
import type { TurnUsage } from './model.js';

// Sonnet-tier fallback for an unrecognized model id — never crash, but the report
// flags any spend that hit this path so a missing price can't silently distort.
const FALLBACK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5min: 3.75, cacheWrite1hr: 6 };

/**
 * Cost of one assistant turn. Pass the turn's epoch-ms timestamp (`AssistantTurn.ts`)
 * as `ts` so dated introductory pricing (e.g. Sonnet 5 until Sept 2026) reprices
 * historical usage at the rate that was actually billed; omitting it uses the
 * steady-state table rate.
 */
export function turnCostUsd(
  model: string | null,
  u: TurnUsage,
  ts?: number | null,
): { usd: number; priced: boolean } {
  const at = ts != null ? new Date(ts) : undefined;
  const a = model ? getAnthropicPricing(model, at) : null;
  if (a) {
    return {
      usd:
        (u.input * a.input +
          u.output * a.output +
          u.cacheRead * a.cacheRead +
          u.cacheWrite5m * a.cacheWrite5min +
          u.cacheWrite1h * a.cacheWrite1hr) /
        1_000_000,
      priced: true,
    };
  }
  const o = model ? getOpenAIPricing(model) : null;
  if (o) {
    // OpenAI auto-cache: cached input billed at cachedInput; no separate write bucket.
    return {
      usd:
        (u.input * o.input +
          u.output * o.output +
          u.cacheRead * o.cachedInput +
          (u.cacheWrite5m + u.cacheWrite1h) * o.input) /
        1_000_000,
      priced: true,
    };
  }
  return {
    usd:
      (u.input * FALLBACK.input +
        u.output * FALLBACK.output +
        u.cacheRead * FALLBACK.cacheRead +
        u.cacheWrite5m * FALLBACK.cacheWrite5min +
        u.cacheWrite1h * FALLBACK.cacheWrite1hr) /
      1_000_000,
    priced: false,
  };
}

export function turnTokens(u: TurnUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** Per-TOKEN cache-read and cache-write ($/token) rates for a model — the two prices the
 *  compact counterfactual turns on: carried context is cache-READ into every later turn,
 *  and the compacted summary is cache-WRITTEN once (Anthropic's 5-minute write bucket, the
 *  1.25× input rate). OpenAI has no separate cache write, so re-caching the compacted
 *  context is priced at its uncached input rate. Unknown model ⇒ the Sonnet-tier fallback,
 *  matching turnCostUsd. */
export function cacheRatesUsdPerToken(model: string | null): { cacheRead: number; cacheWrite: number } {
  const a = model ? getAnthropicPricing(model) : null;
  if (a) return { cacheRead: a.cacheRead / 1_000_000, cacheWrite: a.cacheWrite5min / 1_000_000 };
  const o = model ? getOpenAIPricing(model) : null;
  if (o) return { cacheRead: o.cachedInput / 1_000_000, cacheWrite: o.input / 1_000_000 };
  return { cacheRead: FALLBACK.cacheRead / 1_000_000, cacheWrite: FALLBACK.cacheWrite5min / 1_000_000 };
}

const PREMIUM_PREFIXES = ['claude-opus', 'claude-fable', 'gpt-5.5', 'claude-mythos'];
export function isPremiumModel(model: string | null): boolean {
  return !!model && PREMIUM_PREFIXES.some((p) => model.startsWith(p));
}
