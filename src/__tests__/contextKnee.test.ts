import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeContextKnee, deriveContextKnee, sessionContextBuckets, type ContextBucket } from '../contextKnee.js';

// Assistant turn at a chosen context size (all cacheRead so contextTokens == ctx), with
// optional file tool calls (name + path) for redundant-read / friction shaping.
let mid = 0;
function asst(opts: { ctx: number; tools?: Array<{ name: string; path: string; id?: string }> } = { ctx: 1000 }) {
  mid += 1;
  const content = (opts.tools ?? []).map((t) => ({
    type: 'tool_use',
    name: t.name,
    id: t.id ?? `t${mid}`,
    input: { file_path: t.path },
  }));
  return {
    type: 'assistant',
    message: {
      id: `m${mid}`,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 50, cache_read_input_tokens: opts.ctx, cache_creation_input_tokens: 0 },
      content,
    },
  };
}
const user = (promptId: string, content: string) => ({ type: 'user', promptId, message: { content } });
const raw = (e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n');

// A session whose redundant re-reads climb with context: K low-context reads that seed
// residency (band 0), then K high-context RE-reads of those same paths (band 1). K=12 so a
// single session carries 12 elevated-band symptoms — below AGGREGATE_MIN_SYMPTOMS=20, so it
// can't fit an aggregated knee alone, but two sessions merged (24) can. Baseline (band 0)
// stays at rate 0 so the 2×-baseline climb always holds.
const REREAD_FILES = 12;
function reReadSession(id: string) {
  const events: unknown[] = [user('p1', 'work across many files then revisit them as the context grows')];
  for (let i = 0; i < REREAD_FILES; i++) events.push(asst({ ctx: 30_000, tools: [{ name: 'Read', path: `/x/f${i}.ts` }] })); // band0 (<40k), seed resident
  for (let i = 0; i < REREAD_FILES; i++) events.push(asst({ ctx: 50_000, tools: [{ name: 'Read', path: `/x/f${i}.ts` }] })); // band1 (40–60k), REDUNDANT
  return parseTranscript(`/tmp/${id}.jsonl`, raw(events), 'p')!;
}

describe('sessionContextBuckets', () => {
  it('buckets redundant re-reads by the context size at the re-read turn', () => {
    const buckets = sessionContextBuckets(reReadSession('rr'))!;
    expect(buckets[0]!.turns).toBe(REREAD_FILES);
    expect(buckets[0]!.redundantReReads).toBe(0); // first reads seed residency, not redundant
    expect(buckets[1]!.turns).toBe(REREAD_FILES);
    expect(buckets[1]!.redundantReReads).toBe(REREAD_FILES); // every re-read lands in the 40k–60k band
  });

  it('a write to a path makes a later read of it legitimate (not redundant)', () => {
    const events: unknown[] = [
      user('p1', 'read a file, rewrite it, then read it again after the change'),
      asst({ ctx: 30_000, tools: [{ name: 'Read', path: '/x/a.ts' }] }),
      asst({ ctx: 50_000, tools: [{ name: 'Edit', path: '/x/a.ts' }] }), // stales the resident copy
      asst({ ctx: 50_000, tools: [{ name: 'Read', path: '/x/a.ts' }] }), // legitimate refresh
      asst({ ctx: 50_000, tools: [{ name: 'Read', path: '/x/a.ts' }] }), // NOW redundant (resident again)
    ];
    const buckets = sessionContextBuckets(parseTranscript('/tmp/w.jsonl', raw(events), 'p')!)!;
    expect(buckets[1]!.redundantReReads).toBe(1);
  });

  it('returns null for a session too short to bucket (< 4 telemetry turns)', () => {
    const events: unknown[] = [user('p1', 'tiny'), asst({ ctx: 30_000 }), asst({ ctx: 30_000 })];
    expect(sessionContextBuckets(parseTranscript('/tmp/s.jsonl', raw(events), 'p')!)).toBeNull();
  });
});

describe('deriveContextKnee (the onset rule)', () => {
  const b = (maxTokens: number | null, turns: number, reReads: number, friction = 0): ContextBucket => ({
    maxTokens,
    turns,
    redundantReReads: reReads,
    frictionEvents: friction,
  });

  it('returns the lower edge of the first band that clears the floor and 2× baseline', () => {
    // baseline band0 rate 0; band1 rate 4/4 = 1.0 ≥ 0.34 and ≥ 2×0 → knee = 50k (band0 edge).
    expect(deriveContextKnee([b(50_000, 4, 0), b(100_000, 4, 4), b(200_000, 0, 0), b(null, 0, 0)])).toBe(50_000);
  });

  it('returns null when the baseline band has too few turns to trust (BAND_TURN_FLOOR)', () => {
    // band0 has only 2 turns → baseline untrusted → null even though band1 looks elevated.
    expect(deriveContextKnee([b(50_000, 2, 0), b(100_000, 4, 4), b(200_000, 0, 0), b(null, 0, 0)])).toBeNull();
  });

  it('returns null when no band clears the absolute onset floor (default single-session guard)', () => {
    // band1 rate 1/4 = 0.25 < ONSET_RATE_FLOOR (0.34) → no onset on the DEFAULT path.
    expect(deriveContextKnee([b(50_000, 4, 0), b(100_000, 4, 1), b(200_000, 0, 0), b(null, 0, 0)])).toBeNull();
  });

  it('AGGREGATED guard: a band that clears 2×baseline but has < minSymptoms events → null', () => {
    // The exact real-data failure mode. Merged bands have thousands of turns, so the per-turn
    // rate is naturally tiny (here 0.04) but DOES clear 2×baseline (0.02). With rateFloor 0 the
    // only thing standing between a fluke and a knee is the raw symptom count — 19 < 20 → null.
    const buckets = [b(50_000, 1000, 10), b(100_000, 500, 15), b(200_000, 0, 0), b(null, 0, 0)];
    // baseline rate 10/1000 = 0.01; band1 rate 15/500 = 0.03 ≥ 2×0.01 = 0.02 → the climb is real…
    expect(deriveContextKnee(buckets, { rateFloor: 0 })).toBe(50_000); // …fires with no symptom floor
    expect(deriveContextKnee(buckets, { rateFloor: 0, minSymptoms: 20 })).toBeNull(); // 15 < 20 blocks it
    // Enough symptoms (20) clears the floor.
    const enough = [b(50_000, 1000, 10), b(100_000, 500, 20), b(200_000, 0, 0), b(null, 0, 0)];
    expect(deriveContextKnee(enough, { rateFloor: 0, minSymptoms: 20 })).toBe(50_000);
  });
});

describe('computeContextKnee (merge across sessions, then the rule)', () => {
  it('fits a knee from MERGED evidence that no single session clears', () => {
    // One session carries 12 elevated-band symptoms — below AGGREGATE_MIN_SYMPTOMS=20 (and
    // it's only 1 session) → null. Not enough events for the 2× climb to be trustworthy alone.
    const one = computeContextKnee([reReadSession('a')]);
    expect(one.sessionsWithSignal).toBe(1);
    expect(one.buckets[1]!.redundantReReads).toBe(12); // the band IS elevated within one session…
    expect(one.onsetTokens).toBeNull(); // …but 12 < 20 symptoms and only 1 session → not trusted

    // Two sessions merged: band0 rate 0 baseline, band1 has 24 ≥ 20 re-reads → knee at 40k
    // (the lower edge of the elevated 40–60k band = band0's upper edge).
    const knee = computeContextKnee([reReadSession('b'), reReadSession('c')]);
    expect(knee.sessionsWithSignal).toBe(2);
    expect(knee.buckets[1]!.redundantReReads).toBe(24);
    expect(knee.onsetTokens).toBe(40_000);
  });

  it('single session → no knee even if it alone would clear the band-turn floor', () => {
    // A longer single session that DOES clear BAND_TURN_FLOOR internally still returns null:
    // one session is single-session noise (MIN_SESSIONS_WITH_SIGNAL = 2).
    const events: unknown[] = [user('p1', 'a long single session revisiting files as context grows')];
    for (let i = 0; i < 3; i++) events.push(asst({ ctx: 30_000, tools: [{ name: 'Read', path: `/x/f${i}.ts` }] }));
    for (let i = 0; i < 3; i++) events.push(asst({ ctx: 50_000, tools: [{ name: 'Read', path: `/x/f${i}.ts` }] }));
    const s = parseTranscript('/tmp/solo.jsonl', raw(events), 'p')!;
    const buckets = sessionContextBuckets(s)!;
    expect(buckets[1]!.redundantReReads).toBe(3); // band1 IS elevated within this session
    expect(deriveContextKnee(buckets)).toBe(40_000); // the rule alone would fire…
    expect(computeContextKnee([s]).onsetTokens).toBeNull(); // …but one session isn't trusted
  });

  it('friction (from friction.ts) also feeds the buckets, stamped by context size', () => {
    // Two consecutive edits of the same path at high context = a self-correction friction
    // event, landing in band 1.
    const events: unknown[] = [
      user('p1', 'rewrite the same module twice in a row while the context is already elevated'),
      asst({ ctx: 50_000, tools: [{ name: 'Read', path: '/x/a.ts' }] }),
      asst({ ctx: 50_000, tools: [{ name: 'Read', path: '/x/b.ts' }] }),
      asst({ ctx: 50_000, tools: [{ name: 'Edit', path: '/x/c.ts', id: 'e1' }] }),
      asst({ ctx: 50_000, tools: [{ name: 'Edit', path: '/x/c.ts', id: 'e2' }] }), // immediate re-edit
    ];
    const buckets = sessionContextBuckets(parseTranscript('/tmp/fr.jsonl', raw(events), 'p')!)!;
    expect(buckets[1]!.frictionEvents).toBe(1);
  });
});
