// Personal context-degradation KNEE — the context-size band where an engineer's own
// redundant re-reads + friction first jump ≥2× their low-context baseline. This is the
// per-user threshold the live-guardrail statusline ARMS against: nobody without local
// transcript access can produce it, and one session is too short/noisy to fit it, so we
// merge FIXED token bands across every session and re-run the onset rule on the much
// larger sample. Ported turn-for-turn from the backend (packages/engine fluency_signals_v1
// + engineer_context_knee_v1) so cc-audit and the backend agree on what counts as
// "elevated". Fully LOCAL and deterministic — no egress.
//
//   - redundant re-read: a Read of a path already resident in context (read earlier, with
//     NO intervening write to that path — a write makes the resident copy stale, so a
//     later read is legitimate). Direct evidence the carried context stopped being usable.
//   - friction: corrective struggle (self-corrections / retries after a failure) — reused
//     wholesale from friction.ts via sessionFrictionEvents (single source of truth).
// Each is stamped with the CONTEXT SIZE at the turn it happened and bucketed by fixed
// token bands so we can see whether re-reads/friction climb with context.

import type { Session } from './model.js';
import { contextTokens } from './contextHygiene.js';
import { sessionFrictionEvents } from './friction.js';

// Fixed bands (NOT per-session quantiles) keep buckets interpretable and mergeable across
// sessions — index i always means the same token range everywhere. Bands: [0,50k),
// [50k,100k), [100k,200k), [200k,∞). Ported from the backend's CONTEXT_BANDS.
const CONTEXT_BANDS = [50_000, 100_000, 200_000] as const;
// Min turns in a band before its rate means anything (guards tiny-sample noise).
const BAND_TURN_FLOOR = 3;
// Min elevated rate to call an onset when the baseline is ~0 (≥1 symptom / 3 turns). This
// is the SINGLE-SESSION noise guard: over a handful of turns a per-turn rate is only
// meaningful once it's this high.
const ONSET_RATE_FLOOR = 0.34;
// Fewer contributing sessions than this and the knee stays null — one or two sessions'
// buckets are still single-session noise, not a fitted knee.
const MIN_SESSIONS_WITH_SIGNAL = 2;
// The AGGREGATED noise guard. Merged across thousands of turns the per-turn symptom rate is
// naturally tiny (~0.02–0.04), so the absolute ONSET_RATE_FLOOR is the wrong tool — it's a
// small-sample guard. What we actually need is enough EVENTS behind the 2×-baseline climb
// for the ratio to be real, so the aggregated path swaps the rate floor for a raw symptom
// count: a fluke band with 3 turns / 1 symptom won't clear this; a genuine onset will.
const AGGREGATE_MIN_SYMPTOMS = 20;

const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export interface ContextBucket {
  /** Upper edge of the band in tokens; null = open-ended top band. */
  maxTokens: number | null;
  turns: number;
  redundantReReads: number;
  frictionEvents: number;
}

function emptyBuckets(): ContextBucket[] {
  return Array.from({ length: CONTEXT_BANDS.length + 1 }, (_, i) => ({
    maxTokens: i < CONTEXT_BANDS.length ? CONTEXT_BANDS[i]! : null,
    turns: 0,
    redundantReReads: 0,
    frictionEvents: 0,
  }));
}

function bandIndex(ctx: number): number {
  for (let i = 0; i < CONTEXT_BANDS.length; i++) if (ctx < CONTEXT_BANDS[i]!) return i;
  return CONTEXT_BANDS.length; // open top band
}

/** Sum fixed-band buckets across sessions (bands are a module constant, so index i always
 *  means the same token range). Shared by the per-session pass and the merged cross-session
 *  knee so "what counts as elevated" can't drift between them. */
export function mergeContextBuckets(bucketLists: ContextBucket[][]): ContextBucket[] {
  const merged = emptyBuckets();
  for (const buckets of bucketLists) {
    for (let i = 0; i < merged.length; i++) {
      const b = buckets[i];
      if (!b) continue;
      merged[i]!.turns += b.turns;
      merged[i]!.redundantReReads += b.redundantReReads;
      merged[i]!.frictionEvents += b.frictionEvents;
    }
  }
  return merged;
}

/** The onset rule: the first band above baseline where the per-turn (reread+friction) rate
 *  clears the noise guard AND 2× the low-context baseline, over a real number of turns.
 *  Returns the LOWER edge of that band (the knee), or null if none. Pure over bucket counts,
 *  so the same rule applies to one session's buckets or a merged cross-session total — only
 *  the noise guard differs by sample size:
 *    - `rateFloor` (default ONSET_RATE_FLOOR): the small-sample absolute rate floor — the
 *      single-session/in-session guard. Kept as the default so that call is byte-for-byte
 *      unchanged.
 *    - `minSymptoms` (default 0): a raw event-count floor behind the 2× climb — the guard the
 *      AGGREGATED path uses (where thousands of turns make the per-turn rate naturally tiny).
 *  The `2*baseline` relative test is always the actual detector; it protects against firing on
 *  a band below baseline even when rateFloor is 0. */
