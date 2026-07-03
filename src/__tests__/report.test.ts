import { describe, it, expect } from 'vitest';
import { renderReport, renderRightSizing } from '../report.js';
import { runAudit } from '../audit.js';
import { parseTranscript } from '../adapters/claudeCode.js';
import type { ConfigSuggestion } from '../configSuggestions.js';
import type { SessionFootprint } from '../footprint.js';
import type { RightSizingResult, Verdict } from '../judgeClient.js';

const fp = (costUsd: number): SessionFootprint => ({
  taskGist: 'a task',
  model: 'claude-opus-4-8',
  turns: 5,
  fileCount: 1,
  tools: {},
  costUsd,
});

const v = (over: boolean, confidence: Verdict['confidence'], savingsUsd: number): Verdict => ({
  minTier: over ? 'sonnet' : 'frontier',
  confidence,
  reason: 'r',
  savingsUsd,
  overModeled: over,
  unassessed: false,
});

// One high-confidence cut, one medium-confidence cut, one not-over-modeled.
const footprints = [fp(10), fp(10), fp(10)];
const result: RightSizingResult = {
  verdicts: [v(true, 'high', 4), v(true, 'medium', 4), v(false, 'high', 0)],
  summary: { judged: 3, overModeledCount: 2, overModeledShare: 2 / 3, totalCostUsd: 30, totalSavingsUsd: 8, savingsShare: 8 / 30 },
};

describe('renderReport section order (config suggestions first among offers)', () => {
  // A minimal real session so runAudit produces a full AuditResult; the sections
  // under test are then made deterministic by patching in local-only fixtures
  // (renderReport is pure — it renders whatever the result carries).
  const events = [
    { type: 'user', promptId: 'p1', cwd: '/tmp/proj', message: { content: 'do a task' } },
    {
      type: 'assistant',
      message: {
        id: 'a1',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ];
  const session = parseTranscript('/tmp/cc-report.jsonl', events.map((e) => JSON.stringify(e)).join('\n'), 'proj', new Set())!;
  const base = runAudit([session], '2026-06-16T00:00:00.000Z');
  const suggestion: ConfigSuggestion = {
    kind: 'delete-skill',
    title: '`ghost` loads every turn but was never invoked',
    file: '/p/.claude/skills/ghost/SKILL.md',
    quote: null,
    action: 'Delete it, or rewrite its `description:` trigger keywords.',
    evidence: '0 invocations across 12 sessions',
    monthlyUsdSaved: 3,
  };
  const result = {
    ...base,
    configSuggestions: [suggestion],
    recommendations: [
      { kind: 'trim-config' as const, title: 'Trim CLAUDE.md', monthlyUsdSaved: 5, file: '/p/CLAUDE.md', action: 'cut stale guidance' },
    ],
  };
  const out = renderReport(result);

  it('renders ③ CONFIG CHANGE SUGGESTIONS before ④ MODEL RIGHT-SIZING', () => {
    const cs = out.indexOf('③ CONFIG CHANGE SUGGESTIONS');
    const rs = out.indexOf('④ MODEL RIGHT-SIZING');
    expect(cs).toBeGreaterThan(-1);
    expect(rs).toBeGreaterThan(-1);
    expect(cs).toBeLessThan(rs);
  });

  it('teaser counts the edits and points at the offer / cc-audit fix', () => {
    expect(out).toContain('1 exact edit');
    expect(out).toContain('dead-weight skills');
    expect(out).toContain('cc-audit fix');
  });

  it('omits the ③ card when there is nothing to suggest, keeping ④ stable', () => {
    const empty = renderReport({ ...result, configSuggestions: [] });
    expect(empty).not.toContain('③ CONFIG CHANGE SUGGESTIONS');
    expect(empty).toContain('④ MODEL RIGHT-SIZING');
  });

  it('NEXT ACTIONS footer routes to the reviewable-edits flow', () => {
    const next = out.slice(out.indexOf('NEXT ACTIONS'));
    expect(next).toContain('cc-audit fix');
  });
});

describe('renderRightSizing aggressiveness gate', () => {
  it('conservative surfaces only high-confidence cuts', () => {
    const out = renderRightSizing(footprints, result, 30, 100, 'conservative');
    expect(out).toContain('aggressiveness: conservative');
    // only the high-confidence cut counts → 1 of 3 judged = 33%
    expect(out).toContain('33% of 3 judged');
  });

  it('balanced surfaces high + medium cuts', () => {
    const out = renderRightSizing(footprints, result, 30, 100, 'balanced');
    // both cuts count → 2 of 3 = 67%
    expect(out).toContain('67% of 3 judged');
  });

  it('extrapolates gated savings share to premium monthly spend', () => {
    // conservative: gated savings = 4 of 30 cost = 13.3% → 13.3% × $100/mo ≈ $13
    const out = renderRightSizing(footprints, result, 30, 100, 'conservative');
    expect(out).toMatch(/~\$13.*\/mo right-sizable/);
  });
});
