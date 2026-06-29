// Privacy-safe aggregate record — the content/benchmark flywheel. Emitted with
// every audit so that the moment a hosted endpoint exists, the data the posts +
// "you vs peers" benchmarks run on is already being produced. HARD RULE: never
// raw prompts, code, file contents, repo/org names, or paths (so the local
// PROJECT breakdown is deliberately excluded here — it stays in the local report).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AlwaysOnTax } from './alwaysOn.js';
import type { SpendBreakdown } from './attribute.js';
import type { ContextHygiene } from './contextHygiene.js';
import type { FluencySignals } from './fluency.js';
import type { AnonTopSession } from './topSessions.js';

// v2 additions: subagent (delegated-spend) leak board + spend.subagentShare;
// model-invoked-skills list; per-command context-tax fields (contextTaxRatio,
// contextHeavy, isSystemCommand); and the always-on overhaul (observed-vs-recoverable
// split, per-component CLAUDE.md/skill tokens, MCP deferred + invoked rate).
// v3 additions: conditionalContext — COUNTS ONLY (how many "read X" config instructions
// were found, their total token weight, and how many were empirically confirmed). The
// referenced filenames + skill/project names stay LOCAL; only aggregate numbers leave.
// v4: rename alwaysOn.recoverable* → alwaysOnConfig* — standing config is a COST we
// surface, not "savings" to claim; the field name no longer asserts trimmability.
// v5: optional topSessions leaderboard — ANONYMIZED (cost share, turns, model, plan-
// mode, trajectory shape; never gist/project/raw $) and EMPTY unless the user passed
// --share-sessions. The rich version stays local in the TUI.
// v6: contextHygiene — the AVOIDABLE-carry slice (missed /compact + /clear). COUNTS +
// per-month DOLLARS only; the located per-session episodes (project label, sessionId,
// turn ordinal) stay LOCAL in the TUI and never enter the aggregate.
// v7: alwaysOn plugin tax — enabled-plugin bundled skill/command/agent listing tokens
// (folded into the per-turn config total), plugin count, and unused-plugin count. TOKENS
// + COUNTS only; per-plugin names/paths stay LOCAL in the TUI.
export const AGGREGATE_SCHEMA_VERSION = 7;

// Well-known public command/skill names kept verbatim; everything else is hashed
// so a custom name like `acme-deploy` can't leak project/company info.
const COMMON_COMMANDS = new Set([
  'commit-push-pr',
  'commit',
  'compact',
  'clear',
  'pr',
  'review',
  'test',
  'build',
  'deploy',
  'release',
  'lint',
  'format',
  'plan',
]);

// Built-in subagent types + first-party skills that delegate — safe to keep verbatim
// (they name a Claude Code feature, not a customer's project). Custom agent/skill
// names still hash, same as commands.
const COMMON_SUBAGENTS = new Set([
  'subagent',
  'general-purpose',
  'Explore',
  'Plan',
  'workflow-subagent',
  'statusline-setup',
  'claude-code-guide',
  'deep-research',
  'code-review',
  'claude-api',
]);