export function deriveContextKnee(
  buckets: ContextBucket[],
  opts: { rateFloor?: number; minSymptoms?: number } = {},
): number | null {
  const rateFloor = opts.rateFloor ?? ONSET_RATE_FLOOR;
  const minSymptoms = opts.minSymptoms ?? 0;
  const symptoms = (b: ContextBucket) => b.redundantReReads + b.frictionEvents;
  const rate = (b: ContextBucket) => (b.turns > 0 ? symptoms(b) / b.turns : 0);
  const baseline = rate(buckets[0]!);
  if (buckets[0]!.turns < BAND_TURN_FLOOR) return null;
  for (let i = 1; i < buckets.length; i++) {
    const b = buckets[i]!;
    if (
      b.turns >= BAND_TURN_FLOOR &&
      rate(b) >= rateFloor &&
      rate(b) >= 2 * baseline &&
      symptoms(b) >= minSymptoms
    ) {
      return CONTEXT_BANDS[i - 1]!; // lower edge of the elevated band
    }
  }
  return null;
}

/** Bucket one session's own-chain redundant re-reads + friction by the context size at the
 *  turn they occurred. Returns null when the session carries no per-turn token telemetry or
 *  is too short to bucket (< 4 telemetry turns) — either way it can't contribute knee signal. */
export function sessionContextBuckets(session: Session): ContextBucket[] | null {
  const buckets = emptyBuckets();
  let telemetryTurns = 0;

  // Every own-chain turn falls in the band of its context size (the denominator).
  for (const span of session.spans) {
    if (span.isSidechain) continue;
    for (const t of span.turns) {
      const ctx = contextTokens(t);
      if (ctx <= 0) continue;
      buckets[bandIndex(ctx)]!.turns++;
      telemetryTurns++;
    }
  }
  if (telemetryTurns < 4) return null;

  // Redundant re-read: a read of a path already resident, no intervening write to it (a
  // write makes the resident copy stale, so clear it on write). Walk own-chain file ops in
  // order, stamping each redundant read with the CURRENT turn's context band.
  const resident = new Set<string>();
  for (const span of session.spans) {
    if (span.isSidechain) continue;
    for (const t of span.turns) {
      const ctx = contextTokens(t);
      for (const op of t.fileOps ?? []) {
        if (WRITE_TOOLS.has(op.tool)) {
          resident.delete(op.path);
        } else if (READ_TOOLS.has(op.tool)) {
          if (resident.has(op.path)) {
            if (ctx > 0) buckets[bandIndex(ctx)]!.redundantReReads++;
          } else {
            resident.add(op.path);
          }
        }
      }
    }
  }

  // Friction (from friction.ts) stamped by the context size at the friction turn.
  for (const t of sessionFrictionEvents(session)) {
    const ctx = contextTokens(t);
    if (ctx > 0) buckets[bandIndex(ctx)]!.frictionEvents++;
  }

  return buckets;
}

export interface ContextKnee {
  /** Sessions scanned in the window (the cache basis). */
  windowSessions: number;
  /** Sessions that carried per-turn token telemetry (contributed buckets). */
  sessionsWithSignal: number;
  /** Merged fixed-band buckets across all contributing sessions. */
  buckets: ContextBucket[];
  /** The armed threshold in tokens — context past this is the personal degradation zone.
   *  null when < MIN_SESSIONS_WITH_SIGNAL contributed or the onset rule found no knee. */
  onsetTokens: number | null;
}

/** Merge every session's fixed-band buckets and re-run the onset rule on the merged totals.
 *  Requires ≥ MIN_SESSIONS_WITH_SIGNAL sessions carrying signal before trusting the knee —
 *  one session is single-session noise. This is the number the statusline arms against. */
export function computeContextKnee(sessions: Session[]): ContextKnee {
  const bucketLists: ContextBucket[][] = [];
  for (const s of sessions) {
    const b = sessionContextBuckets(s);
    if (b) bucketLists.push(b);
  }
  const buckets = bucketLists.length > 0 ? mergeContextBuckets(bucketLists) : emptyBuckets();
  // Aggregated path: swap the small-sample rate floor for a raw symptom-count floor (see
  // AGGREGATE_MIN_SYMPTOMS) — the 2×-baseline climb is the detector, we just need enough
  // events behind it for the ratio to be real.
  const onsetTokens =
    bucketLists.length >= MIN_SESSIONS_WITH_SIGNAL
      ? deriveContextKnee(buckets, { rateFloor: 0, minSymptoms: AGGREGATE_MIN_SYMPTOMS })
      : null;
  return {
    windowSessions: sessions.length,
    sessionsWithSignal: bucketLists.length,
    buckets,
    onsetTokens,
  };
}
