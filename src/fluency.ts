// Fluency signals — the habits behind the bill (plan-mode use, session efficiency,
// subagent leverage, context discipline). Each cost finding should ladder up to one
// of these.
//
// These RAW SIGNALS are the user's own observable facts — we show them locally and
// upload them (de-identified). The CALIBRATED interpretation — how they combine, the
// band thresholds, what counts as Elite — deliberately does NOT live here: it's the
// gated moat, computed server-side on `--open` (so it can't be read out of this
// bundle and gamed, and we can recalibrate without a CLI release). Locally we show
// only a COARSE, intentionally-crude self-band (`localBand`) and point the user at
// `--open` for the real one.

import type { Session, TurnUsage } from './model.js';
import { isPremiumModel, turnCostUsd } from './pricing.js';

export type FluencyBand = 'Developing' | 'Strong' | 'Elite';

export interface FluencySignals {
  sessions: number;
  /** Share of SUBSTANTIVE sessions that used plan mode. Trivial 1–2-turn sessions
   *  are excluded from both sides of the ratio so plan-ceremony on throwaway work
   *  can't inflate it (anti-gaming). */
  planModeRate: number;
  medianTurnsPerTask: number;
  p90TurnsPerTask: number;
  /** Share of assistant turns on premium models. A right-sizing LEVER shown to the
   *  user — deliberately NOT scored: low premium share isn't "good" (right-sizing is
   *  matching tier to task, which needs the judge), so scoring it would be perverse. */
  premiumTurnShare: number;
  /** Distinct models used across the corpus. Informational only — not scored. */
  modelDiversity: number;
  /** Share of SPEND delegated to subagents (sidechains) — a leverage signal.
   *  Cost-weighted, not session-count: one deep-research run can be 8% of the bill
   *  while touching few sessions, so counting sessions badly understates it. */
  subagentUsageRate: number;
  /** Share of the bill spent CARRYING context (re-reading the transcript each turn)
   *  vs producing output. An HONEST fact, not a fabricated "waste" figure — carrying
   *  is ~80% of a typical agentic bill and most of it is legitimate. The avoidable
   *  lever is `redundantReadRate`, not this. */
  carryShare: number;
  /** Absolute carry cost over the window (USD) — the honest "$/mo carrying context"
   *  headline. */
  carryUsd: number;
  /** Share of file READS that re-read a path ALREADY in context (no reset since) —
   *  re-injecting the same content. The ungameable bloat lever: you can't pad your
   *  way out, only stop re-reading what you already have. Lower is better. */
  redundantReadRate: number;
  /** Crude, ADVISORY local heuristic (0–100) — NOT the calibrated score. Kept so the
   *  uploaded aggregate has a stable shape; the server recomputes authoritatively
   *  from the raw signals and ignores this. Never shown as a precise number. */
  score: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const PLAN_MODE_VALUES = new Set(['plan', 'plan-mode', 'planning']);

/** USD this turn paid to CARRY context — everything billed except generated output.
 *  Carrying the transcript (re-read every turn) dominates an agentic bill; we report
 *  it as an honest share, never as a fabricated "waste" number. */
export function turnCarryUsd(model: string | null, u: TurnUsage): number {
  return turnCostUsd(model, { ...u, output: 0 }).usd;
}

// A Read re-injects a file's content into context; Edit/Write also put it there. A Read
// of a path already in context (with no reset since) re-injects the same bytes — that's
// the redundant-read signal, the ungameable bloat lever (only fix: stop re-reading).
const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// A reset (/compact, /clear) sheds carried content, so re-reading AFTER one is a
// legitimate refresh, not redundancy — clear the seen-set on these.
const RESET_COMMANDS = new Set(['compact', 'clear']);

export interface Redundancy {
  reads: number; // total file Reads on the own chain
  redundantReads: number; // Reads of a path already in context (no reset since)
  readAfterEdit: number; // Reads of a path we just wrote — the cleanest waste
}

/** Redundant-read detection for a session's own chain. Walks file ops in order,
 *  tracking which paths are already carried; a Read of an already-seen path re-injects
 *  its content. Resets on /compact or /clear — after a reset the content is gone, so
 *  re-reading is legitimate (this ties the signal to reset discipline). */
export function sessionRedundancy(session: Session): Redundancy {
  const seen = new Set<string>();
  const wroteLast = new Set<string>();
  let reads = 0;
  let redundantReads = 0;
  let readAfterEdit = 0;
  for (const span of session.spans) {
    if (span.isSidechain) continue;
    if (span.command && RESET_COMMANDS.has(span.command)) {
      seen.clear();
      wroteLast.clear();
    }
    for (const t of span.turns) {
      for (const op of t.fileOps ?? []) {
        if (READ_TOOLS.has(op.tool)) {
          reads += 1;
          if (seen.has(op.path)) {
            redundantReads += 1;
            if (wroteLast.has(op.path)) readAfterEdit += 1;
          }
          seen.add(op.path);
          wroteLast.delete(op.path); // a fresh read supersedes our last write
        } else if (WRITE_TOOLS.has(op.tool)) {
          seen.add(op.path);
          wroteLast.add(op.path);
        }
      }
    }
  }
  return { reads, redundantReads, readAfterEdit };
}

/** Local-only: the files re-read most (basename only — never a full path, never
 *  uploaded). Drives the report's concrete "you re-read X ×N" story. */
export function topRedundantFiles(sessions: Session[], n = 3): { name: string; rereads: number }[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const seen = new Set<string>();
    for (const span of session.spans) {
      if (span.isSidechain) continue;
      if (span.command && RESET_COMMANDS.has(span.command)) seen.clear();
      for (const t of span.turns) {
        for (const op of t.fileOps ?? []) {
          if (READ_TOOLS.has(op.tool)) {
            if (seen.has(op.path)) counts.set(op.path, (counts.get(op.path) ?? 0) + 1);
            seen.add(op.path);
          } else if (WRITE_TOOLS.has(op.tool)) {
            seen.add(op.path);
          }
        }
      }
    }
  }
  return [...counts.entries()]
    .map(([path, rereads]) => ({ name: path.split('/').pop() || path, rereads }))
    .sort((a, b) => b.rereads - a.rereads)
    .slice(0, n);
}

