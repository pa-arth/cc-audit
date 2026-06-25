import { describe, expect, it } from 'vitest';
import { buildFluencySheet, summarizeBands, type FluencyLabelRow } from '../labelFluency.js';
import { computeSessionFluencySignals } from '../fluency.js';
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
    expect(sig.premiumTurnShare).toBeCloseTo(2 / 4, 6);
  });
});

describe('buildFluencySheet', () => {
  it('keeps substantive sessions, shows the redacted prompt trajectory, trueBand null', () => {
    const trivial = session([span([turn('claude-sonnet-4-6')], { firstUserText: 'hi' })]);
    const real = session([
      span([turn('claude-opus-4-8'), turn('claude-opus-4-8'), turn('claude-opus-4-8')], { firstUserText: 'fix the   broken\nparser' }),
      span([turn('claude-opus-4-8')], { firstUserText: 'now add a test\n```js\ncode here\n```' }),
    ]);
    const sheet = buildFluencySheet([trivial, real]);
    expect(sheet.length).toBe(1);
    expect(sheet[0]!.promptTrajectory).toEqual(['fix the broken parser', 'now add a test [code]']);
    expect(sheet[0]!.taskGist).toBe('fix the broken parser');
    expect(sheet[0]!.trueBand).toBeNull();
  });
});

describe('summarizeBands', () => {
  it('counts labeled bands and skips unlabeled / invalid', () => {
    const rows = [
      { trueBand: 'Poor' },
      { trueBand: 'Elite' },
      { trueBand: 'Elite' },
      { trueBand: null },
      { trueBand: 'nonsense' },
    ] as unknown as FluencyLabelRow[];
    const s = summarizeBands(rows);
    expect(s.labeled).toBe(3);
    expect(s.unlabeled).toBe(2);
    expect(s.counts.Elite).toBe(2);
    expect(s.counts.Poor).toBe(1);
  });
});
