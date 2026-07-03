import { describe, it, expect } from 'vitest';
import { buildConfigSuggestions, renderConfigSuggestions } from '../configSuggestions.js';
import type { AlwaysOnTax } from '../alwaysOn.js';
import type { ConditionalContextItem } from '../conditionalContext.js';
import type { FixProposal } from '../fix.js';
import type { Recommendation } from '../recommend.js';
import type { RoiLedger, SkillRoiRow, McpRoiRow } from '../roiLedger.js';

// Minimal builders — buildConfigSuggestions reads only a few fields off each input.
function skillRow(over: Partial<SkillRoiRow> = {}): SkillRoiRow {
  return {
    name: 'myskill',
    slug: 'myskill',
    carryUsdPerMonth: 3,
    carryTokens: 400,
    invocations: 0,
    realizedUsd: 0,
    viaCommand: false,
    viaModelInvoked: false,
    viaSubagent: false,
    onDisk: true,
    lowConfidence: false,
    verdict: 'dead-weight',
    ...over,
  };
}
function mcpRow(over: Partial<McpRoiRow> = {}): McpRoiRow {
  return {
    server: 'ghost-server',
    invocations: 0,
    distinctTools: 0,
    sessionsUsed: 0,
    configured: true,
    deadWeight: true,
    deferred: false,
    ...over,
  };
}
function ledger(skills: SkillRoiRow[] = [], mcp: McpRoiRow[] = []): RoiLedger {
  return {
    skills,
    mcp,
    summary: {
      deadWeightSkillCount: 0,
      deadWeightSkillCarryUsdPerMonth: 0,
      earningSkillCount: 0,
      cheapSkillCount: 0,
      deadWeightMcpCount: 0,
      deadWeightMcpStandingCost: false,
    },
  };
}
function ccItem(over: Partial<ConditionalContextItem> = {}): ConditionalContextItem {
  return {
    file: 'ERRORS.md',
    tokens: 3400,
    instruction: 'read ERRORS.md before changes',
    sourcePath: '/p/CLAUDE.md',
    source: 'project-claude-md',
    project: 'p',
    skill: null,
    observedReadRate: 0.2,
    observedMedianFirstTurn: 2,
    sessionsConsidered: 10,
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
    mcpServerCount: 0,
    mcpServerNames: [],
    mcpDeferred: true,
    mcpInvokedRate: 0,
    conditionalContext: [],
    note: '',
    ...over,
  };
}
function build(over: {
  roiLedger?: RoiLedger;
  alwaysOn?: AlwaysOnTax;
  recommendations?: Recommendation[];
  sessionCount?: number;
} = {}) {
  return buildConfigSuggestions(
    {
      roiLedger: over.roiLedger ?? ledger(),
      alwaysOn: over.alwaysOn ?? alwaysOn(),
      recommendations: over.recommendations ?? [],
      sessionCount: over.sessionCount ?? 12,
    },
    [],
  );
}

