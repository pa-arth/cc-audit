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
function session(spans: Span[], modes: string[] = [], source?: Session['source']): Session {
  return { sessionId: 's', project: 'p', cwd: null, mtime: 0, modes, spans, source };
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

  it('excludes Codex sessions from both sides — plan mode is unobservable there, not zero', () => {
    // A substantive Claude Code session that planned, plus several substantive
    // Codex sessions (modes: [] always — the adapter cannot see plan mode). Old
    // behavior: 1/4 = 0.25, understating the rate by diluting the denominator with
    // sessions that were never measured. New: Codex sessions excluded → 1/1 = 1.
    const ccPlan = session([work(6)], ['plan']);
    const codexSessions = Array.from({ length: 3 }, () => session([work(6)], [], 'codex'));
    const f = computeFluency([ccPlan, ...codexSessions]);
    expect(f.planModeRate).toBe(1);
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

describe('builder-profile metrics', () => {
  // Enriched turn builder: tools + fileOps for planning/autonomy/iteration signals.
  function bturn(tools: string[], fileOps: Array<{ tool: string; path: string }> = []): AssistantTurn {
    return {
      model: 'claude-sonnet-4-6',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      tools,
      fileOps,
      reads: [],
      thinkingChars: 0,
      textChars: 0,
      ts: null,
      mode: null,
      toolResultTs: null,
      toolErrorCount: 0,
    };
  }

  it('computes planningRatio as reads:writes, guarded against divide-by-zero', () => {
    const reads = session([span([bturn(['Read', 'Grep', 'Read'])])]); // 3 plan, 0 action
    expect(computeFluency([reads]).planningRatio).toBe(3); // 3 / max(1,0)
    const mixed = session([span([bturn(['Read', 'Read', 'Edit'])])]); // 2 plan, 1 action
    expect(computeFluency([mixed]).planningRatio).toBe(2);
  });

  it('computes autonomyScore per-span, not per-turn', () => {
    // 4 spans, one asks (twice in its span — still one hand-holding event).
    const asks = span([bturn(['AskUserQuestion']), bturn(['AskUserQuestion'])]);
    const quiet = () => span([bturn(['Edit'])]);
    const f = computeFluency([session([asks, quiet(), quiet(), quiet()])]);
    expect(f.autonomyScore).toBeCloseTo(0.75); // 1 − 1/4
  });

  it('autonomyScore is 1 with no AskUserQuestion (no NaN on zero asks)', () => {
    expect(computeFluency([session([span([bturn(['Edit'])])])]).autonomyScore).toBe(1);
  });

  it('computes iterationDepth as mean writes-per-file', () => {
    // a.ts written 3×, b.ts written 1× → mean 2.0
    const s = session([
      span([
        bturn(['Edit'], [{ tool: 'Edit', path: 'a.ts' }]),
        bturn(['Edit'], [{ tool: 'Edit', path: 'a.ts' }]),
        bturn(['Edit'], [{ tool: 'Edit', path: 'a.ts' }]),
        bturn(['Write'], [{ tool: 'Write', path: 'b.ts' }]),
      ]),
    ]);
    expect(computeFluency([s]).iterationDepth).toBe(2);
  });

  it('excludes sidechain turns from builder signals', () => {
    const own = span([bturn(['Read', 'Read'])]); // 2 plan tools
    const side = span([bturn(['Edit', 'Edit', 'Edit', 'Edit'])], { isSidechain: true }); // would skew action up
    const f = computeFluency([session([own, side])]);
    expect(f.planningRatio).toBe(2); // sidechain Edits ignored → 2 / max(1,0)
  });
});