function safeName(name: string): string {
  const base = name.includes(':') ? name.split(':').pop()! : name;
  if (COMMON_COMMANDS.has(base)) return base;
  return `custom-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

function safeSubagentName(name: string): string {
  const base = name.includes(':') ? name.split(':').pop()! : name;
  if (COMMON_SUBAGENTS.has(base)) return base;
  return `custom-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

export const AggregateRecordSchema = z.object({
  schemaVersion: z.number(),
  tool: z.literal('claude_code'),
  generatedAt: z.string(),
  window: z.object({ days: z.number() }),
  spend: z.object({
    perMonthUsd: z.number(),
    totalUsd: z.number(),
    byModel: z.array(z.object({ model: z.string(), share: z.number() })),
    commandShare: z.number(),
    subagentShare: z.number(),
    nonCommandShare: z.number(),
  }),
  commands: z.array(
    z.object({
      name: z.string(),
      perMonthUsd: z.number(),
      invocationsPerMonth: z.number(),
      turnsPerInvocation: z.number(),
      topModel: z.string(),
      contextTaxRatio: z.number(),
      forkCandidate: z.boolean(),
      modelPinCandidate: z.boolean(),
      contextHeavy: z.boolean(),
      isSystemCommand: z.boolean(),
    }),
  ),
  modelInvokedSkills: z.array(
    z.object({
      name: z.string(),
      invocations: z.number(),
      spanUsdUpperBound: z.number(),
    }),
  ),
  subagents: z.array(
    z.object({
      name: z.string(),
      isSkill: z.boolean(),
      perMonthUsd: z.number(),
      turns: z.number(),
      topModel: z.string(),
      modelPinCandidate: z.boolean(),
    }),
  ),
  fluency: z.object({
    sessions: z.number(),
    planModeRate: z.number(),
    medianTurnsPerTask: z.number(),
    p90TurnsPerTask: z.number(),
    premiumTurnShare: z.number(),
    modelDiversity: z.number(),
    subagentUsageRate: z.number(),
    carryShare: z.number(),
    carryUsd: z.number(),
    redundantReadRate: z.number(),
    score: z.number(),
  }),
  alwaysOn: z.object({
    standingContextTokens: z.number(),
    observedMonthlyUsd: z.number(),
    alwaysOnConfigTokensPerTurn: z.number(),
    alwaysOnConfigMonthlyUsd: z.number(),
    globalClaudeMdTokens: z.number(),
    projectClaudeMdTokens: z.number(),
    skillDescriptionTokens: z.number(),
    skillCount: z.number(),
    pluginSkillTokens: z.number(),
    pluginCommandTokens: z.number(),
    pluginAgentTokens: z.number(),
    pluginListingTokens: z.number(),
    pluginCount: z.number(),
    unusedPluginCount: z.number(),
    mcpServerCount: z.number(),
    mcpDeferred: z.boolean(),
    mcpInvokedRate: z.number(),
  }),
  // Anonymized "top spenders" — empty unless --share-sessions. Cost SHARE + structure
  // only; never the prompt gist, project, or a raw dollar amount.
  topSessions: z.array(
    z.object({
      costShare: z.number(),
      turns: z.number(),
      prompts: z.number(),
      topModel: z.string(),
      planMode: z.boolean(),
      trajectory: z.string(),
    }),
  ),
  // The avoidable-carry slice. Counts + per-month dollars only — the located episodes
  // (project, session, turn) stay local. perMonth so it reads against the spend headline.
  contextHygiene: z.object({
    /** Times a session ran to the context wall (auto-compacted) — ground-truth "should
     *  have /compact'd earlier". */
    autoCompactions: z.number(),
    /** Distinct sessions that hit the wall ≥ once. */
    sessionsRunToWall: z.number(),
    /** Located missed-/compact episodes that cleared the sustained-runway bar. */
    overdueEpisodes: z.number(),
    /** Carry paid above the compaction line, per month (conservative). */
    avoidableCompactUsdPerMonth: z.number(),
    /** Likely task switches that carried stale context (no /clear). */
    staleCarrySwitches: z.number(),
    /** Carry dragging finished-task context past those switches, per month (heuristic). */
    avoidableClearUsdPerMonth: z.number(),
    /** compact + clear, per month — the avoidable-carry headline. */
    avoidableTotalUsdPerMonth: z.number(),
  }),
  // Counts only — never the referenced filenames or the skill/project they came from.
  conditionalContext: z.object({
    /** Distinct "read X"-style config instructions detected (CLAUDE.md + skill bodies). */
    refCount: z.number(),
    /** Total tokens those referenced files would add when the instructions are followed. */
    totalTokens: z.number(),
    /** How many had enough sessions to confirm empirically (observedReadRate !== null). */
    confirmedCount: z.number(),
    /** Of the confirmed, how many were actually read in ≥50% of relevant sessions. */
    followedCount: z.number(),
  }),
  dataQuality: z.object({ unpricedShare: z.number() }),
});
export type AggregateRecord = z.infer<typeof AggregateRecordSchema>;

export function buildAggregateRecord(
  spend: SpendBreakdown,
  fluency: FluencySignals,
  contextHygiene: ContextHygiene,
  alwaysOn: AlwaysOnTax,
  generatedAt: string,
  topSessionsAnon: AnonTopSession[] = [],
): AggregateRecord {
  const safeTotal = spend.totalUsd || 1;
  const perMo = (usd: number) => (usd / contextHygiene.windowDays) * 30.44;
  return AggregateRecordSchema.parse({
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    tool: 'claude_code',
    generatedAt,
    window: { days: spend.windowDays },
    topSessions: topSessionsAnon,
    spend: {
      perMonthUsd: spend.perMonthUsd,
      totalUsd: spend.totalUsd,
      byModel: spend.byModel.map((m) => ({ model: m.model, share: m.share })),
      commandShare: spend.commandTotalUsd / safeTotal,
      subagentShare: spend.subagentTotalUsd / safeTotal,
      nonCommandShare: spend.nonCommandUsd / safeTotal,
    },
    commands: spend.commandLeakBoard.map((c) => ({
      name: safeName(c.command),
      perMonthUsd: (c.costUsd / spend.windowDays) * 30.44,
      invocationsPerMonth: (c.invocations / spend.windowDays) * 30.44,
      turnsPerInvocation: c.turnsPerInvocation,
      topModel: c.topModel,
      contextTaxRatio: c.contextTaxRatio,
      forkCandidate: c.forkCandidate,
      modelPinCandidate: c.modelPinCandidate,
      contextHeavy: c.contextHeavy,
      isSystemCommand: c.isSystemCommand,
    })),
    modelInvokedSkills: spend.modelInvokedSkills.map((m) => ({
      name: safeName(m.name),
      invocations: m.invocations,
      spanUsdUpperBound: m.spanUsdUpperBound,
    })),
    subagents: spend.subagentLeakBoard.map((sg) => ({
      name: safeSubagentName(sg.name),
      isSkill: sg.isSkill,
      perMonthUsd: (sg.costUsd / spend.windowDays) * 30.44,
      turns: sg.turns,
      topModel: sg.topModel,
      modelPinCandidate: sg.modelPinCandidate,
    })),
    fluency,
    alwaysOn: {
      standingContextTokens: alwaysOn.standingContextTokens,
      observedMonthlyUsd: alwaysOn.observedMonthlyUsd,
      alwaysOnConfigTokensPerTurn: alwaysOn.alwaysOnConfigTokensPerTurn,
      alwaysOnConfigMonthlyUsd: alwaysOn.alwaysOnConfigMonthlyUsd,
      globalClaudeMdTokens: alwaysOn.globalClaudeMdTokens,
      projectClaudeMdTokens: alwaysOn.projectClaudeMdTokens,
      skillDescriptionTokens: alwaysOn.skillDescriptionTokens,
      skillCount: alwaysOn.skillCount,
      pluginSkillTokens: alwaysOn.pluginSkillTokens,
      pluginCommandTokens: alwaysOn.pluginCommandTokens,
      pluginAgentTokens: alwaysOn.pluginAgentTokens,
      pluginListingTokens: alwaysOn.pluginListingTokens,
      pluginCount: alwaysOn.pluginCount,
      unusedPluginCount: alwaysOn.unusedPluginCount,
      mcpServerCount: alwaysOn.mcpServerCount,
      mcpDeferred: alwaysOn.mcpDeferred,
      mcpInvokedRate: alwaysOn.mcpInvokedRate,
    },
    contextHygiene: {
      autoCompactions: contextHygiene.autoCompactions,
      sessionsRunToWall: contextHygiene.sessionsRunToWall,
      overdueEpisodes: contextHygiene.overdueEpisodes.length,
      avoidableCompactUsdPerMonth: perMo(contextHygiene.avoidableCompactUsd),
      staleCarrySwitches: contextHygiene.staleCarrySwitches.length,
      avoidableClearUsdPerMonth: perMo(contextHygiene.avoidableClearUsd),
      avoidableTotalUsdPerMonth: perMo(contextHygiene.avoidableTotalUsd),
    },
    conditionalContext: {
      refCount: alwaysOn.conditionalContext.length,
      totalTokens: alwaysOn.conditionalContext.reduce((n, c) => n + c.tokens, 0),
      confirmedCount: alwaysOn.conditionalContext.filter((c) => c.observedReadRate !== null).length,
      followedCount: alwaysOn.conditionalContext.filter((c) => (c.observedReadRate ?? 0) >= 0.5).length,
    },
    dataQuality: { unpricedShare: spend.unpricedShare },
  });
}
