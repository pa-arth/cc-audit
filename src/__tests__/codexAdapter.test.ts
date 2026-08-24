import { describe, it, expect } from 'vitest';
import { parseRollout, toTurnUsage } from '../adapters/codex.js';
import { allTurns } from '../model.js';
import { turnCostTariffs, turnTokens } from '../pricing.js';

// Codex adapter. The fixtures below are hand-built to the shapes observed in real
// `~/.codex/sessions/**/rollout-*.jsonl` files, with two deliberate departures from
// what the local corpus happens to contain:
//
//   - `cache_write_input_tokens` is NONZERO here. All 2504 real rows report 0, so a
//     fixture copied from disk would exercise the write path not at all — and would
//     have passed just as happily before the write rate existed.
//   - the duplicate `token_count` is NOT adjacent to the row it repeats. Real repeats
//     sit at gaps of 0 to 7 records, and the non-adjacent ones are the whole reason
//     the buffer survives a suppression.

const line = (o: unknown): string => JSON.stringify(o);

const meta = (over: Record<string, unknown> = {}) =>
  line({
    timestamp: '2026-08-03T20:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '019fc955-865e-73e1-871a-64d53220a47e',
      cwd: '/Users/dev/repos/widget',
      originator: 'codex-tui',
      cli_version: '0.146.0',
      model_provider: 'openai',
      thread_source: 'user',
      ...over,
    },
  });

const taskStarted = (turnId: string, ts: string) =>
  line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 258400 } });

const turnContext = (turnId: string, model: string) =>
  line({ timestamp: '2026-08-03T20:00:01.000Z', type: 'turn_context', payload: { turn_id: turnId, model, effort: 'medium', cwd: '/Users/dev/repos/widget' } });

