// Fluency signals — the moat layer. Cost is the symptom; these measure the
// habits behind it (plan-mode use, model policy, session efficiency, subagent
// use, context discipline). Each cost finding should ladder up to one of these.
// The composite score is a transparent v0 heuristic, NOT a validated metric.

import type { Session } from './model.js';
import { isPremiumModel, turnCostUsd } from './pricing.js';

export interface FluencySignals {
  sessions: number;
  /** Share of sessions that used plan mode (higher = better). */
  planModeRate: number;
  medianTurnsPerTask: number;
  p90TurnsPerTask: number;
  /** Share of assistant turns on premium models (higher = more right-sizing headroom). */
  premiumTurnShare: number;
  /** Distinct models used across the corpus (>1 ⇒ some deliberate policy). */
  modelDiversity: number;
  /** Share of SPEND delegated to subagents (sidechains) — a leverage signal.
   *  Cost-weighted, not session-count: one deep-research run can be 8% of the bill
   *  while touching few sessions, so counting sessions badly understates it. */
  subagentUsageRate: number;
  /** Share of sessions that needed /compact (proxy for letting context balloon). */
  contextBloatRate: number;
  /** 0–100 composite (transparent heuristic v0). */
  score: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const PLAN_MODE_VALUES = new Set(['plan', 'plan-mode', 'planning']);

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

  for (const session of sessions) {
    if (session.modes.some((m) => PLAN_MODE_VALUES.has(m))) planSessions += 1;
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
  const planModeRate = planSessions / n;
  const premiumTurnShare = totalTurns ? premiumTurns / totalTurns : 0;
  const modelDiversity = models.size;
  const subagentUsageRate = totalCost ? subagentCost / totalCost : 0;
  const contextBloatRate = compactSessions / n;
  const medianTurns = percentile(turnsPerTask, 50);

  // Transparent v0 composite (each component 0–1, weighted, ×100).
  const efficiency = Math.max(0, 1 - medianTurns / 25); // ~25+ turns/task = poor
  const rightSizingHeadroom = 1 - premiumTurnShare; // all-premium = no policy
  const policy = modelDiversity > 1 ? 1 : 0;
  const score = Math.round(
    100 *
      (0.25 * planModeRate +
        0.2 * subagentUsageRate +
        0.25 * rightSizingHeadroom +
        0.2 * efficiency +
        0.1 * policy),
  );

  return {
    sessions: sessions.length,
    planModeRate,
    medianTurnsPerTask: medianTurns,
    p90TurnsPerTask: percentile(turnsPerTask, 90),
    premiumTurnShare,
    modelDiversity,
    subagentUsageRate,
    contextBloatRate,
    score,
  };
}
