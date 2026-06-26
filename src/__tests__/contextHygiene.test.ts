import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeContextHygiene } from '../contextHygiene.js';
import { turnCarryUsd } from '../fluency.js';

// Build an assistant event at a chosen context size (all cacheRead, so carry is easy to
// reason about) and optional file reads (for the working-set switch detector).
let mid = 0;
function asst(opts: { ctx?: number; reads?: string[]; model?: string } = {}) {
  const ctx = opts.ctx ?? 1000;
  mid += 1;
  return {
    type: 'assistant',
    message: {
      id: `m${mid}`,
      model: opts.model ?? 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
      content: (opts.reads ?? []).map((p) => ({ type: 'tool_use', name: 'Read', input: { file_path: p } })),
    },
  };
}
const user = (promptId: string, content: string) => ({ type: 'user', promptId, message: { content } });
// The auto-compaction marker: a user row carrying isCompactSummary + a promptId.
const wall = (promptId: string) => ({
  type: 'user',
  promptId,
  isCompactSummary: true,
  message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
});
const raw = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

describe('contextHygiene — missed /compact (overdue context)', () => {
  it('flags a sustained run above the line, located by turn ordinal, with conservative $', () => {
    // One span, 6 assistant turns all at 200K context (>160K line). Carry per turn for
    // opus cacheRead is 200000·$0.5/1e6 = $0.10; billable above-line fraction = 40/200.
    const events: unknown[] = [user('p1', 'do the big migration across the codebase')];
    for (let i = 0; i < 6; i += 1) events.push(asst({ ctx: 200_000 }));
    const s = parseTranscript('/tmp/ov.jsonl', raw(events), 'demo/proj')!;
    const h = computeContextHygiene([s]);

    expect(h.overdueEpisodes).toHaveLength(1);
    const e = h.overdueEpisodes[0]!;
    expect(e.atTurn).toBe(1); // crossed the line at the first turn
    expect(e.overdueTurns).toBe(6);
    expect(e.peakTokens).toBe(200_000);
    expect(e.project).toBe('demo/proj');
    // Conservative: only the carry on tokens ABOVE the line. 6 × $0.10 × (40k/200k) = $0.12.
    expect(e.avoidableUsd).toBeCloseTo(6 * turnCarryUsd('claude-opus-4-8', {
      input: 0, output: 0, cacheRead: 200_000, cacheWrite5m: 0, cacheWrite1h: 0,
    }) * (40_000 / 200_000), 6);
    expect(h.avoidableCompactUsd).toBeCloseTo(e.avoidableUsd, 9);
  });

  it('does NOT flag a short overdue spike (no runway for /compact to pay off)', () => {
    const events: unknown[] = [user('p1', 'quick thing')];
    for (let i = 0; i < 5; i += 1) events.push(asst({ ctx: 200_000 })); // 5 < MIN_OVERDUE_TURNS
    const h = computeContextHygiene([parseTranscript('/tmp/sp.jsonl', raw(events), 'p')!]);
    expect(h.overdueEpisodes).toHaveLength(0);
    expect(h.avoidableCompactUsd).toBe(0);
  });

  it('does NOT flag context that stays under the line', () => {
    const events: unknown[] = [user('p1', 'normal task')];
    for (let i = 0; i < 10; i += 1) events.push(asst({ ctx: 100_000 }));
    const h = computeContextHygiene([parseTranscript('/tmp/lo.jsonl', raw(events), 'p')!]);
    expect(h.overdueEpisodes).toHaveLength(0);
  });

  it('a /compact resets the segment so a run does not span across the reset', () => {
    // 4 overdue turns, then /compact, then 4 more overdue turns: two runs of 4, neither
    // clears the 6-turn bar — so the reset discipline is correctly credited.
    const events: unknown[] = [user('p1', 'big task')];
    for (let i = 0; i < 4; i += 1) events.push(asst({ ctx: 200_000 }));
    events.push(user('p2', '<command-name>compact</command-name>'));
    for (let i = 0; i < 4; i += 1) events.push(asst({ ctx: 200_000 }));
    const h = computeContextHygiene([parseTranscript('/tmp/rs.jsonl', raw(events), 'p')!]);
    expect(h.overdueEpisodes).toHaveLength(0);
  });
});

describe('contextHygiene — ran to the wall (auto-compaction ground truth)', () => {
  it('counts isCompactSummary spans and the sessions that hit the wall', () => {
    const events = [
      user('p1', 'start a long session'),
      asst({ ctx: 50_000 }),
      wall('p2'), // auto-compaction continuation
      asst({ ctx: 30_000 }),
      wall('p3'), // hit the wall again
      asst({ ctx: 30_000 }),
    ];
    const h = computeContextHygiene([parseTranscript('/tmp/wall.jsonl', raw(events), 'p')!]);
    expect(h.autoCompactions).toBe(2);
    expect(h.sessionsRunToWall).toBe(1);
  });

  it('the auto-compaction summary never becomes a task gist (no machine prose leak)', () => {
    const s = parseTranscript('/tmp/w2.jsonl', raw([wall('p1'), asst({ ctx: 1000 })]), 'p')!;
    const compactSpan = s.spans.find((sp) => sp.autoCompacted)!;
    expect(compactSpan.firstUserText).toBe('');
    expect(compactSpan.autoCompacted).toBe(true);
  });
});

describe('contextHygiene — missed /clear (stale carry across a task switch)', () => {
  it('flags a full file-working-set rotation with non-trivial context, located by turn', () => {
    // Turns 0-3 work fileA/fileB; turns 4-8 work fileC/fileD; context 50K throughout
    // (above the 40K stale floor). Zero file overlap across the k=4 boundary.
    const events: unknown[] = [user('p1', 'two unrelated tasks in one session')];
    for (let i = 0; i < 4; i += 1) events.push(asst({ ctx: 50_000, reads: i % 2 === 0 ? ['a/fileA.ts'] : ['a/fileB.ts'] }));
    for (let i = 0; i < 5; i += 1) events.push(asst({ ctx: 50_000, reads: i % 2 === 0 ? ['a/fileC.ts'] : ['a/fileD.ts'] }));
    const h = computeContextHygiene([parseTranscript('/tmp/sw.jsonl', raw(events), 'p')!]);
    expect(h.staleCarrySwitches).toHaveLength(1);
    expect(h.staleCarrySwitches[0]!.atTurn).toBe(5);
    expect(h.staleCarrySwitches[0]!.staleTokens).toBe(50_000);
    expect(h.avoidableClearUsd).toBeGreaterThan(0);
  });

  it('does NOT flag when the working set overlaps (same task continues)', () => {
    const events: unknown[] = [user('p1', 'one continuous task')];
    for (let i = 0; i < 9; i += 1) events.push(asst({ ctx: 50_000, reads: ['a/fileA.ts', 'a/fileB.ts'] }));
    const h = computeContextHygiene([parseTranscript('/tmp/cont.jsonl', raw(events), 'p')!]);
    expect(h.staleCarrySwitches).toHaveLength(0);
  });
});