const userMessage = (message: string) =>
  line({ timestamp: '2026-08-03T20:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message, images: null, local_images: [] } });

const agentMessage = (message: string) =>
  line({ timestamp: '2026-08-03T20:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message, phase: null } });

// Reasoning as Codex actually ships it: encrypted, with an EMPTY summary array.
const reasoning = () =>
  line({ timestamp: '2026-08-03T20:00:03.500Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAAAB' + 'x'.repeat(400) } });

const toolCall = (name: string, callId: string, status = 'completed') =>
  line({ timestamp: '2026-08-03T20:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: callId, status, input: 'cat src/secret.ts' } });

const toolOutput = (callId: string, ts = '2026-08-03T20:00:05.000Z') =>
  line({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: 'THE ENTIRE FILE CONTENTS THAT MUST NOT BE RETAINED' } });

const patchApplied = (callId: string, paths: string[], success = true) =>
  line({
    timestamp: '2026-08-03T20:00:06.000Z',
    type: 'event_msg',
    payload: {
      type: 'patch_apply_end',
      call_id: callId,
      turn_id: 't1',
      stdout: 'Success. Updated the following files:\nM a.ts\n',
      stderr: '',
      success,
      status: 'completed',
      changes: Object.fromEntries(paths.map((p) => [p, { type: 'update', unified_diff: '@@ -1 +1 @@\n-old secret\n+new secret\n', move_path: null }])),
    },
  });

interface Usage {
  input: number;
  cached?: number;
  write?: number;
  output?: number;
  reasoning?: number;
}
const tokenCount = (u: Usage, ts = '2026-08-03T20:00:07.000Z') =>
  line({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
        last_token_usage: {
          input_tokens: u.input,
          cached_input_tokens: u.cached ?? 0,
          cache_write_input_tokens: u.write ?? 0,
          output_tokens: u.output ?? 0,
          reasoning_output_tokens: u.reasoning ?? 0,
          total_tokens: u.input + (u.output ?? 0),
        },
        model_context_window: 258400,
      },
      rate_limits: { limit_id: 'codex', plan_type: 'team' },
    },
  });

const taskComplete = (turnId: string) =>
  line({ timestamp: '2026-08-03T20:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, duration_ms: 6249, started_at: 1785789403, completed_at: 1785789409 } });

const compacted = () => line({ timestamp: '2026-08-03T20:00:09.000Z', type: 'compacted', payload: { message: '', replacement_history: [], window_id: 'w2', window_number: 2 } });

describe('toTurnUsage — Codex subsets to additive buckets', () => {
  it('subtracts the cache buckets out of the reported input total', () => {
    // Codex: input_tokens is the TOTAL, cached/write are subsets of it.
    const u = toTurnUsage({ input_tokens: 10_000, cached_input_tokens: 6_000, cache_write_input_tokens: 1_000, output_tokens: 500 });
    expect(u).toEqual({ input: 3_000, output: 500, cacheRead: 6_000, cacheWrite5m: 1_000, cacheWrite1h: 0 });
    // The buckets reconstruct the vendor's total exactly — nothing invented, nothing lost.
    expect(u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h).toBe(10_000);
  });

  it('reading input_tokens straight through would double-count every cached token', () => {
    // The bug this conversion exists to prevent, stated as arithmetic: cacheRead is by
    // far the largest bucket in a real Codex file (303M of 313M across the local corpus),
    // so billing it at the full input rate as well is not a rounding error.
    const u = toTurnUsage({ input_tokens: 10_000, cached_input_tokens: 9_000 });
    const correct = turnCostTariffs('gpt-5.6-sol', u).usd;
    const naive = turnCostTariffs('gpt-5.6-sol', { ...u, input: 10_000 }).usd;
    // The overcharge is exactly the cached tokens billed a SECOND time at the full
    // uncached rate — stated as arithmetic rather than as a magic multiple, so the
    // assertion says what the bug is instead of just that the numbers differ.
    expect(naive - correct).toBeCloseTo((9_000 * 4) / 1_000_000, 12);
    expect(naive / correct).toBeGreaterThan(5);
  });

  it('clamps rather than emitting a negative input bucket', () => {
    // The subset reading held on all 2504 local rows. If a future format made it false,
    // an unclamped subtraction would produce negative input — money credited back.
    const u = toTurnUsage({ input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 90 });
    expect(u.input).toBe(0);
    expect(u.cacheRead).toBe(90);
    expect(u.cacheWrite5m).toBe(10);
    expect(u.input + u.cacheRead + u.cacheWrite5m).toBe(100);
  });

  it('treats absent fields as zero, not NaN', () => {
    expect(toTurnUsage({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(turnTokens(toTurnUsage({ input_tokens: 5 }))).toBe(5);
  });
});

describe('parseRollout', () => {
  const raw = [
    meta(),
    taskStarted('t1', '2026-08-03T20:00:00.500Z'),
    turnContext('t1', 'gpt-5.6-sol'),
    userMessage('add a retry to the widget fetcher'),
    reasoning(),
    agentMessage('Looking at the fetcher now.'),
    toolCall('exec', 'call_a'),
    toolOutput('call_a'),
    tokenCount({ input: 10_000, cached: 6_000, write: 1_000, output: 200 }),
    // A tool call, THEN a repeated usage row. The call belongs to the request that
    // follows, not the one already recorded.
    toolCall('apply_patch', 'call_b'),
    patchApplied('call_b', ['/Users/dev/repos/widget/src/fetch.ts', '/Users/dev/repos/widget/src/retry.ts']),
    tokenCount({ input: 10_000, cached: 6_000, write: 1_000, output: 200 }),
    tokenCount({ input: 12_000, cached: 9_000, output: 300 }),
    taskComplete('t1'),
    compacted(),
    taskStarted('t2', '2026-08-03T20:10:00.000Z'),
    turnContext('t2', 'gpt-5.5'),
    userMessage('/review the diff please'),
    tokenCount({ input: 4_000, cached: 1_000, output: 50 }),
    taskComplete('t2'),
  ].join('\n');

  const session = parseRollout('/Users/dev/.codex/sessions/2026/08/03/rollout-x.jsonl', raw)!;

  it('reads the session identity off session_meta, not the filename', () => {
    expect(session).not.toBeNull();
    expect(session.sessionId).toBe('019fc955-865e-73e1-871a-64d53220a47e');
    expect(session.source).toBe('codex');
    expect(session.cwd).toBe('/Users/dev/repos/widget');
    expect(session.project).toBe('repos/widget');
    expect(session.parentSessionId).toBeNull();
  });

  it('opens one span per task and carries the prompt gist and command', () => {
    expect(session.spans).toHaveLength(2);
    expect(session.spans[0]!.promptId).toBe('t1');
    expect(session.spans[0]!.firstUserText).toBe('add a retry to the widget fetcher');
    expect(session.spans[0]!.command).toBeNull();
    // A leading slash is normalized away, matching the Claude Code adapter so both
    // rails bucket the same command name.
    expect(session.spans[1]!.command).toBe('review');
    expect(session.spans[0]!.isSidechain).toBe(false);
  });

  it('closes a turn on each token_count and attributes the model per turn', () => {
    const turns = allTurns(session);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.5']);
    expect(turns[0]!.usage).toEqual({ input: 3_000, output: 200, cacheRead: 6_000, cacheWrite5m: 1_000, cacheWrite1h: 0 });
    expect(turns[1]!.usage).toEqual({ input: 3_000, output: 300, cacheRead: 9_000, cacheWrite5m: 0, cacheWrite1h: 0 });
  });

  it('suppresses a repeated usage row and keeps its gap content for the NEXT turn', () => {
    const turns = allTurns(session);
    // Three token_count rows, four emitted — the repeat is not a fourth turn.
    expect(turns).toHaveLength(3);
    // The exec that preceded the first row stayed on turn 1...
    expect(turns[0]!.tools).toEqual(['exec']);
    // ...and the apply_patch issued in the gap landed on turn 2, not folded backward.
    expect(turns[1]!.tools).toEqual(['apply_patch']);
    expect(turns[0]!.fileOps).toEqual([]);
    expect(turns[1]!.fileOps).toHaveLength(2);
  });

  it('keeps patch PATHS and never the diff body', () => {
    const t = allTurns(session)[1]!;
    expect(t.fileOps!.map((f) => f.path)).toEqual([
      '/Users/dev/repos/widget/src/fetch.ts',
      '/Users/dev/repos/widget/src/retry.ts',
    ]);
    expect(t.fileOps!.every((f) => f.tool === 'apply_patch')).toBe(true);
    // The privacy invariant, asserted on the parsed object rather than trusted: no
    // field anywhere on the session may carry the diff text or the tool output.
    const dumped = JSON.stringify(session);
    expect(dumped).not.toContain('unified_diff');
    expect(dumped).not.toContain('new secret');
    expect(dumped).not.toContain('MUST NOT BE RETAINED');
  });

  it('flags the span that opened after a compaction', () => {
    expect(session.spans[0]!.autoCompacted).toBe(false);
    expect(session.spans[1]!.autoCompacted).toBe(true);
  });

  it('leaves the unobservable axes ABSENT rather than zeroed-as-measured', () => {
    // These are the fields the rail cannot see. The assertions exist so that anyone
    // later reading a 0 here goes and finds out why instead of trusting it.
    for (const t of allTurns(session)) {
      expect(t.thinkingChars).toBe(0); // reasoning is encrypted_content
      expect(t.reads).toEqual([]); // Codex has no Read tool
      expect(t.mode).toBeNull(); // Codex has no plan mode
    }
    expect(session.modes).toEqual([]);
    // Absent, NOT a zeroed InjectedPrefix — the turn-1 prefix was never measured, and
    // a zeroed one would read as "measured, and nothing was injected".
    expect(session.injected).toBeUndefined();
  });

  it('records tool results as a timestamp only', () => {
    const t = allTurns(session)[0]!;
    expect(t.toolResultTs).toBe(Date.parse('2026-08-03T20:00:05.000Z'));
    expect(t.toolErrorCount).toBe(0);
  });

  it('counts an explicit tool failure and a failed patch', () => {
    const s = parseRollout(
      '/r/rollout-y.jsonl',
      [
        meta(),
        taskStarted('t1', '2026-08-03T20:00:00.500Z'),
        turnContext('t1', 'gpt-5.6-sol'),
        userMessage('try the thing that will not work'),
        toolCall('exec', 'call_a', 'failed'),
        patchApplied('call_b', ['/w/a.ts'], false),
        tokenCount({ input: 100, output: 10 }),
      ].join('\n'),
    )!;
    expect(allTurns(s)[0]!.toolErrorCount).toBe(2);
  });

  it('returns null for a rollout with no model request', () => {
    const s = parseRollout('/r/rollout-z.jsonl', [meta(), taskStarted('t1', '2026-08-03T20:00:00.500Z'), userMessage('never answered')].join('\n'));
    expect(s).toBeNull();
  });

  it('skips malformed lines instead of failing the file', () => {
    const s = parseRollout(
      '/r/rollout-m.jsonl',
      [meta(), '{ this is not json', '', taskStarted('t1', '2026-08-03T20:00:00.500Z'), turnContext('t1', 'gpt-5.5'), tokenCount({ input: 100, output: 10 })].join('\n'),
    )!;
    expect(allTurns(s)).toHaveLength(1);
  });
});

describe('parseRollout — subagent threads', () => {
  it('models a subagent thread as a sidechain with a parent link', () => {
    // Codex gives a subagent its own file with thread_source 'subagent', where Claude
    // Code inlines sidechain rows into the parent transcript. Both must end up as
    // isSidechain spans with a parentSessionId, or `concurrencyKey` counts one session
    // as two and the subagent's spend goes unattributed.
    const s = parseRollout(
      '/r/rollout-sub.jsonl',
      [
        meta({ thread_source: 'subagent', parent_thread_id: '019fc955-853f-7793-bcd6-d725698b08d2', source: { subagent: { other: 'guardian' } } }),
        taskStarted('t1', '2026-08-03T20:00:00.500Z'),
        turnContext('t1', 'codex-auto-review'),
        userMessage('The following is the Codex agent history added since your last assessment.'),
        tokenCount({ input: 17_677, cached: 4_864, output: 157, reasoning: 95 }),
      ].join('\n'),
    )!;
    expect(s.parentSessionId).toBe('019fc955-853f-7793-bcd6-d725698b08d2');
    expect(s.spans[0]!.isSidechain).toBe(true);
    expect(s.spans[0]!.attributionAgent).toBe('guardian');
    // The injected review preamble is machine text, not a task gist.
    expect(s.spans[0]!.firstUserText).toBe('');
  });

  it('prices an unrecognized Codex model as UNPRICED rather than silently guessing', () => {
    // `codex-auto-review` runs 417 of 2499 real local turns and is in no pricing table.
    // It must still produce a cost (a fallback estimate) while reporting priced: false,
    // so the report can flag it instead of presenting an invented rate as fact.
    const { usd, priced } = turnCostTariffs('codex-auto-review', toTurnUsage({ input_tokens: 17_677, cached_input_tokens: 4_864, output_tokens: 157 }));
    expect(priced).toBe(false);
    expect(usd).toBeGreaterThan(0);
  });
});
