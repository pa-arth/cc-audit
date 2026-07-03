// Ties the analyses together into one audit result + its privacy-safe aggregate.

import { computeAlwaysOn, type AlwaysOnTax } from './alwaysOn.js';
import { attributeSpend, type SpendBreakdown } from './attribute.js';
import { buildAggregateRecord, type AggregateRecord } from './aggregate.js';
import { computeContextHygiene, type ContextHygiene } from './contextHygiene.js';
import { computeFluency, topRedundantFiles, type FluencySignals } from './fluency.js';
import { buildRecommendations, type Recommendation } from './recommend.js';
import { buildRoiLedger, type RoiLedger } from './roiLedger.js';
import { computeTemporal, type TemporalProfile } from './temporal.js';
import { computeFriction, type FrictionTaxonomy } from './friction.js';
import { anonymizeTopSessions, topSessions, type TopSession } from './topSessions.js';
import { computeContextKnee, type ContextKnee } from './contextKnee.js';
import type { Session } from './model.js';

export interface AuditResult {
  spend: SpendBreakdown;
  fluency: FluencySignals;
  /** Avoidable carry — missed /compact and /clear, located + costed. LOCAL detail
   *  (per-session episodes with project labels) lives here; only counts + $ leave. */
  contextHygiene: ContextHygiene;
  alwaysOn: AlwaysOnTax;
  /** Skill/MCP ROI ledger — carry vs realized value, with dead-weight verdicts.
   *  LOCAL-ONLY (skill/server names are custom); only the counts-only summary aggregates. */
  roiLedger: RoiLedger;
  /** Wall-clock stratification + work-hour histogram. */
  temporal: TemporalProfile;
  /** Per-skill friction (tool-error / self-correction / retry-loop). */
  friction: FrictionTaxonomy;
  /** Ranked, file-anchored next actions (the config-knob bridge). Local-only — paths
   *  here never enter the aggregate. */
  recommendations: Recommendation[];
  /** Most-re-read files (basename only) for the report's concrete redundancy story.
   *  LOCAL-ONLY — never enters the aggregate (the uploaded shape carries only the rate). */
  topRedundantFiles: { name: string; rereads: number }[];
  aggregate: AggregateRecord;
  /** N most expensive sessions with their structure. LOCAL-ONLY (raw gists/projects) —
   *  rendered in the TUI, never placed in the aggregate. */
  topSessions: TopSession[];
  /** Personal context-degradation knee — the context band where redundant re-reads +
   *  friction first climb ≥2× the low-context baseline, merged across the window. The
   *  same number the live-guardrail statusline arms against. Counts/rates only. */
  contextKnee: ContextKnee;
  sessionCount: number;
}

export function runAudit(
  sessions: Session[],
  generatedAt: string,
  opts: { shareSessions?: boolean } = {},
): AuditResult {
  const spend = attributeSpend(sessions);
  const fluency = computeFluency(sessions);
  const contextHygiene = computeContextHygiene(sessions);
  const alwaysOn = computeAlwaysOn(sessions);
  // ROI ledger must be built BEFORE recommendations — dead-weight skills/servers feed recs.
  const roiLedger = buildRoiLedger(spend, alwaysOn, sessions);
  const temporal = computeTemporal(sessions);
  const friction = computeFriction(sessions);
  const recommendations = buildRecommendations(spend, alwaysOn, sessions, roiLedger);
  const top = topSessions(sessions);
  // Sessions are already loaded, so fitting the knee here is near-free (the statusline
  // pays the scan separately because it runs without a full audit in scope).
  const contextKnee = computeContextKnee(sessions);
  // The leaderboard enters the UPLOADED aggregate ONLY on explicit opt-in, and even
  // then anonymized (no gist/project/raw $). Default: stays local in the TUI.
  const anonTop = opts.shareSessions ? anonymizeTopSessions(top, spend.totalUsd) : [];
  const aggregate = buildAggregateRecord(spend, fluency, contextHygiene, alwaysOn, generatedAt, anonTop, roiLedger, temporal, friction);
  return {
    spend,
    fluency,
    contextHygiene,
    alwaysOn,
    roiLedger,
    temporal,
    friction,
    recommendations,
    aggregate,
    topSessions: top,
    contextKnee,
    topRedundantFiles: topRedundantFiles(sessions, 3),
    sessionCount: sessions.length,
  };
}
