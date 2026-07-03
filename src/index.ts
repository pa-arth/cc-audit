// @promptster/cc-audit — trajectory-level audit of AI coding tool usage from
// local transcripts: spend attribution, model right-sizing signals, AI-fluency.
// Importable lib surface (the CLI lives in cli.ts). Claude Code adapter ships
// first; the model is tool-agnostic so Codex/Cursor adapters drop in later.

export type { Session, Span, AssistantTurn, TurnUsage } from './model.js';
export { allTurns } from './model.js';

export { loadClaudeCodeSessions, parseTranscript } from './adapters/claudeCode.js';
export type { LoadOptions } from './adapters/claudeCode.js';

export { turnCostUsd, turnTokens, isPremiumModel } from './pricing.js';
export { attributeSpend } from './attribute.js';
export type { SpendBreakdown, ModelSpend, CommandSpend } from './attribute.js';
export { computeFluency } from './fluency.js';
export type { FluencySignals } from './fluency.js';
export { computeContextHygiene } from './contextHygiene.js';
export type { ContextHygiene, OverdueCompactEpisode, StaleCarrySwitch } from './contextHygiene.js';
export { buildHygieneFootprints, refineAvoidableCarry, toRefinementUpload } from './hygieneFootprint.js';
export type {
  HygieneJudgeItem,
  HygieneFootprint,
  HygieneVerdict,
  RefinedHygiene,
  HygieneRefinementUpload,
} from './hygieneFootprint.js';
export { computeAlwaysOn } from './alwaysOn.js';
export type { AlwaysOnTax, SkillCarry } from './alwaysOn.js';
export { computePluginTax } from './pluginTax.js';
export type { PluginTax, PluginInfo } from './pluginTax.js';
export { buildRoiLedger } from './roiLedger.js';
export type { RoiLedger, SkillRoiRow, McpRoiRow, SkillVerdict } from './roiLedger.js';
export { computeTemporal, computeWeeklySpend } from './temporal.js';
export type { TemporalProfile, HourBucket, StratifiedTime, WeeklySpendBucket } from './temporal.js';
export { computeFriction, spanSkillKey } from './friction.js';
export type { FrictionTaxonomy, SkillFriction, FrictionKind } from './friction.js';

export { buildAggregateRecord, AggregateRecordSchema, AGGREGATE_SCHEMA_VERSION } from './aggregate.js';
export type { AggregateRecord } from './aggregate.js';

export { runAudit } from './audit.js';
export type { AuditResult } from './audit.js';
export { buildConfigSuggestions, renderConfigSuggestions } from './configSuggestions.js';
export type { ConfigSuggestion } from './configSuggestions.js';
export { renderReport, renderRightSizing } from './report.js';
export { buildFootprints } from './footprint.js';
export type { SessionFootprint } from './footprint.js';
export { judgeFootprints } from './judgeClient.js';
export type { Verdict, RightSizingResult } from './judgeClient.js';
