import { describe, expect, it } from 'vitest';
import { buildFluencySheet, summarizeBands, type FluencyLabelRow } from '../labelFluency.js';
import { computeSessionFluencySignals, sessionRedundancy } from '../fluency.js';
import type { AssistantTurn, FileOp, Session, Span } from '../model.js';

function turn(model: string | null, over: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    model,
    usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    tools: [],
    thinkingChars: 0,
    textChars: 0,
    ...over,
  };
}
/** A turn that performs file ops, for redundant-read tests. */
function fileTurn(ops: FileOp[]): AssistantTurn {
  return turn('claude-opus-4-8', { fileOps: ops });
}
const read = (path: string): FileOp => ({ tool: 'Read', path });
const edit = (path: string): FileOp => ({ tool: 'Edit', path });
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
  it('captures per-session plan as binary, turn shape, and clean reads', () => {
    const s = session(
      [span([turn('claude-opus-4-8'), turn('claude-opus-4-8'), turn('claude-sonnet-4-6')]), span([turn('claude-sonnet-4-6')], { command: 'compact' })],
      ['plan'],
    );
    const sig = computeSessionFluencySignals(s);
    expect(sig.planModeRate).toBe(1);
    expect(sig.redundantReadRate).toBe(0); // no file reads at all → 0
    expect(sig.modelDiversity).toBe(2);
    expect(sig.premiumTurnShare).toBeCloseTo(2 / 4, 6);
  });

  it('flags a re-read of a path already in context, not the first read or distinct files', () => {
    const s = session([span([fileTurn([read('/a.ts'), read('/b.ts'), read('/a.ts')])])]);
    // 3 reads, 1 redundant (the second /a.ts) → 1/3.
    expect(computeSessionFluencySignals(s).redundantReadRate).toBeCloseTo(1 / 3, 6);
  });
});

describe('sessionRedundancy', () => {
  it('does not count a re-read AFTER a reset — the content is gone', () => {
    const s = session([
      span([fileTurn([read('/a.ts')])]),
      span([turn('claude-opus-4-8')], { command: 'compact' }),
      span([fileTurn([read('/a.ts')])]),
    ]);
    expect(sessionRedundancy(s).redundantReads).toBe(0);
  });

  it('marks read-after-own-edit as the cleanest waste', () => {
    const s = session([span([fileTurn([edit('/a.ts'), read('/a.ts')])])]);
    const r = sessionRedundancy(s);
    expect(r.redundantReads).toBe(1);
    expect(r.readAfterEdit).toBe(1);
  });

  it('ignores subagent (sidechain) file ops — redundancy is the operator’s habit', () => {
    const s = session([span([fileTurn([read('/a.ts'), read('/a.ts')])], { isSidechain: true })]);
    expect(sessionRedundancy(s).reads).toBe(0);
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
