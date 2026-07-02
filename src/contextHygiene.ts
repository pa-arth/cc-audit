// Context hygiene — the avoidable half of the carry bill. Carrying the transcript
// each turn is mostly structural (you can't continue a task without its context), but
// a real slice is AVOIDABLE and operator-controlled: context grown fat past the point
// a /compact would have paid for itself, and context dragged across a task switch a
// /clear would have shed. We MEASURE that slice from the token trajectory rather than
// asserting it — every dollar here is carry the user actually paid on context that, by
// a deliberately conservative rule, didn't need to be there.
//
// Fully LOCAL and deterministic — no egress, no model id window assumptions. The
// "should have compacted" line is an ECONOMIC threshold, not a fraction of the context
// window (which the transcript doesn't even record): carrying N tokens for K more turns
// costs the same whether the window is 200K or 1M, so the trigger is absolute size +
// sustained runway, corroborated by the ground-truth auto-compaction marker (the wall).

import type { AssistantTurn, Session } from './model.js';
import { turnCarryUsd } from './fluency.js';
import { cacheRatesUsdPerToken } from './pricing.js';

// "Overdue" is no longer a fixed token ceiling — it's the per-turn COMPACT COUNTERFACTUAL.
// A /compact pays off at turn t when the cache-read it sheds over the remaining runway
// beats the one-off cost of re-caching the summary:
//   savings(t)  = tokensShed(t) × cacheReadRate × remainingTurns
//   compactCost = ctx(t) × cacheReadRate           (summarize reads the live context)
//               + postCompact × cacheWriteRate      (re-cache the compacted context, 1.25×)
//   tokensShed  = ctx(t) − ctx(t)×compressionRatio
// A turn is "overdue" when net = savings − compactCost > 0. This replaces the old flat
// ~160K line: whether a big context is worth compacting depends on how many turns are
// left and the model's cache rates, not an absolute size (a 200K context with two turns
// to go is NOT worth compacting; a 90K context with fifty turns to go is).
const DEFAULT_COMPRESSION_RATIO = 0.35;
// A compaction only pays off with real runway left — a brief spike at a segment's tail
// isn't worth it. Require a sustained run of net-positive turns before calling it overdue.
const MIN_OVERDUE_TURNS = 6;

// Clear detector (heuristic): a task switch only stranded avoidable carry if there was
// meaningful context to shed AND the file working set genuinely rotated.
const STALE_FLOOR_TOKENS = 40_000; // below this, carrying it forward is cheap noise
/** Turns each side of a candidate task-switch boundary that characterize the before/after
 *  working set. Exported so the live-guardrail statusline shares one rotation definition. */
export const WS_WINDOW = 4;
/** Both sides of a boundary must touch this many real, distinct files for a rotation. */
export const MIN_FILES_EACH_SIDE = 2;
const STALE_ATTRIB_TURNS = 12; // cap how far past a switch we attribute stale carry

const RESET_COMMANDS = new Set(['compact', 'clear']);
const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Total context tokens billed to a turn (everything on the input side — what a reset
 *  would shed). Output is what you generate, not what you carry. Exported: the context-
 *  knee buckets and the live statusline bucket every turn by exactly this size. */
