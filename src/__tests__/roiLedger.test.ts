import { describe, it, expect } from 'vitest';
import { buildRoiLedger } from '../roiLedger.js';
import type { AlwaysOnTax, SkillCarry } from '../alwaysOn.js';
import type { SpendBreakdown, CommandSpend, SubagentSpend, ModelInvokedSkill } from '../attribute.js';
import type { Session, Span, AssistantTurn } from '../model.js';

// Minimal builders — buildRoiLedger reads only a few fields off each board.
function carry(slug: string, declaredName: string, descTokens = 100, monthlyUsd = 1): SkillCarry & { monthlyUsd: number } {
  return { slug, declaredName, descTokens, monthlyUsd };
}
function command(command: string, costUsd: number, invocations: number): CommandSpend {
  return {
    command,
    costUsd,
    invocations,
    costPerInvocation: costUsd / invocations,
    turnsPerInvocation: 1,
    topModel: 'claude-opus-4-8',
    contextTaxRatio: 1,
    forkCandidate: false,
    modelPinCandidate: false,
    contextHeavy: false,
    isSystemCommand: false,
  };
}
function subagent(name: string, costUsd: number, isSkill = true): SubagentSpend {
  return { name, isSkill, costUsd, turns: 5, topModel: 'claude-opus-4-8', modelPinCandidate: false };
}
function modelInvoked(name: string, invocations: number, usd: number): ModelInvokedSkill {
  return { name, invocations, spanUsdUpperBound: usd };
}
function spend(over: Partial<SpendBreakdown> = {}): SpendBreakdown {
  return {
    totalUsd: 0,
    windowDays: 30,
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
function alwaysOn(over: Partial<AlwaysOnTax> = {}): AlwaysOnTax {
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
    cacheReadRatePerMTok: 0.4,
    cacheWriteRatePerMTok: 5,
    mcpServerCount: 0,
    mcpServerNames: [],
    mcpDeferred: true,
    mcpInvokedRate: 0,
    conditionalContext: [],
    note: '',
    ...over,
  };
}
function mcpTurn(...tools: string[]): AssistantTurn {
  return {
    model: 'claude-opus-4-8',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    tools,
    reads: [],
    thinkingChars: 0,
    textChars: 0,
    ts: null,
    mode: null,
    toolResultTs: null,
    toolErrorCount: 0,
  };
}
function mcpSession(id: string, turns: AssistantTurn[]): Session {
  const span: Span = {
    promptId: 'p',
    command: null,
    invokedSkills: [],
    firstUserText: '',
    turns,
    isSidechain: false,
    autoCompacted: false,
    attributionSkill: null,
    attributionAgent: null,
    userTs: null,
  };
  return { sessionId: id, project: 'p', cwd: null, mtime: 0, modes: [], spans: [span] };
}

describe('buildRoiLedger — skill join', () => {
  it('unifies a skill invoked three ways into ONE summed row', () => {
    const l = buildRoiLedger(
      spend({
        commandLeakBoard: [command('deploy', 10, 3)],
        subagentLeakBoard: [subagent('deploy', 5)],
        modelInvokedSkills: [modelInvoked('deploy', 2, 4)],
      }),
      alwaysOn({ skillCarry: [carry('deploy', 'deploy')] }),
      [],
    );
    const rows = l.skills.filter((s) => s.slug === 'deploy' || s.name === 'deploy');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.viaCommand && r.viaSubagent && r.viaModelInvoked).toBe(true);
    expect(r.invocations).toBe(3 + 1 + 2); // command 3 + subagent 1 run + model-invoked 2
    expect(r.realizedUsd).toBeCloseTo(10 + 5 + 4);
    expect(r.usdPerRun).toBeCloseTo(19 / 6); // price per press = realized / invocations
    expect(r.verdict).toBe('heavy-but-earning');
  });

  it('resolves slug≠declaredName and plugin-prefix to the same row', () => {
    const l = buildRoiLedger(
      spend({
        commandLeakBoard: [command('deep-research', 1, 1)],
        modelInvokedSkills: [modelInvoked('myplugin:research', 1, 1)],
      }),
      alwaysOn({ skillCarry: [carry('deep-research', 'research')] }),
      [],
    );
    // dir slug 'deep-research', declared name 'research', plus a plugin-prefixed call → 1 row.
    const rows = l.skills.filter((s) => s.slug === 'deep-research');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invocations).toBe(2);
  });

  it('marks a never-invoked on-disk skill as dead-weight', () => {
    const l = buildRoiLedger(spend(), alwaysOn({ skillCarry: [carry('seo', 'seo', 80, 0.73)] }), []);
    const r = l.skills.find((s) => s.slug === 'seo')!;
    expect(r.verdict).toBe('dead-weight');
    expect(r.onDisk).toBe(true);
    expect(r.invocations).toBe(0);
    expect(r.usdPerRun).toBeNull(); // carry-only row — no price per press
    expect(l.summary.deadWeightSkillCount).toBe(1);
    expect(l.summary.deadWeightSkillCarryUsdPerMonth).toBeCloseTo(0.73);
  });

  it('does NOT mark a bundled (not-on-disk) skill as dead-weight', () => {
    const l = buildRoiLedger(spend({ subagentLeakBoard: [subagent('deep-research', 200)] }), alwaysOn(), []);
    const r = l.skills.find((s) => s.slug === 'deep-research')!;
    expect(r.onDisk).toBe(false);
    expect(r.carryUsdPerMonth).toBe(0);
    expect(r.verdict).not.toBe('dead-weight');
  });

  it('flags n<5 low confidence below the threshold, not at it', () => {
    const three = buildRoiLedger(
      spend({ commandLeakBoard: [command('x', 1, 3)] }),
      alwaysOn({ skillCarry: [carry('x', 'x')] }),
      [],
    );
    expect(three.skills.find((s) => s.slug === 'x')!.lowConfidence).toBe(true);
    const five = buildRoiLedger(
      spend({ commandLeakBoard: [command('x', 1, 5)] }),
      alwaysOn({ skillCarry: [carry('x', 'x')] }),
      [],
    );
    expect(five.skills.find((s) => s.slug === 'x')!.lowConfidence).toBe(false);
  });
});

