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

// "Compaction territory": once context sits above this and the session keeps going, a
// proactive /compact reliably beats the cost of carrying it. ~160K is where a classic
// 200K-window session auto-compacts — we reuse it as a model-agnostic "this is large
// enough to compact" line and stay conservative by only ever billing tokens ABOVE it.
const OVERDUE_TOKENS = 160_000;
// A compaction only pays off with real runway left — a brief spike at a segment's tail
// isn't worth it. Require a sustained run before calling an episode "overdue".
const MIN_OVERDUE_TURNS = 6;

// Clear detector (heuristic): a task switch only stranded avoidable carry if there was
// meaningful context to shed AND the file working set genuinely rotated.
const STALE_FLOOR_TOKENS = 40_000; // below this, carrying it forward is cheap noise
const WS_WINDOW = 4; // turns each side of a candidate task-switch boundary
const MIN_FILES_EACH_SIDE = 2; // both sides must touch real, distinct files
const STALE_ATTRIB_TURNS = 12; // cap how far past a switch we attribute stale carry

const RESET_COMMANDS = new Set(['compact', 'clear']);
const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Total context tokens billed to a turn (everything on the input side — what a reset
 *  would shed). Output is what you generate, not what you carry. */
function contextTokens(t: AssistantTurn): number {
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
  /** Carry actually paid on tokens above the line during the episode (conservative —
   *  values the compaction as merely bringing context back to the line, not below it). */
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

/** Maximal runs of consecutive overdue turns within one segment that cleared the
 *  sustained-runway bar. `offset` is the segment's first turn's session-wide ordinal. */
function overdueRuns(seg: AssistantTurn[], offset: number): Omit<OverdueCompactEpisode, 'project' | 'sessionId'>[] {
  const out: Omit<OverdueCompactEpisode, 'project' | 'sessionId'>[] = [];
  let i = 0;
  while (i < seg.length) {
    if (contextTokens(seg[i]!) <= OVERDUE_TOKENS) {
      i += 1;
      continue;
    }
    let j = i;
    let peak = 0;
    let avoid = 0;
    while (j < seg.length && contextTokens(seg[j]!) > OVERDUE_TOKENS) {
      const ctx = contextTokens(seg[j]!);
      peak = Math.max(peak, ctx);
      // Carry attributable to the tokens above the line (the part a compaction sheds).
      avoid += turnCarryUsd(seg[j]!.model, seg[j]!.usage) * ((ctx - OVERDUE_TOKENS) / ctx);
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

/** Distinct file paths touched (Read/Edit/Write) over a slice of turns. */
function filesTouched(seg: AssistantTurn[], from: number, to: number): Set<string> {
  const s = new Set<string>();
  for (let k = Math.max(0, from); k < Math.min(seg.length, to); k += 1) {
    for (const op of seg[k]!.fileOps ?? []) {
      if (READ_TOOLS.has(op.tool) || WRITE_TOOLS.has(op.tool)) s.add(op.path);
    }
  }
  return s;
}

/** Likely "new idea, didn't /clear" boundaries in one segment: the file working set
 *  fully rotates (zero overlap, real files each side) while context was non-trivial. */
function staleSwitches(seg: AssistantTurn[], offset: number): Omit<StaleCarrySwitch, 'project' | 'sessionId'>[] {
  const out: Omit<StaleCarrySwitch, 'project' | 'sessionId'>[] = [];
  let k = WS_WINDOW;
  while (k < seg.length - WS_WINDOW) {
    const prev = filesTouched(seg, k - WS_WINDOW, k);
    const next = filesTouched(seg, k, k + WS_WINDOW);
    const rotated =
      prev.size >= MIN_FILES_EACH_SIDE &&
      next.size >= MIN_FILES_EACH_SIDE &&
      ![...next].some((p) => prev.has(p)); // zero overlap
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

    let offset = 0;
    for (const seg of segments(session)) {
      for (const e of overdueRuns(seg, offset)) {
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