export function contextTokens(t: AssistantTurn): number {
  const u = t.usage;
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** One missed-/compact episode, located by main-chain turn ordinal. LOCAL-ONLY (carries
 *  a project label + sessionId for the report; never enters the uploaded aggregate). */
export interface OverdueCompactEpisode {
  project: string;
  sessionId: string;
  /** 1-based main-chain turn ordinal where context first crossed the line — the spot a
   *  proactive /compact should have happened. */
  atTurn: number;
  /** How many consecutive turns ran overdue before a reset (or the session ended). */
  overdueTurns: number;
  peakTokens: number;
  /** Carry paid on the sheddable fraction (1 − compressionRatio) of context during the
   *  episode — what a timely /compact, sized by the user's own compression ratio, would
   *  have removed. */
  avoidableUsd: number;
}

/** One likely missed-/clear task switch. LOCAL-ONLY. Heuristic (file-working-set
 *  rotation), so framed softer than the compact episodes. */
export interface StaleCarrySwitch {
  project: string;
  sessionId: string;
  atTurn: number;
  staleTokens: number;
  avoidableUsd: number;
}

export interface ContextHygiene {
  windowDays: number;
  // ── /compact detector (high confidence) ──────────────────────────────────────
  /** Ground truth: total times a session ran to the context wall and Claude Code
   *  force-compacted (the most egregious "should have compacted earlier"). */
  autoCompactions: number;
  /** Distinct sessions that hit the wall ≥ once. */
  sessionsRunToWall: number;
  /** Located missed-/compact episodes, biggest $ first (LOCAL-ONLY). */
  overdueEpisodes: OverdueCompactEpisode[];
  /** Carry paid above the compaction line across all episodes, over the window. */
  avoidableCompactUsd: number;
  // ── /clear detector (heuristic) ──────────────────────────────────────────────
  staleCarrySwitches: StaleCarrySwitch[];
  /** Conservative estimate of carry spent dragging finished-task context past a switch. */
  avoidableClearUsd: number;
  // ── headline ─────────────────────────────────────────────────────────────────
  /** compact + clear avoidable carry over the window. */
  avoidableTotalUsd: number;
}

/** Split a session's main chain into segments separated by resets (/clear, /compact, or
 *  an auto-compaction wall). Each segment is a contiguous run of turns that accumulate
 *  one context — the unit the detectors reason over. */
function segments(session: Session): AssistantTurn[][] {
  const segs: AssistantTurn[][] = [];
  let cur: AssistantTurn[] = [];
  for (const span of session.spans) {
    if (span.isSidechain) continue;
    const isReset = span.autoCompacted || (span.command != null && RESET_COMMANDS.has(span.command));
    if (isReset && cur.length) {
      segs.push(cur);
      cur = [];
    }
    for (const t of span.turns) cur.push(t);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/** Net USD a /compact landing at turn `t` of the segment would save (see the counterfactual
 *  note at the top of the file). Positive ⇒ compacting here pays for itself. −∞ when there's
 *  no runway left or no context to shed. `ratio` is the user's own compression ratio. */
function compactNetUsd(seg: AssistantTurn[], t: number, ratio: number): number {
  const remainingTurns = seg.length - 1 - t; // turns AFTER a compact landing at t
  if (remainingTurns <= 0) return Number.NEGATIVE_INFINITY;
  const ctxT = contextTokens(seg[t]!);
  if (ctxT <= 0) return Number.NEGATIVE_INFINITY;
  const { cacheRead, cacheWrite } = cacheRatesUsdPerToken(seg[t]!.model);
  const postCompact = ctxT * ratio;
  const tokensShed = ctxT - postCompact;
  const savings = tokensShed * cacheRead * remainingTurns;
  const compactCost = ctxT * cacheRead + postCompact * cacheWrite;
  return savings - compactCost;
}

/** Maximal runs of consecutive turns where the compact counterfactual nets positive and
 *  the run clears the sustained-runway bar. `offset` is the segment's first turn's session-
 *  wide ordinal; `ratio` the user's own compression ratio. Avoidable carry is the carry
 *  paid on the sheddable fraction (1 − ratio) of each overdue turn — the part a timely
 *  /compact would have removed. */
function overdueRuns(
  seg: AssistantTurn[],
  offset: number,
  ratio: number,
): Omit<OverdueCompactEpisode, 'project' | 'sessionId'>[] {
  const out: Omit<OverdueCompactEpisode, 'project' | 'sessionId'>[] = [];
  let i = 0;
  while (i < seg.length) {
    if (compactNetUsd(seg, i, ratio) <= 0) {
      i += 1;
      continue;
    }
    let j = i;
    let peak = 0;
    let avoid = 0;
    while (j < seg.length && compactNetUsd(seg, j, ratio) > 0) {
      peak = Math.max(peak, contextTokens(seg[j]!));
      // Carry on the sheddable fraction — what a timely compaction would have removed.
      avoid += turnCarryUsd(seg[j]!.model, seg[j]!.usage) * (1 - ratio);
      j += 1;
    }
    const len = j - i;
    if (len >= MIN_OVERDUE_TURNS) {
      out.push({ atTurn: offset + i + 1, overdueTurns: len, peakTokens: peak, avoidableUsd: avoid });
    }
    i = j;
  }
  return out;
}

/** The user's OWN compression ratio (post-compact ÷ pre-compact context size), measured by
 *  bracketing each compact reset with the last turn before it and the first turn after it,
 *  averaged over the session's compacts. A /clear sheds everything (not a compression), so
 *  it's excluded. Falls back to DEFAULT_COMPRESSION_RATIO when the session never compacted
 *  or the brackets are unusable. */
export function observedCompressionRatio(session: Session): number {
  const ratios: number[] = [];
  let prevCtx: number | null = null; // last turn's context so far on the main chain
  let pendingCompact = false; // the next main-chain turn is the first post-compact turn
  for (const span of session.spans) {
    if (span.isSidechain) continue;
    const isCompact = span.autoCompacted || span.command === 'compact';
    if (span.command === 'clear') {
      prevCtx = null; // clear resets the chain; nothing to bracket
      pendingCompact = false;
    } else if (isCompact && prevCtx != null) {
      pendingCompact = true;
    }
    for (const t of span.turns) {
      const ctx = contextTokens(t);
      if (pendingCompact) {
        if (prevCtx != null && ctx > 0 && ctx < prevCtx) ratios.push(ctx / prevCtx);
        pendingCompact = false; // only the FIRST post-compact turn is the "after"
      }
      prevCtx = ctx;
    }
  }
  if (ratios.length > 0) return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return DEFAULT_COMPRESSION_RATIO;
}

/** Distinct file paths touched (Read/Edit/Write) over a slice of turns. Exported so the
 *  live-guardrail statusline computes the file working set exactly the same way. */
export function filesTouched(seg: AssistantTurn[], from: number, to: number): Set<string> {
  const s = new Set<string>();
  for (let k = Math.max(0, from); k < Math.min(seg.length, to); k += 1) {
    for (const op of seg[k]!.fileOps ?? []) {
      if (READ_TOOLS.has(op.tool) || WRITE_TOOLS.has(op.tool)) s.add(op.path);
    }
  }
  return s;
}

/** Does the file working set fully ROTATE across `boundary` (the first turn of the "after"
 *  side): ≥ MIN_FILES_EACH_SIDE distinct files each side within WS_WINDOW turns, zero
 *  overlap. The file-rotation half of a compact boundary — shared by staleSwitches (the
 *  "new idea, didn't /clear" detector) and the live-guardrail statusline. */
export function workingSetRotated(seg: AssistantTurn[], boundary: number): boolean {
  const prev = filesTouched(seg, boundary - WS_WINDOW, boundary);
  const next = filesTouched(seg, boundary, boundary + WS_WINDOW);
  return (
    prev.size >= MIN_FILES_EACH_SIDE &&
    next.size >= MIN_FILES_EACH_SIDE &&
    ![...next].some((p) => prev.has(p)) // zero overlap
  );
}

/** Likely "new idea, didn't /clear" boundaries in one segment: the file working set
 *  fully rotates (zero overlap, real files each side) while context was non-trivial. */
function staleSwitches(seg: AssistantTurn[], offset: number): Omit<StaleCarrySwitch, 'project' | 'sessionId'>[] {
  const out: Omit<StaleCarrySwitch, 'project' | 'sessionId'>[] = [];
  let k = WS_WINDOW;
  while (k < seg.length - WS_WINDOW) {
    const rotated = workingSetRotated(seg, k);
    const stale = contextTokens(seg[k - 1]!); // context a /clear would have shed here
    if (rotated && stale >= STALE_FLOOR_TOKENS) {
      // Carry spent dragging the stale context through the next task, decaying as the new
      // context grows and capped so we never attribute long-gone work to far-future turns.
      let avoid = 0;
      for (let m = k; m < Math.min(seg.length, k + STALE_ATTRIB_TURNS); m += 1) {
        const ctx = contextTokens(seg[m]!);
        if (ctx <= 0) continue;
        avoid += turnCarryUsd(seg[m]!.model, seg[m]!.usage) * Math.min(1, stale / ctx);
      }
      out.push({ atTurn: offset + k + 1, staleTokens: stale, avoidableUsd: avoid });
      k += WS_WINDOW; // don't re-detect the same rotation
    } else {
      k += 1;
    }
  }
  return out;
}

export function computeContextHygiene(sessions: Session[]): ContextHygiene {
  let autoCompactions = 0;
  let sessionsRunToWall = 0;
  const overdueEpisodes: OverdueCompactEpisode[] = [];
  const staleCarrySwitches: StaleCarrySwitch[] = [];
  let minMtime = Infinity;
  let maxMtime = 0;

  for (const session of sessions) {
    if (session.mtime) {
      minMtime = Math.min(minMtime, session.mtime);
      maxMtime = Math.max(maxMtime, session.mtime);
    }
    const walls = session.spans.filter((s) => !s.isSidechain && s.autoCompacted).length;
    autoCompactions += walls;
    if (walls > 0) sessionsRunToWall += 1;

    const ratio = observedCompressionRatio(session);
    let offset = 0;
    for (const seg of segments(session)) {
      for (const e of overdueRuns(seg, offset, ratio)) {
        overdueEpisodes.push({ project: session.project, sessionId: session.sessionId, ...e });
      }
      for (const sw of staleSwitches(seg, offset)) {
        staleCarrySwitches.push({ project: session.project, sessionId: session.sessionId, ...sw });
      }
      offset += seg.length;
    }
  }

  overdueEpisodes.sort((a, b) => b.avoidableUsd - a.avoidableUsd);
  staleCarrySwitches.sort((a, b) => b.avoidableUsd - a.avoidableUsd);
  const avoidableCompactUsd = overdueEpisodes.reduce((n, e) => n + e.avoidableUsd, 0);
  const avoidableClearUsd = staleCarrySwitches.reduce((n, e) => n + e.avoidableUsd, 0);
  const windowDays = maxMtime > minMtime ? Math.max(1, (maxMtime - minMtime) / 86_400_000) : 1;

  return {
    windowDays,
    autoCompactions,
    sessionsRunToWall,
    overdueEpisodes,
    avoidableCompactUsd,
    staleCarrySwitches,
    avoidableClearUsd,
    avoidableTotalUsd: avoidableCompactUsd + avoidableClearUsd,
  };
}
