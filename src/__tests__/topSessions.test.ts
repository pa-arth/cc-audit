import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { topSessions } from '../topSessions.js';

// Build a session with given spans; each span = {prompt, turns:[{outTokens,tools}]}.
function makeSession(
  id: string,
  spans: { prompt: string; promptId: string; turns: { out: number; tools?: string[] }[] }[],
  opts: { planMode?: boolean } = {},
) {
  const events: unknown[] = [];
  if (opts.planMode) events.push({ type: 'mode', mode: 'plan' });
  let a = 0;
  for (const sp of spans) {
    events.push({ type: 'user', promptId: sp.promptId, cwd: '/repo/x', message: { content: sp.prompt } });
    for (const t of sp.turns) {
      a += 1;
      events.push({
        type: 'assistant',
        message: {
          id: `a_${id}_${a}`,
          model: 'claude-opus-4-8',
          usage: { input_tokens: 100, output_tokens: t.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: (t.tools ?? []).map((name) => ({ type: 'tool_use', name })),
        },
      });
    }
  }
  return parseTranscript(`/tmp/ts-${id}.jsonl`, events.map((e) => JSON.stringify(e)).join('\n'), 'repo-x', new Set())!;
}

describe('topSessions — most expensive sessions leaderboard', () => {
  // A: cheap. B: most expensive (big output). C: medium, plan mode + 2 prompts + tools.
  const a = makeSession('a', [{ prompt: 'cheap small task here please', promptId: 'p', turns: [{ out: 100 }] }]);
  const b = makeSession('b', [{ prompt: 'the expensive monster task here', promptId: 'p', turns: [{ out: 50000 }, { out: 50000 }] }]);
  const c = makeSession(
    'c',
    [
      { prompt: 'first prompt of the session here', promptId: 'p1', turns: [{ out: 2000, tools: ['Edit', 'Bash'] }] },
      { prompt: 'second prompt here please', promptId: 'p2', turns: [{ out: 2000, tools: ['Edit', 'Read'] }] },
    ],
    { planMode: true },
  );
  const ranked = topSessions([a, b, c]);

  it('ranks by total cost, descending', () => {
    expect(ranked.map((r) => r.taskGist[0])).toBeDefined();
    expect(ranked[0]!.taskGist).toContain('expensive monster'); // B is priciest
    expect(ranked[0]!.costUsd).toBeGreaterThan(ranked[1]!.costUsd);
    expect(ranked[ranked.length - 1]!.costUsd).toBeLessThan(ranked[0]!.costUsd);
  });

  it('captures structure: turns, model, plan-mode, prompts, top tools', () => {
    const cRow = ranked.find((r) => r.taskGist.startsWith('first prompt'))!;
    expect(cRow.topModel).toBe('claude-opus-4-8');
    expect(cRow.turns).toBe(2);
    expect(cRow.prompts).toBe(2); // two user prompts
    expect(cRow.planMode).toBe(true);
    expect(cRow.trajectory.length).toBe(2); // one sparkline bar per prompt
    expect(cRow.topTools).toContain('Edit');
  });

  it('honors the N limit', () => {
    expect(topSessions([a, b, c], 2)).toHaveLength(2);
    expect(topSessions([a, b, c], 2)[0]!.taskGist).toContain('expensive monster');
  });

  it('falls back gracefully when a span has no real prompt text', () => {
    const harness = makeSession('h', [{ prompt: '<command-name>foo</command-name>', promptId: 'p', turns: [{ out: 100 }] }]);
    const row = topSessions([harness])[0]!;
    expect(typeof row.taskGist).toBe('string');
    expect(row.taskGist.length).toBeGreaterThan(0); // never empty/undefined
  });

  it('names the session by its priciest TASK, not the file-first prompt', () => {
    // Cheap opener, then a far more expensive unrelated task later in the same file.
    const s = makeSession('multi', [
      { prompt: 'tiny cleanup of the readme file', promptId: 'p1', turns: [{ out: 100 }] },
      { prompt: 'build the entire billing pipeline now', promptId: 'p2', turns: [{ out: 60000 }, { out: 60000 }] },
    ]);
    const row = topSessions([s])[0]!;
    expect(row.taskGist).toContain('billing pipeline'); // priciest task wins the headline
    expect(row.topPrompts).toHaveLength(2); // two distinct tasks priced
    expect(row.topPrompts[0]!.gist).toContain('billing pipeline');
    expect(row.topPrompts[0]!.costUsd).toBeGreaterThan(row.topPrompts[1]!.costUsd);
  });

  it('does not inherit a task label across a compaction boundary', () => {
    // A genuine prompt, then an auto-compaction continuation that opens a fresh context.
    // The post-compaction span must NOT borrow the pre-compaction task as its label.
    const s = parseTranscript(
      '/tmp/ts-compact.jsonl',
      [
        { type: 'user', promptId: 'p1', cwd: '/r', message: { content: 'set up the auth service from scratch' } },
        { type: 'assistant', message: { id: 'x1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } },
        { type: 'user', promptId: 'p2', isCompactSummary: true, message: { content: 'This session is being continued…' } },
        { type: 'user', promptId: 'p2', cwd: '/r', message: { content: 'ok continue' } },
        { type: 'assistant', message: { id: 'x2', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } },
      ].map((e) => JSON.stringify(e)).join('\n'),
      'r',
      new Set(),
    )!;
    const row = topSessions([s])[0]!;
    // Both tasks must remain SEPARATE priced lines — the expensive post-compaction work
    // ("ok continue", 50k out) must not be folded into the pre-compaction "auth service"
    // task. If the label inherited across the boundary they'd merge into one line.
    const byGist = new Map(row.topPrompts.map((p) => [p.gist, p]));
    expect(byGist.has('ok continue')).toBe(true);
    expect(byGist.has('set up the auth service from scratch')).toBe(true);
    // The priciest line is the post-compaction span, on its own — proof of no merge.
    expect(row.topPrompts[0]!.gist).toBe('ok continue');
    expect(row.topPrompts[0]!.turns).toBe(1);
  });
});
