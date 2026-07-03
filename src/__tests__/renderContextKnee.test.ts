import { describe, it, expect } from 'vitest';
import { renderContextKnee } from '../report.js';
import { stripAnsi } from '../theme.js';
import type { ContextKnee } from '../contextKnee.js';
import type { ContextBucket } from '../contextKnee.js';

// Assert on stripped text (the existing report.test.ts is brittle because it matches
// through ANSI escapes — don't repeat that here).
const txt = (knee: ContextKnee) => stripAnsi(renderContextKnee(knee).join('\n'));

const b = (maxTokens: number | null, turns: number, reReads = 0, friction = 0): ContextBucket => ({
  maxTokens,
  turns,
  redundantReReads: reReads,
  frictionEvents: friction,
});

describe('renderContextKnee', () => {
  it('headlines the knee and marks the elevated band on the ramp', () => {
    // baseline <40k rate ~0.05; 80k band ~0.15 (≈3× → clears 2×) → knee at 80k.
    const knee: ContextKnee = {
      windowSessions: 50,
      sessionsWithSignal: 40,
      onsetTokens: 80_000,
      buckets: [
        b(40_000, 200, 0, 10), // 0.05 baseline
        b(60_000, 200, 0, 16),
        b(80_000, 200, 0, 18),
        b(100_000, 200, 0, 30), // ~0.15 = 3× → elevated
        b(120_000, 0),
        b(140_000, 0),
        b(160_000, 0),
        b(180_000, 0),
        b(200_000, 0),
        b(null, 0),
      ],
    };
    const out = txt(knee);
    expect(out).toContain('CONTEXT DEGRADATION KNEE');
    expect(out).toMatch(/roughly double past 80k tokens/);
    expect(out).toContain('← knee'); // the marker lands on the 80k-100k row
    expect(out).toMatch(/\/compact before ~80k/); // the actionable takeaway
    expect(out).toContain('80k-100k'); // ramp labels the band edges
  });

  it('reports no sharp knee (a GOOD result) when nothing clears 2× baseline', () => {
    const knee: ContextKnee = {
      windowSessions: 50,
      sessionsWithSignal: 40,
      onsetTokens: null,
      buckets: [
        b(40_000, 200, 0, 10), // 0.05
        b(60_000, 200, 0, 12), // 0.06 — under 2×
        b(80_000, 200, 0, 14),
        b(100_000, 0),
        b(120_000, 0),
        b(140_000, 0),
        b(160_000, 0),
        b(180_000, 0),
        b(200_000, 0),
        b(null, 0),
      ],
    };
    const out = txt(knee);
    expect(out).toMatch(/no sharp knee/);
    expect(out).not.toContain('← knee');
    expect(out).not.toContain('/compact before'); // no false threshold to arm against
  });

  it('degrades to an honest "not enough telemetry" line below 2 sessions of signal', () => {
    const knee: ContextKnee = {
      windowSessions: 12,
      sessionsWithSignal: 1,
      onsetTokens: null,
      buckets: [b(40_000, 3, 0, 1), ...Array.from({ length: 9 }, () => b(null, 0))],
    };
    const out = txt(knee);
    expect(out).toMatch(/not enough per-turn telemetry/);
    expect(out).toContain('1 of 12');
  });
});
