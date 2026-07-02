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

describe('contextHygiene — missed /compact (overdue via the compact counterfactual)', () => {
  it('flags a sustained run where compacting nets positive, located by turn ordinal, with conservative $', () => {
    // One span, 20 assistant turns all at 200K context. With the default 0.35 compression
    // ratio and opus cache rates, a /compact pays off only while enough runway remains:
    //   net(t) = tokensShed·cacheRead·remaining − (ctx·cacheRead + postCompact·cacheWrite)
    // For 200K opus that's net(t) > 0 ⇔ remaining ≥ 9 ⇔ t ≤ 10 (0-indexed), so turns 1..11
    // are overdue and 12..20 are not (the tail can no longer justify re-caching the summary).
    const events: unknown[] = [user('p1', 'do the big migration across the codebase')];
    for (let i = 0; i < 20; i += 1) events.push(asst({ ctx: 200_000 }));
    const s = parseTranscript('/tmp/ov.jsonl', raw(events), 'demo/proj')!;
    const h = computeContextHygiene([s]);

    expect(h.overdueEpisodes).toHaveLength(1);
    const e = h.overdueEpisodes[0]!;
    expect(e.atTurn).toBe(1); // compacting pays off from the very first turn (most runway)
    expect(e.overdueTurns).toBe(11);
    expect(e.peakTokens).toBe(200_000);
    expect(e.project).toBe('demo/proj');
    // Conservative: carry on the sheddable fraction (1 − 0.35). 11 turns × $0.10 × 0.65.
    const carry = turnCarryUsd('claude-opus-4-8', {
      input: 0, output: 0, cacheRead: 200_000, cacheWrite5m: 0, cacheWrite1h: 0,
    });
    expect(e.avoidableUsd).toBeCloseTo(11 * carry * (1 - 0.35), 6);
    expect(h.avoidableCompactUsd).toBeCloseTo(e.avoidableUsd, 9);
  });

  it('does NOT flag a short run — no runway for a /compact to pay for its re-cache cost', () => {
    // 6 turns at 200K: the OLD fixed-160K line would have flagged this; the counterfactual
    // does not, because compacting a 6-turn tail never recovers its summarization cost.
    const events: unknown[] = [user('p1', 'quick thing')];
    for (let i = 0; i < 6; i += 1) events.push(asst({ ctx: 200_000 }));
    const h = computeContextHygiene([parseTranscript('/tmp/sp.jsonl', raw(events), 'p')!]);
    expect(h.overdueEpisodes).toHaveLength(0);
    expect(h.avoidableCompactUsd).toBe(0);
  });

  it('does NOT flag a modest-length session at moderate context', () => {
    const events: unknown[] = [user('p1', 'normal task')];
    for (let i = 0; i < 10; i += 1) events.push(asst({ ctx: 100_000 }));
    const h = computeContextHygiene([parseTranscript('/tmp/lo.jsonl', raw(events), 'p')!]);
    expect(h.overdueEpisodes).toHaveLength(0);
  });

  it('a /compact resets the segment so a run does not span across the reset', () => {
    // Two 10-turn segments at 200K split by /compact: each segment alone is too short for
    // the counterfactual to net positive across, so the reset discipline is credited.
    const events: unknown[] = [user('p1', 'big task')];
    for (let i = 0; i < 10; i += 1) events.push(asst({ ctx: 200_000 }));
    events.push(user('p2', '<command-name>compact</command-name>'));
    for (let i = 0; i < 10; i += 1) events.push(asst({ ctx: 200_000 }));
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
