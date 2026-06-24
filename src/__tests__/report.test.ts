import { describe, it, expect } from 'vitest';
import { renderRightSizing } from '../report.js';
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
