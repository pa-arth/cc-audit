import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeConcurrency } from '../concurrency.js';
import { concurrencyKey, type Session, type Span } from '../model.js';

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 6, 15, 12, 0, 0);

let mid = 0;
const asst = (tsMs: number) => {
  mid += 1;
  return {
    type: 'assistant',
    timestamp: iso(tsMs),
    message: {
      id: `m${mid}`,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [],
    },
  };
};
const user = (promptId: string, tsMs: number) => ({
  type: 'user',
  promptId,
  timestamp: iso(tsMs),
  message: { content: 'do a thing' },
});
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

/** A hand-built session with turns at the given offsets (minutes from T0). */
function session(id: string, minutes: number[], opts: { parent?: string; prompts?: number[] } = {}): Session {
  const spans: Span[] = [
    {
      promptId: 'p1',
      command: null,
      invokedSkills: [],
      firstUserText: '',
      isSidechain: false,
      autoCompacted: false,
      attributionSkill: null,
      attributionAgent: null,
      userTs: opts.prompts?.[0] != null ? T0 + opts.prompts[0] * MIN : null,
      turns: minutes.map((m) => ({
        model: 'claude-opus-4-8',
        usage: { input: 0, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        tools: [],
        reads: [],
        thinkingChars: 0,
        textChars: 0,
        ts: T0 + m * MIN,
        mode: null,
        toolResultTs: null,
        toolErrorCount: 0,
      })),
    },
  ];
  for (const p of (opts.prompts ?? []).slice(1)) {
    spans.push({ ...spans[0]!, promptId: `p${p}`, userTs: T0 + p * MIN, turns: [] });
  }
  return { sessionId: id, parentSessionId: opts.parent ?? null, project: 'proj', cwd: null, mtime: 0, modes: [], spans };
}

describe('parentSessionId', () => {
  it('reads the parent off a subagents/ transcript path', () => {
    const s = parseTranscript(
      '/root/-proj/parent-uuid/subagents/agent-abc.jsonl',
      jsonl([user('p1', T0), asst(T0 + 1000)]),
      'proj',
    );
    expect(s?.parentSessionId).toBe('parent-uuid');
    expect(concurrencyKey(s!)).toBe('parent-uuid');
  });

  it('is null for a top-level transcript', () => {
    const s = parseTranscript('/root/-proj/plain-uuid.jsonl', jsonl([user('p1', T0), asst(T0 + 1000)]), 'proj');
    expect(s?.parentSessionId).toBeNull();
    expect(concurrencyKey(s!)).toBe('plain-uuid');
  });
});

describe('computeConcurrency', () => {
  it('a single session is never concurrent with itself', () => {
    const p = computeConcurrency([session('a', [0, 1, 2])]);
    expect(p.wallMinutes).toBe(3);
    expect(p.agentMinutes).toBe(3);
    expect(p.meanConcurrent).toBe(1);
    expect(p.peakConcurrent).toBe(1);
    expect(p.minutesBought).toBe(0);
    expect(p.soloShare).toBe(1);
  });

  it('two fully overlapping sessions read as 2x, not 2 sessions of solo work', () => {
    const p = computeConcurrency([session('a', [0, 1, 2]), session('b', [0, 1, 2])]);
    expect(p.wallMinutes).toBe(3);
    expect(p.agentMinutes).toBe(6);
    expect(p.meanConcurrent).toBe(2);
    expect(p.minutesBought).toBe(3);
    expect(p.multiShare).toBe(1);
  });

  // This is the defect the whole parentSessionId change exists to prevent.
  it('subagents fold into their parent instead of counting as siblings', () => {
    const parent = session('a', [0, 1, 2]);
    const kids = [1, 2, 3, 4, 5, 6].map((i) => session(`agent-${i}`, [0, 1, 2], { parent: 'a' }));
    const p = computeConcurrency([parent, ...kids]);
    expect(p.meanConcurrent).toBe(1);
    expect(p.peakConcurrent).toBe(1);
    // and the naive version would have said 7
    const naive = computeConcurrency([parent, ...kids.map((k) => ({ ...k, parentSessionId: null }))]);
    expect(naive.peakConcurrent).toBe(7);
  });

  it('bridges a short gap and refuses to bridge a long one', () => {
    // turns at minute 0 and minute 3: a 3-minute gap
    const bridged = computeConcurrency([session('a', [0, 3])], { bridgeMs: 5 * MIN });
    expect(bridged.wallMinutes).toBe(4); // 0,1,2,3

    const unbridged = computeConcurrency([session('a', [0, 3])], { bridgeMs: 1 * MIN });
    expect(unbridged.wallMinutes).toBe(2); // 0 and 3 only
  });

  it('clamps an absurd bridge rather than merging separate days', () => {
    const p = computeConcurrency([session('a', [0, 1])], { bridgeMs: 99 * 60 * MIN });
    expect(p.bridgeMs).toBe(30 * MIN);
  });

  it('excludes idle time instead of averaging it in as zero', () => {
    // two one-minute bursts an hour apart, no bridge across the hour
    const p = computeConcurrency([session('a', [0, 60])], { bridgeMs: 1 * MIN });
    expect(p.wallMinutes).toBe(2);
    expect(p.meanConcurrent).toBe(1); // NOT 2/61
  });

  it('separates the two averages: yours and the sessions own', () => {
    // minute 0: one session. minutes 1-2: three sessions.
    const p = computeConcurrency([
      session('a', [0, 1, 2]),
      session('b', [1, 2]),
      session('c', [1, 2]),
    ]);
    expect(p.wallMinutes).toBe(3);
    expect(p.agentMinutes).toBe(7); // 1 + 3 + 3
    expect(p.meanConcurrent).toBeCloseTo(7 / 3, 6);
    // session-weighted: (1*1 + 9 + 9) / 7
    expect(p.sessionWeightedMean).toBeCloseTo(19 / 7, 6);
    expect(p.sessionWeightedMean).toBeGreaterThan(p.meanConcurrent);
  });

  it('median is time-weighted, and solo can be a plurality without being a majority', () => {
    // 3 minutes solo, 2 at two-up, 2 at three-up: solo is the biggest single bar (3/7)
    // but only 43% of the time.
    const p = computeConcurrency([
      session('a', [0, 1, 2, 3, 4, 5, 6]),
      session('b', [3, 4, 5, 6]),
      session('c', [5, 6]),
    ]);
    expect(p.soloShare).toBeCloseTo(3 / 7, 6);
    expect(p.multiShare).toBeCloseTo(4 / 7, 6);
    expect(p.soloShare).toBeLessThan(0.5);
    expect(p.medianConcurrent).toBe(2);
  });

  it('reports the bridge sweep so a finding can be checked against it', () => {
    const p = computeConcurrency([session('a', [0, 3]), session('b', [0, 3])]);
    expect(p.sensitivity.map((s) => s.bridgeMinutes)).toEqual([1, 2, 5, 10]);
    // a wider bridge can only add minutes, never remove them
    const wall = p.sensitivity.map((s) => s.wallMinutes);
    expect(wall).toEqual([...wall].sort((a, b) => a - b));
  });

  it('counts your prompts but not a subagent"s task instruction', () => {
    const s = session('a', [0, 1, 2], { prompts: [0, 1] });
    s.spans.push({ ...s.spans[0]!, isSidechain: true, userTs: T0 + 2 * MIN, turns: [] });
    const p = computeConcurrency([s]);
    const solo = p.steering.find((x) => x.bucket === '1');
    expect(solo?.prompts).toBe(2); // not 3
    expect(solo?.promptsPerAgentHour).toBeCloseTo(2 / (3 / 60), 6);
  });

  it('flags sessions that carry no usable timestamp', () => {
    const untimed = session('b', []);
    untimed.spans[0]!.turns = [
      {
        model: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        tools: [],
        reads: [],
        thinkingChars: 0,
        textChars: 0,
        ts: null,
        mode: null,
        toolResultTs: null,
        toolErrorCount: 0,
      },
    ];
    const p = computeConcurrency([session('a', [0, 1]), untimed]);
    expect(p.sessionsCounted).toBe(1);
    expect(p.sessionsUntimed).toBe(1);
  });

  it('is empty, not NaN, with no input', () => {
    const p = computeConcurrency([]);
    expect(p.wallMinutes).toBe(0);
    expect(p.meanConcurrent).toBe(0);
    expect(p.sessionWeightedMean).toBe(0);
    expect(p.histogram).toEqual([]);
  });
});
