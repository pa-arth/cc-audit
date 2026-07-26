// Temporal stratification — the SECOND axis (tokens are the first): where does the
// wall-clock go? Per-turn timestamps + tool_result timestamps (back-referenced via
// tool_use_id, captured by the adapter) let us split each turn's elapsed time into:
//   - think:  gap from the previous event's end to this turn's logged time (queue +
//             reasoning + generation — NOT separable from timestamps alone)
//   - exec:   the turn's tool calls running (its ts → its tool_result ts). Includes any
//             human approval wait, which we can't subtract (no approval-decision event).
//   - userWait: human time between one span's end and the next prompt.
// Plus a work-hour histogram (local tz — it's the user's own pattern). All gaps clamp
// to ≥0 (clock skew / out-of-order rows must never produce negative durations).
//
// LOCAL-FIRST: hourHistogram + stratified ms are de-identified aggregates (uploadable);
// sessionDurations carries project labels and stays local.

import type { Session } from './model.js';
import { turnCostUsd } from './pricing.js';

export interface HourBucket {
  hour: number; // local hour 0-23
  turns: number;
  usd: number;
}

export interface StratifiedTime {
  thinkMs: number;
  execMs: number;
  userWaitMs: number;
  /** Turns with a usable timestamp (contributed to the split). */
  attributedTurns: number;
  /** Turns missing a timestamp (data-quality signal). */
  unattributedTurns: number;
}

/** LOCAL-ONLY (carries project labels). */
export interface SessionDuration {
  sessionId: string;
  project: string;
  durationMs: number;
  turns: number;
}

export interface TemporalProfile {
  hourHistogram: HourBucket[]; // length 24
  stratified: StratifiedTime;
  sessionDurations: SessionDuration[]; // LOCAL-ONLY
  totalActiveMs: number;
  medianSessionMs: number;
}

/** One trailing-7-day spend bucket (calendar-agnostic — anchored at the run moment, not
 *  ISO weeks, because the audit window is fractional). LOCAL-ONLY via AuditResult. */
export interface WeeklySpendBucket {
  startMs: number; // exclusive
  endMs: number; // inclusive
  usd: number;
  /** False for the newest (week in progress) and oldest (clipped by the window) buckets —
   *  the run-rate range should read over complete weeks only. */
  complete: boolean;
}

const WEEK_MS = 7 * 86_400_000;
// Backstop against pathological mtimes; sparkline max-pools to 24 anyway.
const MAX_WEEK_BUCKETS = 26;

/** Spend per trailing 7-day bucket, oldest→newest. Bucket k (from newest) covers
 *  (now-(k+1)·7d, now-k·7d]. Timestamps outside the range clamp to the edge buckets
 *  (clock skew must never drop spend). */
export function computeWeeklySpend(sessions: Session[], nowMs: number): WeeklySpendBucket[] {
  let oldest = Infinity;
  for (const s of sessions) {
    for (const span of s.spans) {
      for (const t of span.turns) {
        const ts = t.ts ?? span.userTs ?? s.mtime;
        if (ts) oldest = Math.min(oldest, ts);
      }
    }
  }
  if (oldest === Infinity || oldest >= nowMs) return [];

  const count = Math.min(MAX_WEEK_BUCKETS, Math.ceil((nowMs - oldest) / WEEK_MS));
  const buckets: WeeklySpendBucket[] = Array.from({ length: count }, (_, i) => {
    const fromNewest = count - 1 - i;
    return {
      startMs: nowMs - (fromNewest + 1) * WEEK_MS,
      endMs: nowMs - fromNewest * WEEK_MS,
      usd: 0,
      // Newest bucket is a week in progress; oldest is clipped by the window edge.
      complete: fromNewest !== 0 && i !== 0,
    };
  });

  for (const s of sessions) {
    for (const span of s.spans) {
      for (const t of span.turns) {
        const ts = t.ts ?? span.userTs ?? s.mtime;
        if (!ts) continue;
        const fromNewest = Math.min(count - 1, Math.max(0, Math.ceil((nowMs - ts) / WEEK_MS) - 1));
        // `ts` is required, not optional: without it a model inside a dated
        // introductory window prices at its steady-state rate here while the SPEND
        // headline prices it at the intro rate — putting two figures 1.5x apart in
        // the SAME card off the same turns (Sonnet 5: $2/$10 vs $3/$15).
        buckets[count - 1 - fromNewest]!.usd += turnCostUsd(t.model, t.usage, ts).usd;
      }
    }
  }
  return buckets;
}

