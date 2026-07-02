import { describe, it, expect } from 'vitest';
import { renderReport, renderRightSizing } from '../report.js';
import { parseTranscript } from '../adapters/claudeCode.js';
import { runAudit } from '../audit.js';
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

describe('renderReport — run-over-run delta + weekly run-rate', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const NOW = Date.parse('2026-06-16T00:00:00.000Z');
  const DAY = 86_400_000;
  const turn = (tsMs: number) => ({
    type: 'assistant',
    timestamp: iso(tsMs),
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
  const fixture = [
    { type: 'user', promptId: 'p1', timestamp: iso(NOW - 8 * DAY), message: { content: 'do a thing' } },
    turn(NOW - 8 * DAY),
    { type: 'user', promptId: 'p2', timestamp: iso(NOW - 1 * DAY), message: { content: 'another thing' } },
    turn(NOW - 1 * DAY),
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const result = () => runAudit([parseTranscript('/tmp/rr.jsonl', fixture, 'proj')!], iso(NOW));

  const delta = {
    baselineDate: '2026-06-12',
    spendPerMonthUsd: { prev: 3926, cur: 3100 },
    avoidableCarryPerMonthUsd: { prev: 910, cur: 640 },
    premiumTurnShare: { prev: 0.96, cur: 0.71 },
    redundantReadRate: { prev: 0.35, cur: 0.35 },
  };

  it('renders delta rows against the baseline with polarity arrows', () => {
    const out = renderReport(result(), { delta });
    expect(out).toContain('vs your Jun 12 audit:');
    expect(out).toContain('avoidable carry $910/mo → $640/mo ▼30%');
    expect(out).toContain('vs Jun 12: $3,926/mo → $3,100/mo ▼21%');
    expect(out).toContain('premium share 96% → 71% ▼25pt');
    expect(out).toContain('redundant reads 35% → 35% ~flat');
  });

  it('worsened metrics point up', () => {
    const out = renderReport(result(), {
      delta: { ...delta, avoidableCarryPerMonthUsd: { prev: 640, cur: 910 } },
    });
    expect(out).toContain('avoidable carry $640/mo → $910/mo ▲42%');
  });

  it('first-run shows the explainer instead of a delta', () => {
    const out = renderReport(result(), { delta: 'first-run' });
    expect(out).toContain('first audit at this window');
    expect(out).not.toContain('vs your');
  });

  it('no delta opt (history disabled) renders neither', () => {
    const out = renderReport(result(), {});
    expect(out).not.toContain('first audit at this window');
    expect(out).not.toContain('vs your');
  });

  it('renders the weekly run-rate sparkline from timestamped turns', () => {
    const out = renderReport(result(), {});
    expect(out).toContain('run-rate $');
    expect(out).toContain('/wk');
  });
});
