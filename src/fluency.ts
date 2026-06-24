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

import type { Session } from './model.js';
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
  /** Share of sessions that needed /compact (proxy for letting context balloon). */
  contextBloatRate: number;
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

// A session is "substantive" once its own (non-delegated) work crosses a few turns.
// Below this it's a throwaway — excluded from planModeRate so plan-ceremony on
// trivial sessions earns nothing.
const SUBSTANTIVE_MIN_TURNS = 3;

export function computeFluency(sessions: Session[]): FluencySignals {
  const n = sessions.length || 1;
  const turnsPerTask: number[] = [];
  const models = new Set<string>();
  let premiumTurns = 0;
  let totalTurns = 0;
  let planSessions = 0;
  let compactSessions = 0;
  let subagentCost = 0;
  let totalCost = 0;

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
    const usedCompact = session.spans.some((s) => s.command === 'compact');
    for (const span of session.spans) {
      // Subagent (sidechain) turns are delegated work, not the operator's own
      // trajectory — they'd inflate turns/task and premium-share if mixed in. Keep
      // the trajectory-shape metrics to the main chain; track subagent cost apart.
      if (!span.isSidechain) turnsPerTask.push(span.turns.length);
      for (const t of span.turns) {
        const usd = turnCostUsd(t.model, t.usage).usd;
        totalCost += usd;
        if (t.model) models.add(t.model);
        if (span.isSidechain) {
          subagentCost += usd;
        } else {
          totalTurns += 1;
          if (isPremiumModel(t.model)) premiumTurns += 1;
        }
      }
    }
    if (usedCompact) compactSessions += 1;
  }

  turnsPerTask.sort((a, b) => a - b);
  // Rate over substantive sessions only (see SUBSTANTIVE_MIN_TURNS): "when you do
  // real work, how often do you plan it" — not diluted or inflated by throwaways.
  const planModeRate = substantiveSessions ? planSessions / substantiveSessions : 0;
  const premiumTurnShare = totalTurns ? premiumTurns / totalTurns : 0;
  const modelDiversity = models.size;
  const subagentUsageRate = totalCost ? subagentCost / totalCost : 0;
  const contextBloatRate = compactSessions / n;
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
    contextBloatRate,
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
  'planModeRate' | 'p90TurnsPerTask' | 'contextBloatRate' | 'subagentUsageRate'
>;
function crudeLocalScore(f: CrudeInputs): number {
  const goodDirections = [
    f.planModeRate >= 0.2, // plans at least some real work
    f.p90TurnsPerTask <= 40, // hardest tasks don't sprawl into thrash
    f.contextBloatRate <= 0.2, // not leaning on /compact
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
  contextBloatRate: number; // 0|1 — did THIS session use /compact
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
  let usedCompact = false;
  for (const span of session.spans) {
    if (span.command === 'compact') usedCompact = true;
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
  return {
    planModeRate: session.modes.some((m) => PLAN_MODE_VALUES.has(m)) ? 1 : 0,
    medianTurnsPerTask: percentile(turnsPerTask, 50),
    p90TurnsPerTask: percentile(turnsPerTask, 90),
    premiumTurnShare: totalTurns ? premiumTurns / totalTurns : 0,
    modelDiversity: models.size,
    subagentUsageRate: totalCost ? subagentCost / totalCost : 0,
    contextBloatRate: usedCompact ? 1 : 0,
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