// Gaps longer than this are "walked away" / resumed-next-day idle time, NOT active
// think/exec/wait — counting them makes the split read as hundreds of hours of "wait"
// dominated by overnight gaps. Cap each gap so the stratification reflects ACTIVE work.
const IDLE_CAP_MS = 30 * 60_000; // 30 min

const clampGap = (a: number | null, b: number | null): number =>
  a != null && b != null ? Math.min(IDLE_CAP_MS, Math.max(0, a - b)) : 0;

/** Work end of a turn: when its tools finished, else when the turn itself was logged. */
const turnEnd = (ts: number | null, toolResultTs: number | null): number | null => toolResultTs ?? ts;

export function computeTemporal(sessions: Session[]): TemporalProfile {
  const hourHistogram: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, turns: 0, usd: 0 }));
  const stratified: StratifiedTime = {
    thinkMs: 0,
    execMs: 0,
    userWaitMs: 0,
    attributedTurns: 0,
    unattributedTurns: 0,
  };
  const sessionDurations: SessionDuration[] = [];

  for (const session of sessions) {
    let minStart = Infinity;
    let maxEnd = -Infinity;
    let sessionTurns = 0;
    // End (epoch ms) of the previous own-chain span's last turn — anchors userWait.
    let prevSpanEnd: number | null = null;

    for (const span of session.spans) {
      // Stratify per span only — never across the agent/operator boundary, or exec and
      // think bleed between a subagent and the main chain. userWait is main-chain only.
      const isOwn = !span.isSidechain;
      // Anchor the first think gap at the prompt; if absent, at the first turn's ts.
      let prevEnd: number | null = span.userTs;
      if (isOwn && prevSpanEnd != null && span.userTs != null) {
        stratified.userWaitMs += clampGap(span.userTs, prevSpanEnd);
      }
      if (span.userTs != null) {
        minStart = Math.min(minStart, span.userTs);
      }

      for (const t of span.turns) {
        sessionTurns += 1;
        if (t.ts == null) {
          stratified.unattributedTurns += 1;
        } else {
          stratified.attributedTurns += 1;
          stratified.thinkMs += clampGap(t.ts, prevEnd);
          if (t.toolResultTs != null) stratified.execMs += clampGap(t.toolResultTs, t.ts);
          const hour = new Date(t.ts).getHours();
          const bucket = hourHistogram[hour]!;
          bucket.turns += 1;
          bucket.usd += turnCostUsd(t.model, t.usage, t.ts).usd;
          minStart = Math.min(minStart, t.ts);
        }
        const end = turnEnd(t.ts, t.toolResultTs);
        if (end != null) {
          prevEnd = end;
          maxEnd = Math.max(maxEnd, end);
        }
      }
      if (isOwn) prevSpanEnd = prevEnd;
    }

    if (minStart !== Infinity && maxEnd !== -Infinity && maxEnd >= minStart) {
      sessionDurations.push({
        sessionId: session.sessionId,
        project: session.project,
        durationMs: maxEnd - minStart,
        turns: sessionTurns,
      });
    }
  }

  const durs = sessionDurations.map((s) => s.durationMs).sort((a, b) => a - b);
  const totalActiveMs = durs.reduce((n, d) => n + d, 0);
  const medianSessionMs = durs.length ? durs[Math.floor(durs.length / 2)]! : 0;

  return { hourHistogram, stratified, sessionDurations, totalActiveMs, medianSessionMs };
}
