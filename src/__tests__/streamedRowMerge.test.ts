import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { sessionRedundancy } from '../fluency.js';

// Claude Code logs ONE streamed assistant message across MULTIPLE JSONL rows that share a
// single message.id: usage is repeated verbatim on every row, but the content blocks are
// PARTITIONED across them (thinking on one row, text on the next, the tool_use on a third).
// The old first-row-wins dedup kept only the first row's blocks and silently dropped every
// tool_use that arrived on a later row — measured ~60% of all file reads on real transcripts.
// These tests pin the fix: same-id rows MERGE (union blocks) while usage counts once.

const raw = (e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n');

// A single logical assistant message split into `blocksPerRow` rows sharing one id + usage.
function streamedMessage(
  id: string,
  rowsBlocks: Array<Array<Record<string, unknown>>>,
  usage = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
) {
  return rowsBlocks.map((content) => ({
    type: 'assistant',
    message: { id, model: 'claude-opus-4-8', usage, content },
  }));
}

const toolUse = (name: string, path: string, tid: string) => ({
  type: 'tool_use',
  name,
  id: tid,
  input: { file_path: path },
});

describe('streamed-row merge (same message.id spread across rows)', () => {
  it('unions tool_use blocks from later rows into one turn', () => {
    const events = [
      { type: 'user', promptId: 'p1', message: { content: 'edit then re-read' } },
      // One assistant message, three rows: thinking, then two separate Read tool_uses.
      ...streamedMessage('msg_A', [
        [{ type: 'thinking', thinking: 'planning...' }],
        [toolUse('Read', '/x/a.ts', 't1')],
        [toolUse('Read', '/x/b.ts', 't2')],
      ]),
    ];
    const s = parseTranscript('/tmp/s1.jsonl', raw(events), 'p')!;
    // Exactly ONE turn (rows merged, not three turns) with BOTH reads captured.
    const turns = s.spans.flatMap((sp) => sp.turns);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.fileOps?.map((o) => o.path).sort()).toEqual(['/x/a.ts', '/x/b.ts']);
    expect(turns[0]!.tools).toEqual(['Read', 'Read']);
    expect(turns[0]!.thinkingChars).toBeGreaterThan(0);
  });

  it('counts usage exactly once across merged rows (no triple bill)', () => {
    const usage = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 };
    const events = [
      { type: 'user', promptId: 'p1', message: { content: 'go' } },
      ...streamedMessage('msg_A', [
        [{ type: 'thinking', thinking: 'x' }],
        [toolUse('Read', '/x/a.ts', 't1')],
        [{ type: 'text', text: 'done' }],
      ], usage),
    ];
    const s = parseTranscript('/tmp/s2.jsonl', raw(events), 'p')!;
    const turns = s.spans.flatMap((sp) => sp.turns);
    expect(turns).toHaveLength(1);
    // Usage applied once — output 200, not 600.
    expect(turns[0]!.usage.output).toBe(200);
    expect(turns[0]!.usage.input).toBe(100);
  });

  it('recovers redundant re-reads that the old dedup dropped', () => {
    // Read a.ts (row of msg_A), then re-Read a.ts on a LATER row of the SAME message.id.
    // Under first-row-wins the second read vanished; now it's a detected redundant re-read.
    const events = [
      { type: 'user', promptId: 'p1', message: { content: 'reread same file' } },
      ...streamedMessage('msg_A', [
        [toolUse('Read', '/x/a.ts', 't1')], // first read — seeds residency
        [{ type: 'thinking', thinking: 'hmm' }],
        [toolUse('Read', '/x/a.ts', 't2')], // redundant re-read on a later row
      ]),
    ];
    const s = parseTranscript('/tmp/s3.jsonl', raw(events), 'p')!;
    const r = sessionRedundancy(s);
    expect(r.reads).toBe(2);
    expect(r.redundantReads).toBe(1);
  });

  it('registers tool_use ids from merged rows so tool_results still match back', () => {
    // The errored tool_use lives on the 2nd row of the message; its tool_result (a user row)
    // must still fold its is_error onto the turn — only possible if the merged row's id was
    // registered in turnByToolId.
    const events = [
      { type: 'user', promptId: 'p1', message: { content: 'run it' } },
      ...streamedMessage('msg_A', [
        [{ type: 'thinking', thinking: 'try' }],
        [{ type: 'tool_use', name: 'Bash', id: 'bash1', input: {} }],
      ]),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash1', is_error: true }] } },
    ];
    const s = parseTranscript('/tmp/s4.jsonl', raw(events), 'p')!;
    const turns = s.spans.flatMap((sp) => sp.turns);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolErrorCount).toBe(1);
  });

  it('still dedups the SAME message replayed across transcripts (resumed session)', () => {
    const seen = new Set<string>();
    const msg = streamedMessage('msg_shared', [
      [toolUse('Read', '/x/a.ts', 't1')],
      [toolUse('Read', '/x/b.ts', 't2')],
    ]);
    const first = [{ type: 'user', promptId: 'p1', message: { content: 'go' } }, ...msg];
    const second = [{ type: 'user', promptId: 'p1', message: { content: 'go' } }, ...msg];
    const s1 = parseTranscript('/tmp/first.jsonl', raw(first), 'p', seen)!;
    const s2 = parseTranscript('/tmp/second.jsonl', raw(second), 'p', seen);
    // First transcript owns the message (both reads merged into one turn); the resumed
    // replay contributes no turns → session is empty → null.
    expect(s1.spans.flatMap((sp) => sp.turns)).toHaveLength(1);
    expect(s1.spans.flatMap((sp) => sp.turns)[0]!.fileOps).toHaveLength(2);
    expect(s2).toBeNull();
  });
});
