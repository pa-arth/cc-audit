import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { buildFootprints } from '../footprint.js';

// A premium prompt-driven span (Opus) + a cheap span + a slash-command span.
const FIXTURE = [
  { type: 'user', promptId: 'p1', message: { content: 'add a rate limiter to the upload endpoint' } },
  {
    type: 'assistant',
    message: {
      id: 'm1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', name: 'Edit' }, { type: 'tool_use', name: 'Bash' }],
    },
  },
  { type: 'user', promptId: 'p2', message: { content: '<command-message>commit-push-pr</command-message>' } },
  {
    type: 'assistant',
    message: { id: 'm2', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] },
  },
  { type: 'user', promptId: 'p3', message: { content: 'what time is it in tokyo' } },
  {
    type: 'assistant',
    message: { id: 'm3', model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

describe('buildFootprints', () => {
  const session = parseTranscript('/tmp/fp.jsonl', FIXTURE, 'secret/repo', new Set())!;
  const footprints = buildFootprints([session]);

  it('keeps only premium, prompt-driven spans (skips slash-command + non-premium)', () => {
    expect(footprints).toHaveLength(1); // p1 only — p2 is a command, p3 is haiku
    expect(footprints[0]!.taskGist).toContain('rate limiter');
    expect(footprints[0]!.model).toBe('claude-opus-4-8');
    expect(footprints[0]!.fileCount).toBe(1); // one Edit
    expect(footprints[0]!.tools).toMatchObject({ Edit: 1, Bash: 1 });
    expect(footprints[0]!.costUsd).toBeGreaterThan(0);
  });

  it('drops continuation-fragment spans (not judgeable as standalone tasks)', () => {
    const CONT = [
      { type: 'user', promptId: 'c1', message: { content: 'ok continue' } },
      {
        type: 'assistant',
        message: { id: 'cm1', model: 'claude-opus-4-8', usage: { input_tokens: 9000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', name: 'Edit' }] },
      },
      { type: 'user', promptId: 'c2', message: { content: "let's do only 2" } },
      {
        type: 'assistant',
        message: { id: 'cm2', model: 'claude-opus-4-8', usage: { input_tokens: 9000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const sess = parseTranscript('/tmp/cont.jsonl', CONT, 'x/y', new Set())!;
    expect(buildFootprints([sess])).toHaveLength(0); // both are continuations
  });

  it('carries only task gist + structural metadata — never code/paths/repo names', () => {
    const fp = footprints[0]!;
    expect(Object.keys(fp).sort()).toEqual(['costUsd', 'fileCount', 'model', 'taskGist', 'tools', 'turns']);
    const blob = JSON.stringify(footprints);
    expect(blob).not.toContain('secret/repo'); // no project/repo name
    expect(blob).not.toContain('/tmp/fp.jsonl'); // no path
  });
});