describe('buildRoiLedger — MCP join', () => {
  it('flags a configured-but-never-invoked server as dead-weight', () => {
    const l = buildRoiLedger(spend(), alwaysOn({ mcpServerNames: ['supabase'], mcpDeferred: true }), [
      mcpSession('s1', [mcpTurn('Read')]),
    ]);
    const m = l.mcp.find((x) => x.server === 'supabase')!;
    expect(m.deadWeight).toBe(true);
    expect(m.deferred).toBe(true);
    expect(l.summary.deadWeightMcpStandingCost).toBe(false); // deferred ⇒ ~$0
  });

  it('counts per-server invocations and is not dead-weight when used', () => {
    const l = buildRoiLedger(spend(), alwaysOn({ mcpServerNames: ['supabase'] }), [
      mcpSession('s1', [mcpTurn('mcp__supabase__execute_sql'), mcpTurn('mcp__supabase__list_tables')]),
    ]);
    const m = l.mcp.find((x) => x.server === 'supabase')!;
    expect(m.invocations).toBe(2);
    expect(m.distinctTools).toBe(2);
    expect(m.deadWeight).toBe(false);
  });

  it('sets standing-cost flag when a dead server is NOT deferred', () => {
    const l = buildRoiLedger(spend(), alwaysOn({ mcpServerNames: ['clerk'], mcpDeferred: false }), []);
    expect(l.summary.deadWeightMcpStandingCost).toBe(true);
  });

  it('handles malformed mcp__ tool names without crashing', () => {
    const l = buildRoiLedger(spend(), alwaysOn({ mcpServerNames: [] }), [
      mcpSession('s1', [mcpTurn('mcp__'), mcpTurn('mcp__srv')]),
    ]);
    // 'mcp__' → no server; 'mcp__srv' → server 'srv', not configured ⇒ never dead-weight.
    const srv = l.mcp.find((x) => x.server === 'srv');
    expect(srv?.configured).toBe(false);
    expect(srv?.deadWeight).toBe(false);
  });

  it('surfaces an invoked-but-unconfigured server, never dead-weight', () => {
    const l = buildRoiLedger(spend(), alwaysOn({ mcpServerNames: [] }), [
      mcpSession('s1', [mcpTurn('mcp__posthog__exec')]),
    ]);
    const m = l.mcp.find((x) => x.server === 'posthog')!;
    expect(m.configured).toBe(false);
    expect(m.deadWeight).toBe(false);
  });
});

describe('buildRoiLedger — empty corpus', () => {
  it('returns an empty ledger', () => {
    const l = buildRoiLedger(spend(), alwaysOn(), []);
    expect(l.skills).toHaveLength(0);
    expect(l.mcp).toHaveLength(0);
    expect(l.summary.deadWeightSkillCount).toBe(0);
  });
});
