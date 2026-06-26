// The judge ride-along for context hygiene. The deterministic detector flags WHERE
// context ran overdue and a conservative WHAT-IT-COST, but it can't tell stale
// finished-task context (truly reclaimable) from a genuinely-needed big working set.
// That judgment is what the hosted model is for — so we bundle these items into the
// SAME --judge payload (no extra round-trip) and get back, per episode, the share of
// the flagged carry that was actually stale.
//
// PRIVACY: identical surface to the right-sizing footprint — only the user's own task
// GISTS (already 700-char truncated, scrubbed of harness tags) + structural counts
// leave the machine. The located episode's project/sessionId/turn stay LOCAL.

import type { ContextHygiene } from './contextHygiene.js';
import { isJudgeableTask } from './footprint.js';
import type { Session } from './model.js';

/** WIRE shape — what actually leaves the machine for an episode. */
export interface HygieneJudgeItem {
  kind: 'overdue' | 'switch';
  peakTokens: number;
  /** Overdue-run length (overdue) or attribution span (switch) — structural, not identifying. */
  turns: number;
  /** Ordered, de-duplicated task gists inside the episode's window. The sequence is the
   *  signal: one task across the whole window ⇒ context mostly relevant; many distinct
   *  tasks with no reset ⇒ lots of stale carry. */
  gists: string[];
}

/** Local pairing: the wire item + the deterministic $ it's refining (never sent). */
export interface HygieneFootprint {
  item: HygieneJudgeItem;
  avoidableUsd: number;
}

/** What the judge returns per item (optional — old backends omit it; we fall back). */
export interface HygieneVerdict {
  /** 0–1: fraction of the flagged carry that was genuinely stale (reclaimable). */
  staleShare: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

const MAX_OVERDUE = 25;
const MAX_SWITCH = 15;
const MAX_GISTS = 8;
const SWITCH_WINDOW_SPANS = 3; // spans each side of a switch to characterize the boundary

/** Main-chain spans of a session paired with the 1-based turn ordinal range they cover
 *  (matching the ordinals contextHygiene locates episodes by). */
function spanRanges(session: Session): { gist: string; start: number; end: number }[] {
  const out: { gist: string; start: number; end: number }[] = [];
  let n = 0;
  for (const span of session.spans) {
    if (span.isSidechain || span.turns.length === 0) continue;
    const start = n + 1;
    n += span.turns.length;
    out.push({ gist: span.firstUserText, start, end: n });
  }
  return out;
}

/** Distinct, judgeable gists from spans whose turn range intersects [from, to). */
function gistsInRange(ranges: { gist: string; start: number; end: number }[], from: number, to: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of ranges) {
    if (r.end < from || r.start >= to) continue;
    const g = r.gist.trim();
    if (!g || !isJudgeableTask(g) || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
    if (out.length >= MAX_GISTS) break;
  }
  return out;
}

/** Build the privacy-safe judge items for the biggest episodes. Episodes with no
 *  judgeable gist (e.g. all-continuation windows) are dropped from the SENT set — they
 *  fall into the extrapolated remainder in refineAvoidableCarry. */
export function buildHygieneFootprints(hygiene: ContextHygiene, sessions: Session[]): HygieneFootprint[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const ranges = new Map<string, ReturnType<typeof spanRanges>>();
  const rangesFor = (id: string) => {
    let r = ranges.get(id);
    if (!r) {
      const s = byId.get(id);
      r = s ? spanRanges(s) : [];
      ranges.set(id, r);
    }
    return r;
  };

  const out: HygieneFootprint[] = [];
  for (const e of hygiene.overdueEpisodes.slice(0, MAX_OVERDUE)) {
    const gists = gistsInRange(rangesFor(e.sessionId), e.atTurn, e.atTurn + e.overdueTurns);
    if (gists.length === 0) continue;
    out.push({ item: { kind: 'overdue', peakTokens: e.peakTokens, turns: e.overdueTurns, gists }, avoidableUsd: e.avoidableUsd });
  }
  for (const e of hygiene.staleCarrySwitches.slice(0, MAX_SWITCH)) {
    const r = rangesFor(e.sessionId);
    // Characterize the boundary: a few spans before and after the switch turn.
    const idx = r.findIndex((x) => x.start <= e.atTurn && x.end >= e.atTurn);
    const lo = idx < 0 ? r : r.slice(Math.max(0, idx - SWITCH_WINDOW_SPANS), idx + SWITCH_WINDOW_SPANS);
    const gists = gistsInRange(lo, 0, Infinity);
    if (gists.length < 2) continue; // need both sides to judge a real boundary
    out.push({ item: { kind: 'switch', peakTokens: e.staleTokens, turns: 0, gists }, avoidableUsd: e.avoidableUsd });
  }
  return out;
}

export interface RefinedHygiene {
  /** Judge-refined avoidable carry over the window (stale share applied). */
  refinedUsd: number;
  /** Deterministic avoidable carry (the fallback headline). */
  deterministicUsd: number;
  /** Avg stale share the judge assigned across the sent sample (extrapolated to the rest). */
  avgStaleShare: number;
  /** How many episodes the judge actually scored. */
  judgedCount: number;
}

/** The refinement shape uploaded with `--open` (per-month $ + share + count, consistent
 *  with the rest of the aggregate). A sibling of the right-sizing summary — never gists. */
export interface HygieneRefinementUpload {
  refinedUsdPerMonth: number;
  deterministicUsdPerMonth: number;
  avgStaleShare: number;
  judgedCount: number;
}

export function toRefinementUpload(r: RefinedHygiene, windowDays: number): HygieneRefinementUpload {
  const perMo = (x: number) => (x / windowDays) * 30.44;
  return {
    refinedUsdPerMonth: perMo(r.refinedUsd),
    deterministicUsdPerMonth: perMo(r.deterministicUsd),
    avgStaleShare: r.avgStaleShare,
    judgedCount: r.judgedCount,
  };
}

/** Fold per-episode staleShare verdicts into a refined total. Sent episodes use their own
 *  verdict; the unsent remainder gets the sample's average share (honest extrapolation,
 *  same pattern as the right-sizing over-modeled-share). Verdicts are positional. */
export function refineAvoidableCarry(
  hygiene: ContextHygiene,
  sent: HygieneFootprint[],
  verdicts: HygieneVerdict[],
): RefinedHygiene {
  const deterministicUsd = hygiene.avoidableTotalUsd;
  let judgedAvoidable = 0;
  let judgedRefined = 0;
  let judgedCount = 0;
  for (let i = 0; i < sent.length; i += 1) {
    const v = verdicts[i];
    if (!v) continue;
    const share = Math.max(0, Math.min(1, v.staleShare));
    judgedAvoidable += sent[i]!.avoidableUsd;
    judgedRefined += sent[i]!.avoidableUsd * share;
    judgedCount += 1;
  }
  const avgStaleShare = judgedAvoidable > 0 ? judgedRefined / judgedAvoidable : 1;
  const unsent = Math.max(0, deterministicUsd - judgedAvoidable);
  const refinedUsd = judgedRefined + unsent * avgStaleShare;
  return { refinedUsd, deterministicUsd, avgStaleShare, judgedCount };
}
