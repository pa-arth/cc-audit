// Ties the analyses together into one audit result + its privacy-safe aggregate.

import { computeAlwaysOn, type AlwaysOnTax } from './alwaysOn.js';
import { attributeSpend, type SpendBreakdown } from './attribute.js';
import { buildAggregateRecord, type AggregateRecord } from './aggregate.js';
import { computeFluency, type FluencySignals } from './fluency.js';
import { buildRecommendations, type Recommendation } from './recommend.js';
import { anonymizeTopSessions, topSessions, type TopSession } from './topSessions.js';
import type { Session } from './model.js';

export interface AuditResult {
  spend: SpendBreakdown;
  fluency: FluencySignals;
  alwaysOn: AlwaysOnTax;
  /** Ranked, file-anchored next actions (the config-knob bridge). Local-only — paths
   *  here never enter the aggregate. */
  recommendations: Recommendation[];
  aggregate: AggregateRecord;
  /** N most expensive sessions with their structure. LOCAL-ONLY (raw gists/projects) —
   *  rendered in the TUI, never placed in the aggregate. */
  topSessions: TopSession[];
  sessionCount: number;
}

export function runAudit(
  sessions: Session[],
  generatedAt: string,
  opts: { shareSessions?: boolean } = {},
): AuditResult {
  const spend = attributeSpend(sessions);
  const fluency = computeFluency(sessions);
  const alwaysOn = computeAlwaysOn(sessions);
  const recommendations = buildRecommendations(spend, alwaysOn, sessions);
  const top = topSessions(sessions);
  // The leaderboard enters the UPLOADED aggregate ONLY on explicit opt-in, and even
  // then anonymized (no gist/project/raw $). Default: stays local in the TUI.
  const anonTop = opts.shareSessions ? anonymizeTopSessions(top, spend.totalUsd) : [];
  const aggregate = buildAggregateRecord(spend, fluency, alwaysOn, generatedAt, anonTop);
  return { spend, fluency, alwaysOn, recommendations, aggregate, topSessions: top, sessionCount: sessions.length };
}
