import { describe, expect, it } from 'vitest';
import { computeFluency, localBand } from '../fluency.js';
import type { AssistantTurn, Session, Span } from '../model.js';

// Minimal builders — fluency reads only model/usage/isSidechain/command/modes/turns.
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
    promptId: 'p',
    command: null,
    invokedSkills: [],
    firstUserText: '',
    turns,
    isSidechain: false,
    attributionSkill: null,
    attributionAgent: null,
    ...over,
  };
}
function session(spans: Span[], modes: string[] = []): Session {
  return { sessionId: 's', project: 'p', cwd: null, mtime: 0, modes, spans };
}

// n turns on the given model, as one main-chain span.
const work = (n: number, model = 'claude-sonnet-4-6') =>
  span(Array.from({ length: n }, () => turn(model)));

describe('localBand', () => {
  it('maps crude score to a coarse 3-bucket band; Elite requires all good-directions', () => {
    expect(localBand({ score: 100 })).toBe('Elite');
    expect(localBand({ score: 90 })).toBe('Elite');
    expect(localBand({ score: 75 })).toBe('Strong'); // 3/4 good-directions is Strong, not Elite
    expect(localBand({ score: 50 })).toBe('Strong');
    expect(localBand({ score: 49 })).toBe('Developing');
    expect(localBand({ score: 25 })).toBe('Developing');
    expect(localBand({ score: 0 })).toBe('Developing');
  });
});

describe('planModeRate anti-gaming', () => {
  it('ignores trivial sessions on BOTH sides of the ratio', () => {
    // 5 throwaway 1-turn plan-mode sessions + 1 substantive non-plan session.
    // Old behavior: 5/6 ≈ 0.83. New: trivial excluded → 0 plan / 1 substantive = 0.
    const trivialPlans = Array.from({ length: 5 }, () => session([work(1)], ['plan']));
    const realNoPlan = session([work(6)]);
    const f = computeFluency([...trivialPlans, realNoPlan]);
    expect(f.planModeRate).toBe(0);
  });

  it('credits plan mode only on substantive sessions', () => {
    const realPlan = session([work(6)], ['plan']);
    const realNoPlan = session([work(6)]);
    const f = computeFluency([realPlan, realNoPlan]);
    expect(f.planModeRate).toBe(0.5); // 1 of 2 substantive sessions planned
  });
});

describe('perverse terms removed from the local score', () => {
  it('does not reward avoiding premium models or model diversity', () => {
    // Two corpora identical in the SCORED signals (plan, turns, /compact, subagent),
    // differing ONLY in model tier/diversity. The local score must not move — the
    // old `1 - premiumTurnShare` + `modelDiversity>1` terms are gone.
    const allHaikuOneModel = computeFluency([session([work(6, 'claude-haiku-4-5')], ['plan'])]);
    const allOpusTwoModels = computeFluency([
      session([span([turn('claude-opus-4-8'), turn('claude-sonnet-4-6'), ...Array(4).fill(turn('claude-opus-4-8'))])], ['plan']),
    ]);
    expect(allOpusTwoModels.premiumTurnShare).toBeGreaterThan(allHaikuOneModel.premiumTurnShare);
    expect(allOpusTwoModels.modelDiversity).toBeGreaterThan(allHaikuOneModel.modelDiversity);
    // …yet the score is unchanged by those two signals.
    expect(allOpusTwoModels.score).toBe(allHaikuOneModel.score);
  });
});
