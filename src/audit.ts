// Ties the analyses together into one audit result + its privacy-safe aggregate.

import { computeAlwaysOn, type AlwaysOnTax } from './alwaysOn.js';
import { attributeSpend, type SpendBreakdown } from './attribute.js';
import { buildAggregateRecord, type AggregateRecord } from './aggregate.js';
import { computeFluency, type FluencySignals } from './fluency.js';
import { buildRecommendations, type Recommendation } from './recommend.js';
import type { Session } from './model.js';

export interface AuditResult {
  spend: SpendBreakdown;
  fluency: FluencySignals;
  alwaysOn: AlwaysOnTax;
  /** Ranked, file-anchored next actions (the config-knob bridge). Local-only — paths
   *  here never enter the aggregate. */
  recommendations: Recommendation[];
  aggregate: AggregateRecord;
  sessionCount: number;
}

export function runAudit(sessions: Session[], generatedAt: string): AuditResult {
  const spend = attributeSpend(sessions);
  const fluency = computeFluency(sessions);
  const alwaysOn = computeAlwaysOn(sessions);
  const recommendations = buildRecommendations(spend, alwaysOn, sessions);
  const aggregate = buildAggregateRecord(spend, fluency, alwaysOn, generatedAt);
  return { spend, fluency, alwaysOn, recommendations, aggregate, sessionCount: sessions.length };
}
