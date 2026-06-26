import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeContextHygiene, type ContextHygiene } from '../contextHygiene.js';
import {
  buildHygieneFootprints,
  refineAvoidableCarry,
  type HygieneFootprint,
} from '../hygieneFootprint.js';

let mid = 0;
const asst = (ctx: number) => {
  mid += 1;
  return {
    type: 'assistant',
    message: {
      id: `m${mid}`,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'ok' }],
    },
  };
};
const raw = (e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n');

describe('buildHygieneFootprints', () => {
  // One overdue episode whose window covers a span with a real, judgeable task gist.
  const events: unknown[] = [
    { type: 'user', promptId: 'p1', message: { content: 'implement the auth refactor across all services' } },
  ];
  for (let i = 0; i < 6; i += 1) events.push(asst(200_000));
  const session = parseTranscript('/tmp/hf.jsonl', raw(events), 'secret/repo')!;
  const hygiene = computeContextHygiene([session]);
  const footprints = buildHygieneFootprints(hygiene, [session]);

  it('maps an overdue episode to the task gists inside its turn window', () => {
    expect(hygiene.overdueEpisodes).toHaveLength(1);
    expect(footprints).toHaveLength(1);
    expect(footprints[0]!.item.kind).toBe('overdue');
    expect(footprints[0]!.item.gists).toContain('implement the auth refactor across all services');
    expect(footprints[0]!.item.peakTokens).toBe(200_000);
    expect(footprints[0]!.avoidableUsd).toBeCloseTo(hygiene.overdueEpisodes[0]!.avoidableUsd, 9);
  });

  it('the WIRE item never carries sessionId, project, or paths (privacy invariant)', () => {
    // Only the user's own gist + structural counts may leave the machine.
    const blob = JSON.stringify(footprints.map((f) => f.item));
    expect(blob).not.toContain('secret/repo');
    expect(blob).not.toContain('hf.jsonl');
    expect(blob).not.toContain(session.sessionId);
    // Item keys are exactly the wire allow-list.
    const allowed = new Set(['kind', 'peakTokens', 'turns', 'gists']);
    expect(Object.keys(footprints[0]!.item).every((k) => allowed.has(k))).toBe(true);
  });

  it('drops episodes whose window has no judgeable gist (nothing for the judge to score)', () => {
    // Same shape but the only prompt is a continuation fragment — not judgeable.
    const ev: unknown[] = [{ type: 'user', promptId: 'p1', message: { content: 'ok continue' } }];
    for (let i = 0; i < 6; i += 1) ev.push(asst(200_000));
    const s = parseTranscript('/tmp/hf2.jsonl', raw(ev), 'p')!;
    const h = computeContextHygiene([s]);
    expect(h.overdueEpisodes).toHaveLength(1); // still detected deterministically
    expect(buildHygieneFootprints(h, [s])).toHaveLength(0); // but not sent (no gist)
  });
});

describe('refineAvoidableCarry', () => {
  const hygiene = { avoidableTotalUsd: 10 } as ContextHygiene;
  const sent: HygieneFootprint[] = [
    { item: { kind: 'overdue', peakTokens: 0, turns: 0, gists: [] }, avoidableUsd: 2 },
    { item: { kind: 'overdue', peakTokens: 0, turns: 0, gists: [] }, avoidableUsd: 3 },
  ];

  it('applies per-episode stale share and extrapolates the average to the unsent remainder', () => {
    // judged 5 of 10: refined = 2·0.5 + 3·1.0 = 4 ; avg = 4/5 = 0.8 ; unsent 5 · 0.8 = 4 ⇒ 8
    const r = refineAvoidableCarry(hygiene, sent, [
      { staleShare: 0.5, confidence: 'high', reason: '' },
      { staleShare: 1.0, confidence: 'high', reason: '' },
    ]);
    expect(r.deterministicUsd).toBe(10);
    expect(r.avgStaleShare).toBeCloseTo(0.8, 9);
    expect(r.refinedUsd).toBeCloseTo(8, 9);
    expect(r.judgedCount).toBe(2);
  });

  it('clamps out-of-range shares to [0,1]', () => {
    const r = refineAvoidableCarry({ avoidableTotalUsd: 5 } as ContextHygiene, [sent[0]!], [
      { staleShare: 1.7, confidence: 'low', reason: '' },
    ]);
    // share clamps to 1 → judged refined = 2 ; avg 1 ; unsent 3 · 1 = 3 ⇒ 5
    expect(r.refinedUsd).toBeCloseTo(5, 9);
    expect(r.avgStaleShare).toBe(1);
  });

  it('refines toward zero when the judge says little was stale', () => {
    const r = refineAvoidableCarry(hygiene, sent, [
      { staleShare: 0, confidence: 'high', reason: 'all live context' },
      { staleShare: 0, confidence: 'high', reason: 'all live context' },
    ]);
    expect(r.refinedUsd).toBe(0); // judge overrides the deterministic flag entirely
    expect(r.avgStaleShare).toBe(0);
  });
});
