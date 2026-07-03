import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeTemporal, computeWeeklySpend } from '../temporal.js';

// Helpers that emit JSONL rows with ISO timestamps and tool_result back-references, so
// these tests exercise the real adapter parsing (ts / toolResultTs / mode).
const iso = (ms: number) => new Date(ms).toISOString();
let mid = 0;
function asst(tsMs: number | null, opts: { tool?: string; toolId?: string } = {}) {
  mid += 1;
  const content = opts.tool ? [{ type: 'tool_use', name: opts.tool, id: opts.toolId ?? `t${mid}` }] : [];
  const row: Record<string, unknown> = {
    type: 'assistant',
    message: {
      id: `m${mid}`,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      content,
    },
  };
  if (tsMs != null) row.timestamp = iso(tsMs);
  return row;
}
const user = (promptId: string, tsMs: number, content = 'do a thing') => ({
  type: 'user',
  promptId,
  timestamp: iso(tsMs),
  message: { content },
});
const toolResult = (toolId: string, tsMs: number, isError = false) => ({
  type: 'user',
  timestamp: iso(tsMs),
  message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError }] },
});
const mode = (m: string) => ({ type: 'mode', mode: m });
const raw = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

const T0 = Date.parse('2026-06-24T12:00:00.000Z');
const sec = (n: number) => T0 + n * 1000;

describe('computeTemporal — stratification', () => {
  it('splits think (prompt→turn) and exec (turn→tool_result)', () => {
    // prompt@0s → asst(tool)@10s → its tool_result@22s → asst(text)@30s
    const s = parseTranscript(
      '/tmp/t.jsonl',
      raw([
        user('p1', sec(0)),
        asst(sec(10), { tool: 'Bash', toolId: 'a1' }),
        toolResult('a1', sec(22)),
        asst(sec(30)),
      ]),
      'proj',
    )!;
    const t = computeTemporal([s]).stratified;
    expect(t.thinkMs).toBe(10_000 + 8_000); // t1: 10s after prompt; t2: 30s−22s(end of t1 exec)
    expect(t.execMs).toBe(12_000); // 22s − 10s
    expect(t.attributedTurns).toBe(2);
  });

  it('counts userWait between consecutive spans', () => {
    const s = parseTranscript(
      '/tmp/t2.jsonl',
      raw([user('p1', sec(0)), asst(sec(5)), user('p2', sec(60)), asst(sec(65))]),
      'proj',
    )!;
    const t = computeTemporal([s]).stratified;
    expect(t.userWaitMs).toBe(55_000); // p2(60s) − end of span1 (5s)
  });

  it('caps idle gaps so walked-away time does not dominate', () => {
    // 3-hour gap between spans → capped at 30 min, not 3h.
    const s = parseTranscript(
      '/tmp/t3.jsonl',
      raw([user('p1', sec(0)), asst(sec(5)), user('p2', sec(5 + 3 * 3600)), asst(sec(10 + 3 * 3600))]),
      'proj',
    )!;
    const t = computeTemporal([s]).stratified;
    expect(t.userWaitMs).toBe(30 * 60_000);
  });

  it('marks turns with no timestamp as unattributed', () => {
    const s = parseTranscript('/tmp/t4.jsonl', raw([user('p1', sec(0)), asst(null), asst(sec(10))]), 'proj')!;
    const t = computeTemporal([s]).stratified;
    expect(t.unattributedTurns).toBe(1);
    expect(t.attributedTurns).toBe(1);
  });

  it('clamps out-of-order rows to non-negative', () => {
    const s = parseTranscript('/tmp/t5.jsonl', raw([user('p1', sec(100)), asst(sec(50))]), 'proj')!;
    const t = computeTemporal([s]).stratified;
    expect(t.thinkMs).toBe(0); // 50s − 100s clamps to 0, not negative
  });

  it('buckets turns by local hour and has 24 buckets', () => {
    const s = parseTranscript('/tmp/t6.jsonl', raw([user('p1', sec(0)), asst(sec(1))]), 'proj')!;
    const prof = computeTemporal([s]);
    expect(prof.hourHistogram).toHaveLength(24);
    expect(prof.hourHistogram.reduce((n, b) => n + b.turns, 0)).toBe(1);
  });
});

describe('adapter — per-turn mode tracking', () => {
  it('stamps plan mode on turns, then flips to normal after ExitPlanMode', () => {
    const s = parseTranscript(
      '/tmp/m.jsonl',
      raw([
        mode('plan'),
        user('p1', sec(0)),
        asst(sec(1), { tool: 'ExitPlanMode', toolId: 'e1' }),
        asst(sec(2)),
      ]),
      'proj',
    )!;
    const turns = s.spans[0]!.turns;
    expect(turns[0]!.mode).toBe('plan'); // the ExitPlanMode turn still ran in plan
    expect(turns[1]!.mode).toBe('normal'); // flipped after acceptance
  });
});

describe('computeWeeklySpend — trailing 7-day buckets', () => {
  const DAY = 86_400_000;
  const day = (n: number) => T0 - n * DAY;

  it('buckets turns into trailing weeks anchored at now, oldest→newest', () => {
    const s = parseTranscript(
      '/tmp/w.jsonl',
      raw([user('p1', day(15)), asst(day(15)), asst(day(8)), asst(day(1))]),
      'proj',
    )!;
    const buckets = computeWeeklySpend([s], T0);
    expect(buckets).toHaveLength(3); // 15 days back ⇒ ceil(15/7) = 3 buckets
    expect(buckets.map((b) => b.usd > 0)).toEqual([true, true, true]); // one turn each
    expect(buckets[0]!.usd).toBeCloseTo(buckets[2]!.usd); // identical usage per turn
    expect(buckets.map((b) => b.complete)).toEqual([false, true, false]); // edges partial
    expect(buckets[2]!.endMs).toBe(T0);
    expect(buckets[2]!.startMs).toBe(T0 - 7 * DAY);
  });

  it('falls back ts → span.userTs → session.mtime and clamps future timestamps', () => {
    const s = parseTranscript(
      '/tmp/w2.jsonl',
      raw([user('p1', day(9)), asst(null), user('p2', day(9)), asst(T0 + DAY)]),
      'proj',
    )!;
    const buckets = computeWeeklySpend([s], T0);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.usd).toBeGreaterThan(0); // ts:null turn landed via span.userTs @ -9d
    expect(buckets[1]!.usd).toBeGreaterThan(0); // future turn clamped into the newest bucket
  });

  it('returns [] when no usable timestamps exist', () => {
    const s = parseTranscript('/tmp/w3.jsonl', raw([user('p1', T0), asst(null)]), 'proj')!;
    s.mtime = 0;
    s.spans[0]!.userTs = null;
    expect(computeWeeklySpend([s], T0)).toEqual([]);
  });
});