describe('buildConfigSuggestions', () => {
  it('turns a dead-weight skill into a delete-skill suggestion carrying its $/mo', () => {
    const s = build({ roiLedger: ledger([skillRow()]) });
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('delete-skill');
    expect(s[0]!.monthlyUsdSaved).toBe(3);
    // Two-sided verdict: both delete AND rewrite-the-trigger appear in the action.
    expect(s[0]!.action).toContain('Delete');
    expect(s[0]!.action).toContain('description:');
    expect(s[0]!.evidence).toContain('0 invocations across 12 sessions');
  });

  it('excludes earning, cheap, and off-disk skills', () => {
    const s = build({
      roiLedger: ledger([
        skillRow({ verdict: 'heavy-but-earning' }),
        skillRow({ verdict: 'cheap-fine' }),
        skillRow({ onDisk: false }),
      ]),
    });
    expect(s).toHaveLength(0);
  });

  it('turns a measured low-read-rate instruction into an exact cut with quote + path', () => {
    const s = build({ alwaysOn: alwaysOn({ conditionalContext: [ccItem()] }) });
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('cut-instruction');
    expect(s[0]!.quote).toBe('read ERRORS.md before changes');
    expect(s[0]!.file).toBe('/p/CLAUDE.md');
    expect(s[0]!.evidence).toContain('20%');
    expect(s[0]!.evidence).toContain('10 sessions');
    expect(s[0]!.monthlyUsdSaved).toBe(0); // conditional loads aren't costed — honest 0
  });

  it('excludes unverified (null read-rate) and actually-followed instructions', () => {
    const s = build({
      alwaysOn: alwaysOn({
        conditionalContext: [ccItem({ observedReadRate: null }), ccItem({ observedReadRate: 0.8 })],
      }),
    });
    expect(s).toHaveLength(0);
  });

  it('passes through file-anchored model-pin recommendations only', () => {
    const s = build({
      recommendations: [
        { kind: 'model-pin', title: 'pin me', monthlyUsdSaved: 4, file: '/p/.claude/skills/x/SKILL.md', action: 'Add `model: sonnet`.' },
        { kind: 'model-pin', title: 'bundled', monthlyUsdSaved: 2, file: null, action: 'no file' },
        { kind: 'trim-config', title: 'trim', monthlyUsdSaved: 9, file: '/p/CLAUDE.md', action: 'cut' },
      ],
    });
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('model-pin');
    expect(s[0]!.file).toBe('/p/.claude/skills/x/SKILL.md');
  });

  it('flags eager dead MCP servers and skips deferred ones', () => {
    const s = build({ roiLedger: ledger([], [mcpRow(), mcpRow({ server: 'deferred-one', deferred: true })]) });
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('remove-mcp');
    expect(s[0]!.title).toContain('ghost-server');
  });

  it('flags unused plugins with their token-share saving; skips tiny and invoked ones', () => {
    const plugin = (name: string, listingTokens: number, invoked: boolean) => ({
      name,
      marketplace: 'm',
      skillTokens: listingTokens,
      commandTokens: 0,
      agentTokens: 0,
      listingTokens,
      invoked,
    });
    const s = build({
      alwaysOn: alwaysOn({
        plugins: [plugin('big-unused', 200, false), plugin('tiny', 10, false), plugin('used', 500, true)],
        pluginListingTokens: 710,
        pluginListingUsd: 7.1,
      }),
    });
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('disable-plugin');
    expect(s[0]!.monthlyUsdSaved).toBeCloseTo(7.1 * (200 / 710), 6);
  });

  it('ranks by $/mo saved with honest-zero rows last', () => {
    const s = build({
      roiLedger: ledger([skillRow({ carryUsdPerMonth: 1 })], [mcpRow()]),
      recommendations: [
        { kind: 'model-pin', title: 'pin', monthlyUsdSaved: 5, file: '/p/SKILL.md', action: 'pin it' },
      ],
      alwaysOn: alwaysOn({ conditionalContext: [ccItem()] }),
    });
    expect(s.map((x) => x.kind)).toEqual(['model-pin', 'delete-skill', 'cut-instruction', 'remove-mcp']);
  });
});

describe('renderConfigSuggestions', () => {
  it('renders the panel with quote, path, evidence, and the pin review command', () => {
    const suggestions = build({
      roiLedger: ledger([skillRow()]),
      alwaysOn: alwaysOn({ conditionalContext: [ccItem()] }),
      recommendations: [
        { kind: 'model-pin', title: 'pin `x`', monthlyUsdSaved: 4, file: '/p/.claude/skills/x/SKILL.md', action: 'Add `model: sonnet`.' },
      ],
    });
    const pin: FixProposal = {
      kind: 'model-pin',
      title: 'pin `x`',
      realFile: '/p/.claude/skills/x/SKILL.md',
      proposalFile: '.cc-audit/x__SKILL.md.proposed',
      monthlyUsdSaved: 4,
      safe: true,
      caution: null,
      summary: '+ model: sonnet  (frontmatter)',
    };
    const out = renderConfigSuggestions(suggestions, [pin]);
    expect(out).toContain('CONFIG CHANGE SUGGESTIONS');
    expect(out).toContain('generated locally — nothing sent, nothing applied');
    expect(out).toContain('cut: "read ERRORS.md before changes"');
    expect(out).toContain('/p/CLAUDE.md');
    expect(out).toContain('evidence: followed in 20% of 10 sessions');
    expect(out).toContain('git diff --no-index /p/.claude/skills/x/SKILL.md .cc-audit/x__SKILL.md.proposed');
    expect(out).toContain('~$3.00/mo');
    expect(out).toContain('nothing was changed');
  });

  it('states plainly when there is nothing to cut', () => {
    const out = renderConfigSuggestions([], []);
    expect(out).toContain('nothing to cut');
  });
});