// A session is "substantive" once its own (non-delegated) work crosses a few turns.
// Below this it's a throwaway — excluded from planModeRate so plan-ceremony on
// trivial sessions earns nothing.
const SUBSTANTIVE_MIN_TURNS = 3;

export function computeFluency(sessions: Session[]): FluencySignals {
  const turnsPerTask: number[] = [];
  const models = new Set<string>();
  let premiumTurns = 0;
  let totalTurns = 0;
  let planSessions = 0;
  let subagentCost = 0;
  let totalCost = 0;
  let carryUsd = 0;
  let reads = 0;
  let redundantReads = 0;

  let substantiveSessions = 0;
  for (const session of sessions) {
    const ownTurns = session.spans.reduce(
      (sum, s) => sum + (s.isSidechain ? 0 : s.turns.length),
      0,
    );
    const isSubstantive = ownTurns >= SUBSTANTIVE_MIN_TURNS;
    if (isSubstantive) {
      substantiveSessions += 1;
      if (session.modes.some((m) => PLAN_MODE_VALUES.has(m))) planSessions += 1;
    }
    for (const span of session.spans) {
      // Subagent (sidechain) turns are delegated work, not the operator's own
      // trajectory — they'd inflate turns/task and premium-share if mixed in. Keep
      // the trajectory-shape metrics to the main chain; track subagent cost apart.
      if (!span.isSidechain) turnsPerTask.push(span.turns.length);
      for (const t of span.turns) {
        const usd = turnCostUsd(t.model, t.usage).usd;
        totalCost += usd;
        carryUsd += turnCarryUsd(t.model, t.usage); // carry = the whole bill, incl. subagents
        if (t.model) models.add(t.model);
        if (span.isSidechain) {
          subagentCost += usd;
        } else {
          totalTurns += 1;
          if (isPremiumModel(t.model)) premiumTurns += 1;
        }
      }
    }
    // Redundant reads are an operator habit — own-chain only (see sessionRedundancy).
    const r = sessionRedundancy(session);
    reads += r.reads;
    redundantReads += r.redundantReads;
  }

  turnsPerTask.sort((a, b) => a - b);
  // Rate over substantive sessions only (see SUBSTANTIVE_MIN_TURNS): "when you do
  // real work, how often do you plan it" — not diluted or inflated by throwaways.
  const planModeRate = substantiveSessions ? planSessions / substantiveSessions : 0;
  const premiumTurnShare = totalTurns ? premiumTurns / totalTurns : 0;
  const modelDiversity = models.size;
  const subagentUsageRate = totalCost ? subagentCost / totalCost : 0;
  const carryShare = totalCost ? carryUsd / totalCost : 0;
  const redundantReadRate = reads ? redundantReads / reads : 0;
  const medianTurns = percentile(turnsPerTask, 50);
  const p90Turns = percentile(turnsPerTask, 90);

  const signals = {
    sessions: sessions.length,
    planModeRate,
    medianTurnsPerTask: medianTurns,
    p90TurnsPerTask: p90Turns,
    premiumTurnShare,
    modelDiversity,
    subagentUsageRate,
    carryShare,
    carryUsd,
    redundantReadRate,
  };
  return { ...signals, score: crudeLocalScore(signals) };
}

