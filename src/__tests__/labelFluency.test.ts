import { describe, expect, it } from 'vitest';
import {
  buildFluencySheet,
  fitFluencyWeights,
  subScores,
  type FluencyLabelRow,
} from '../labelFluency.js';
import { computeSessionFluencySignals, type SessionFluencySignals } from '../fluency.js';
import type { AssistantTurn, Session, Span } from '../model.js';

function turn(model: string | null): AssistantTurn {
  return {
    model,
    usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    tools: [],
    thinkingChars: 0,
    textChars: 0,
  };
}
function span(turns: AssistantTurn[], over: Partial<Span> = {}): Span {
  return {
    promptId: 'p', command: null, invokedSkills: [], firstUserText: 'do a thing',
    turns, isSidechain: false, attributionSkill: null, attributionAgent: null, ...over,
  };
}
function session(spans: Span[], modes: string[] = []): Session {
  return { sessionId: 's', project: 'p', cwd: null, mtime: 0, modes, spans };
}

describe('computeSessionFluencySignals', () => {
  it('captures per-session plan/compact as binary and turn shape', () => {
    const s = session(
      [span([turn('claude-opus-4-8'), turn('claude-opus-4-8'), turn('claude-sonnet-4-6')]), span([turn('claude-sonnet-4-6')], { command: 'compact' })],
      ['plan'],
    );
    const sig = computeSessionFluencySignals(s);
    expect(sig.planModeRate).toBe(1);
    expect(sig.contextBloatRate).toBe(1);
    expect(sig.modelDiversity).toBe(2);
    expect(sig.premiumTurnShare).toBeCloseTo(2 / 4, 6); // 2 opus of 4 turns
  });
});

describe('buildFluencySheet', () => {
  it('keeps only substantive sessions (>=3 own turns) and redacts the gist', () => {
    const trivial = session([span([turn('claude-sonnet-4-6')], { firstUserText: 'hi' })]);
    const real = session([span([turn('claude-opus-4-8'), turn('claude-opus-4-8'), turn('claude-opus-4-8')], { firstUserText: 'fix the   broken\nparser' })]);
    const sheet = buildFluencySheet([trivial, real]);
    expect(sheet.length).toBe(1);
    expect(sheet[0]!.taskGist).toBe('fix the broken parser'); // whitespace collapsed
    expect(sheet[0]!.trueFluency).toBeNull();
  });
});

describe('fitFluencyWeights', () => {
  it('returns null below 5 labeled rows', () => {
    expect(fitFluencyWeights([])).toBeNull();
  });

  it('recovers known weights from synthetic labels', () => {
    const W = [0.5, 0.3, 0.2, 0.0]; // plan, turn, context, leverage
    // Vary signals so the sub-scores span their range.
    const grid: SessionFluencySignals[] = [];
    for (const plan of [0, 1])
      for (const median of [1, 3, 10, 20])
        for (const ctx of [0, 1])
          for (const sub of [0, 0.2]) {
            grid.push({ planModeRate: plan, medianTurnsPerTask: median, p90TurnsPerTask: median * 3, premiumTurnShare: 0.5, modelDiversity: 2, subagentUsageRate: sub, contextBloatRate: ctx });
          }
    const rows: FluencyLabelRow[] = grid.map((signals, id) => {
      const ss = subScores(signals);
      const trueFluency = 100 * (W[0]! * ss[0] + W[1]! * ss[1] + W[2]! * ss[2] + W[3]! * ss[3]);
      return { id, taskGist: '', topModel: 'x', totalTurns: 3, costUsd: 0, signals, trueFluency };
    });
    const fit = fitFluencyWeights(rows)!;
    expect(fit).not.toBeNull();
    expect(fit.r2).toBeGreaterThan(0.98); // near-perfect on noiseless synthetic data
    expect(fit.weights.plan).toBeCloseTo(0.5, 1);
    expect(fit.weights.turn).toBeCloseTo(0.3, 1);
    expect(fit.weights.leverage).toBeCloseTo(0.0, 1);
  });
});
