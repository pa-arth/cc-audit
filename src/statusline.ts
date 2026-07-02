// `cc-audit statusline` — a LIVE GUARDRAIL for context hygiene, designed to plug into the
// claude-hud statusline as an EXTRA-CMD label provider (NOT a standalone Claude Code
// statusLine command). claude-hud runs it with `execAsync(cmd, {timeout: 3000, maxBuffer:
// 10KB})` and expects JSON `{"label":"<string>"}` on stdout, which it sanitizes and
// truncates to 50 chars. It passes NO stdin, NO args, NO transcript path — the command
// inherits claude-hud's process cwd (the project working dir) and must SELF-DISCOVER the
// live session. Strictly LOCAL — never touches the network.
//
// Per-invocation work is cheap (well under the 3s budget): read the CACHED personal knee,
// tail the ONE live transcript for current ctx + recent turns. The expensive cross-session
// knee is cached to disk and refreshed lazily in the background (see kneeCache.ts).
//
// Two-part trigger (design LOCKED):
//   1. The personal KNEE arms the guardrail — the context band where the user's own
//      re-reads + friction first jump ≥2× baseline (computeContextKnee; nobody without
//      local transcript access can produce it). Below it, or without ≥2 sessions of signal,
//      we show only a ctx gauge — never a wrong threshold.
//   2. A compact BOUNDARY fires it — past the knee we WARN (soft); AT a compact boundary
//      (topic shift AND file rotation, detectLiveBoundary) we say compact now (hard).

import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { findLiveTranscript, parseTranscript } from './adapters/claudeCode.js';
import { contextTokens } from './contextHygiene.js';
import { detectLiveBoundary } from './liveBoundary.js';
import { isKneeCacheStale, readKneeCache, spawnKneeRefresh } from './kneeCache.js';
import { installStatusline, uninstallStatusline } from './statuslineInstall.js';
import { allTurns, type Session } from './model.js';

export interface StatuslineState {
  /** Live context size (tokens) of the current turn, or null when undiscoverable. */
  liveCtx: number | null;
  /** Personal degradation onset (tokens); null when there isn't ≥2 sessions of signal. */
  onsetTokens: number | null;
  /** Is the latest prompt a compact boundary (topic shift AND file rotation)? */
  boundary: boolean;
}

/** Round tokens to a compact "137k" label. */
function fmtK(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * The label string (before claude-hud's 50-char clamp). Pure so it's trivially testable:
 *   - undiscoverable ctx                → empty (claude-hud renders nothing)
 *   - no trustworthy knee / below knee  → a plain ctx gauge ("ctx 82k")
 *   - armed (ctx ≥ knee), no boundary   → SOFT warn ("⚠ past your knee · 150k")
 *   - armed + boundary                  → HARD ("✂ compact now · 180k")
 * All variants stay well under 50 chars.
 */
export function renderStatuslineLabel(s: StatuslineState): string {
  if (s.liveCtx == null) return '';
  const ctx = fmtK(s.liveCtx);
  if (s.onsetTokens == null || s.liveCtx < s.onsetTokens) return `ctx ${ctx}`;
  if (s.boundary) return `✂ compact now · ${ctx}`;
  return `⚠ past your knee · ${ctx}`;
}

/** Context size of the most recent own-chain turn — the live ctx gauge. */
function lastOwnCtx(session: Session): number | null {
  let ctx: number | null = null;
  for (const t of allTurns(session)) {
    const c = contextTokens(t);
    if (c > 0) ctx = c;
  }
  return ctx;
}

/**
 * Resolve the statusline state for a working directory: the cached knee (with a lazy
 * background refresh when stale), plus the live ctx + boundary from the self-discovered
 * transcript. Never throws. `root` overrides the transcript root (tests / non-default).
 */
export function resolveStatuslineState(cwd: string, root?: string): StatuslineState {
  // The armed threshold: read the cached knee; kick a detached refresh when it's stale.
  const cache = readKneeCache();
  if (isKneeCacheStale(cache, root ?? null)) spawnKneeRefresh(root);
  const onsetTokens = cache?.onsetTokens ?? null;

  // Live ctx + boundary from the self-discovered current transcript.
  let liveCtx: number | null = null;
  let boundary = false;
  const tp = findLiveTranscript(cwd, root);
  if (tp) {
    try {
      const session = parseTranscript(tp, readFileSync(tp, 'utf8'), basename(dirname(tp)));
      if (session) {
        liveCtx = lastOwnCtx(session);
        boundary = detectLiveBoundary(session);
      }
    } catch {
      /* transcript gone/locked — degrade to an empty label */
    }
  }
  return { liveCtx, onsetTokens, boundary };
}

/**
 * Run the statusline: self-discover the live session for the current cwd, resolve state,
 * and print the claude-hud extra-cmd JSON `{"label":"..."}`. Non-interactive, local-only,
 * fast (< 3s), and it NEVER throws — any failure prints an empty label so claude-hud
 * renders nothing rather than an error. `--root DIR` overrides the transcript root.
 */
export function runStatusline(argv: string[]): void {
  // `--install` / `--uninstall` self-wire into claude-hud (the ONLY paths that touch
  // settings.json, alongside an interactive "yes"). They print human text + set an exit code
  // — they are NOT the label emitter, so they never print the {"label":…} JSON.
  if (argv.includes('--install')) {
    const r = installStatusline();
    process.stdout.write(`${r.message}\n`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (argv.includes('--uninstall')) {
    const r = uninstallStatusline();
    process.stdout.write(`${r.message}\n`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  let label = '';
  try {
    const rootIdx = argv.indexOf('--root');
    const root = rootIdx >= 0 ? argv[rootIdx + 1] : undefined;
    label = renderStatuslineLabel(resolveStatuslineState(process.cwd(), root));
  } catch {
    /* a statusline must never surface an error — fall through to the empty label */
  }
  process.stdout.write(`${JSON.stringify({ label })}\n`);
}
