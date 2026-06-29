import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeFriction } from '../friction.js';

let mid = 0;
function asst(opts: { tools?: Array<{ name: string; id?: string; path?: string }> } = {}) {
  mid += 1;
  const content = (opts.tools ?? []).map((t) => ({
    type: 'tool_use',
    name: t.name,
    id: t.id ?? `t${mid}`,
    input: t.path ? { file_path: t.path } : undefined,
  }));
  return {
    type: 'assistant',
    message: {
      id: `m${mid}`,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      content,
    },
  };
}
const user = (promptId: string, content: string) => ({ type: 'user', promptId, message: { content } });
const toolResult = (toolId: string, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError }] },
});
const raw = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

describe('computeFriction', () => {
  it('counts an errored tool_result and attributes it to the span skill', () => {
    const s = parseTranscript(
      '/tmp/f.jsonl',
      raw([
        user('p1', '<command-name>deploy</command-name>'),
        asst({ tools: [{ name: 'Bash', id: 'b1' }] }),
        toolResult('b1', true),
      ]),
      'proj',
    )!;
    const fr = computeFriction([s]);
    expect(fr.totalToolErrors).toBe(1);
    const row = fr.bySkill.find((r) => r.skill === 'deploy')!;
    expect(row.toolErrors).toBe(1);
  });

  it('counts an immediate re-edit of the same path as a self-correction', () => {
    const s = parseTranscript(
      '/tmp/f2.jsonl',
      raw([
        user('p1', 'fix the file'),
        asst({ tools: [{ name: 'Edit', id: 'e1', path: '/x/a.ts' }] }),
        asst({ tools: [{ name: 'Edit', id: 'e2', path: '/x/a.ts' }] }),
      ]),
      'proj',
    )!;
    expect(computeFriction([s]).totalSelfCorrections).toBe(1);
  });

  it('counts a re-edit after an intervening error as a self-correction', () => {
    const s = parseTranscript(
      '/tmp/f3.jsonl',
      raw([
        user('p1', 'fix the file'),
        asst({ tools: [{ name: 'Edit', id: 'e1', path: '/x/a.ts' }] }),
        asst({ tools: [{ name: 'Bash', id: 'b1' }] }),
        toolResult('b1', true),
        asst({ tools: [{ name: 'Edit', id: 'e2', path: '/x/a.ts' }] }),
      ]),
      'proj',
    )!;
    expect(computeFriction([s]).totalSelfCorrections).toBe(1);
  });

  it('does NOT count far-apart edits of the same path', () => {
    const s = parseTranscript(
      '/tmp/f4.jsonl',
      raw([
        user('p1', 'work'),
        asst({ tools: [{ name: 'Edit', id: 'e1', path: '/x/a.ts' }] }),
        asst({ tools: [{ name: 'Read', id: 'r1' }] }),
        asst({ tools: [{ name: 'Read', id: 'r2' }] }),
        asst({ tools: [{ name: 'Edit', id: 'e2', path: '/x/a.ts' }] }), // 3 turns later, no error
      ]),
      'proj',
    )!;
    expect(computeFriction([s]).totalSelfCorrections).toBe(0);
  });

  it('counts a run of consecutive errored turns on the same tool as ONE retry-loop', () => {
    const s = parseTranscript(
      '/tmp/f5.jsonl',
      raw([
        user('p1', 'run it'),
        asst({ tools: [{ name: 'Bash', id: 'b1' }] }),
        toolResult('b1', true),
        asst({ tools: [{ name: 'Bash', id: 'b2' }] }),
        toolResult('b2', true),
        asst({ tools: [{ name: 'Bash', id: 'b3' }] }),
        toolResult('b3', true),
      ]),
      'proj',
    )!;
    expect(computeFriction([s]).totalRetryLoops).toBe(1);
  });

  it('attributes sidechain friction via attributionSkill', () => {
    const s = parseTranscript(
      '/tmp/f6.jsonl',
      raw([
        { type: 'user', isSidechain: true, agentId: 'a', attributionSkill: 'deep-research', message: { content: 'go' } },
        {
          type: 'assistant',
          isSidechain: true,
          agentId: 'a',
          attributionSkill: 'deep-research',
          message: {
            id: 'sm1',
            model: 'claude-opus-4-8',
            usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
            content: [{ type: 'tool_use', name: 'Bash', id: 'sb1' }],
          },
        },
        toolResult('sb1', true),
      ]),
      'proj',
    )!;
    const row = computeFriction([s]).bySkill.find((r) => r.skill === 'deep-research')!;
    expect(row.toolErrors).toBe(1);
  });
});