// CRUDE, intentionally-non-secret local heuristic: count how many signals sit in an
// obvious-good direction. This is NOT the calibrated formula (that's server-side and
// gated) — it exists only to drive the coarse local self-band and to fill the
// advisory `score` field in the uploaded aggregate. Kept deliberately dumb so it
// neither leaks the real recipe nor invites gaming.
type CrudeInputs = Pick<
  FluencySignals,
  'planModeRate' | 'p90TurnsPerTask' | 'redundantReadRate' | 'subagentUsageRate'
>;
function crudeLocalScore(f: CrudeInputs): number {
  const goodDirections = [
    f.planModeRate >= 0.2, // plans at least some real work
    f.p90TurnsPerTask <= 40, // hardest tasks don't sprawl into thrash
    f.redundantReadRate <= 0.3, // mostly not re-reading files already in context
    f.subagentUsageRate > 0, // gets some delegated leverage
  ];
  return Math.round((100 * goodDirections.filter(Boolean).length) / goodDirections.length);
}

// The 7 signals scoped to a SINGLE session — the labelable unit for calibration
// (`cc-audit label-fluency`). Per-engineer aggregates give one data point; per-
// session gives ~one-per-real-session, enough to fit weights. Plan/compact are
// binary at this granularity; turns/premium/diversity/subagent are per-session.
export interface SessionFluencySignals {
  planModeRate: number; // 0|1 — did THIS session use plan mode
  medianTurnsPerTask: number;
  p90TurnsPerTask: number;
  premiumTurnShare: number;
  modelDiversity: number;
  subagentUsageRate: number;
  redundantReadRate: number; // share of THIS session's file reads that re-read a carried path
}

/** Own (non-delegated) turn count — a session is "substantive" past the threshold. */
export function sessionOwnTurns(session: Session): number {
  return session.spans.reduce((sum, s) => sum + (s.isSidechain ? 0 : s.turns.length), 0);
}
export function isSubstantiveSession(session: Session): boolean {
  return sessionOwnTurns(session) >= SUBSTANTIVE_MIN_TURNS;
}

export function computeSessionFluencySignals(session: Session): SessionFluencySignals {
  const turnsPerTask: number[] = [];
  const models = new Set<string>();
  let premiumTurns = 0;
  let totalTurns = 0;
  let subagentCost = 0;
  let totalCost = 0;
  for (const span of session.spans) {
    if (!span.isSidechain) turnsPerTask.push(span.turns.length);
    for (const t of span.turns) {
      const usd = turnCostUsd(t.model, t.usage).usd;
      totalCost += usd;
      if (t.model) models.add(t.model);
      if (span.isSidechain) subagentCost += usd;
      else {
        totalTurns += 1;
        if (isPremiumModel(t.model)) premiumTurns += 1;
      }
    }
  }
  turnsPerTask.sort((a, b) => a - b);
  const r = sessionRedundancy(session);
  return {
    planModeRate: session.modes.some((m) => PLAN_MODE_VALUES.has(m)) ? 1 : 0,
    medianTurnsPerTask: percentile(turnsPerTask, 50),
    p90TurnsPerTask: percentile(turnsPerTask, 90),
    premiumTurnShare: totalTurns ? premiumTurns / totalTurns : 0,
    modelDiversity: models.size,
    subagentUsageRate: totalCost ? subagentCost / totalCost : 0,
    redundantReadRate: r.reads ? r.redundantReads / r.reads : 0,
  };
}

/**
 * Coarse local self-band for display. Deliberately rough — the authoritative,
 * cohort-relative band comes from the hosted `--open` upload. Labeled as such in
 * the report so we never imply this is the calibrated verdict.
 */
export function localBand(f: Pick<FluencySignals, 'score'>): FluencyBand {
  // Conservative on purpose: local Elite requires ALL crude good-directions (score
  // 100). Handing out "Elite" cheaply would undercut the credibility the tool is
  // meant to build — and the authoritative band is the server's job anyway.
  if (f.score >= 90) return 'Elite';
  if (f.score >= 50) return 'Strong';
  return 'Developing';
}
