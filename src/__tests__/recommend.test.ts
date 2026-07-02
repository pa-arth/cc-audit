import { describe, it, expect } from 'vitest';
import { buildRecommendations } from '../recommend.js';
import { buildRoiLedger } from '../roiLedger.js';
import type { AlwaysOnTax } from '../alwaysOn.js';
import type { SpendBreakdown } from '../attribute.js';
import type { Session, Span, AssistantTurn, TurnUsage } from '../model.js';

// Hand-built sessions (no fs, no transcripts) — buildRecommendations' breakeven block
// reads only span/turn usage plus the blended read rate off AlwaysOnTax.
function turn(usage: Partial<TurnUsage>, model = 'claude-opus-4-8'): AssistantTurn {
  return {
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...usage },
    tools: [],
    reads: [],
    thinkingChars: 0,
    textChars: 0,
    ts: null,
    mode: null,
    toolResultTs: null,
    toolErrorCount: 0,
  };
}
function span(turns: AssistantTurn[], isSidechain: boolean): Span {
  return {
    promptId: isSidechain ? null : 'p',
    command: null,
    invokedSkills: [],
    firstUserText: '',
    turns,
    isSidechain,
    autoCompacted: false,
    attributionSkill: null,
    attributionAgent: isSidechain ? 'general-purpose' : null,
    userTs: null,
  };
}
function session(id: string, spans: Span[]): Session {
  return { sessionId: id, project: 'p', cwd: null, mtime: 0, modes: [], spans };
}
function spendStub(over: Partial<SpendBreakdown> = {}): SpendBreakdown {
  return {
    totalUsd: 0,
    windowDays: 15,
    perMonthUsd: 0,
    unpricedShare: 0,
    byModel: [],
    byProject: [],
    commandLeakBoard: [],
    commandTotalUsd: 0,
    subagentLeakBoard: [],
    subagentTotalUsd: 0,
    modelInvokedSkills: [],
    nonCommandUsd: 0,
    ...over,
  };
}
function alwaysOnStub(over: Partial<AlwaysOnTax> = {}): AlwaysOnTax {
  return {
    standingContextTokens: 0,
    observedMonthlyUsd: 0,
    alwaysOnConfigTokensPerTurn: 0,
    alwaysOnConfigMonthlyUsd: 0,
    globalClaudeMdTokens: 0,
    globalClaudeMdUsd: 0,
    projectClaudeMdTokens: 0,
    projectClaudeMdUsd: 0,
    skillDescriptionTokens: 0,
    skillDescriptionUsd: 0,
    skillCount: 0,
    skillCarry: [],
    pluginSkillTokens: 0,
    pluginSkillUsd: 0,
    pluginCommandTokens: 0,
    pluginCommandUsd: 0,
    pluginAgentTokens: 0,
    pluginAgentUsd: 0,
    pluginListingTokens: 0,
    pluginListingUsd: 0,
    pluginCount: 0,
    unusedPluginCount: 0,
    plugins: [],
    spawnsPerMonth: 0,
    spawnPrefixTokens: 0,
    spawnTaxMonthlyUsd: 0,
    cacheReadRatePerMTok: 0.5,
    cacheWriteRatePerMTok: 6.25,
    mcpServerCount: 0,
    mcpServerNames: [],
    mcpDeferred: true,
    mcpInvokedRate: 0,
    conditionalContext: [],
    note: '',
    ...over,
  };
}

// A hollow spawn: 17.5k-token setup, 500 tok of actual work beyond it.
const hollowSpawn = () => span([turn({ input: 500, cacheWrite5m: 17000, output: 500 })], true);
// An earning spawn: same setup, then chews through 60k of material.
const earningSpawn = () =>
  span(
    [turn({ input: 500, cacheWrite5m: 17000, output: 2000 }), turn({ input: 60000, output: 3000 })],
    true,
  );
// Main session: 20 main-chain turns → median main turns 20 → assumed remaining = 10.
const mainSession = () =>
  session('main', [span(Array.from({ length: 20 }, () => turn({ input: 100, output: 100 })), false)]);

describe('delegation-breakeven recommendation', () => {
  const roi = buildRoiLedger(spendStub(), alwaysOnStub(), []);

  it('derives the breakeven from the user data and flags hollow spawns', () => {
    const sessions = [
      mainSession(),
      session('spawns', [hollowSpawn(), hollowSpawn(), hollowSpawn(), earningSpawn(), earningSpawn(), earningSpawn()]),
    ];
    const recs = buildRecommendations(spendStub(), alwaysOnStub(), sessions, roi);
    const rec = recs.find((r) => r.kind === 'subagent-policy')!;
    expect(rec).toBeTruthy();
    expect(rec.title).toContain('3 of 6 subagent spawns');
    // setupUsd = (17000·$6.25 + 500·$5)/1e6 = $0.10875 (Opus 4.8)
    // breakeven = 0.10875e6 / (remTurns 10 × readRate 0.5) = 21,750 tok → "≳22k tok"
    expect(rec.action).toContain('≳22k tok');
    // saved = 3 hollow × $0.10875, monthly-normalized over windowDays 15.
    expect(rec.monthlyUsdSaved).toBeCloseTo(((3 * 0.10875) / 15) * 30.44, 4);
  });

  it('stays silent below 5 spawns (confidence floor)', () => {
    const sessions = [
      mainSession(),
      session('spawns', [hollowSpawn(), hollowSpawn(), earningSpawn(), earningSpawn()]),
    ];
    const recs = buildRecommendations(spendStub(), alwaysOnStub(), sessions, roi);
    expect(recs.filter((r) => r.kind === 'subagent-policy')).toHaveLength(0);
  });

  it('stays silent when every spawn clears the breakeven', () => {
    const sessions = [
      mainSession(),
      session('spawns', [earningSpawn(), earningSpawn(), earningSpawn(), earningSpawn(), earningSpawn()]),
    ];
    const recs = buildRecommendations(spendStub(), alwaysOnStub(), sessions, roi);
    expect(recs.filter((r) => r.kind === 'subagent-policy')).toHaveLength(0);
  });
});
