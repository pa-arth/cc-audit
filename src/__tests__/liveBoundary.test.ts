import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { detectLiveBoundary } from '../liveBoundary.js';

let mid = 0;
function asst(reads: string[]) {
  mid += 1;
  return {
    type: 'assistant',
    message: {
      id: `m${mid}`,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 0, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
      content: reads.map((p) => ({ type: 'tool_use', name: 'Read', id: `r${mid}-${p}`, input: { file_path: p } })),
    },
  };
}
const user = (promptId: string, content: string) => ({ type: 'user', promptId, message: { content } });
const raw = (e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n');

// Topic A / Topic B prompts share no content words; each has ≥8 (TOPIC_SHIFT_MIN_WORDS).
const TOPIC_A = 'authentication token refresh rotation session cookie signing verification';
const TOPIC_B = 'redesign invoice billing subscription dashboard revenue analytics widgets';

/** Two prompts; the first works `firstFiles`, the second works `secondFiles`. */
function twoThreads(firstPrompt: string, firstFiles: string[][], secondPrompt: string, secondFiles: string[][]) {
  const events: unknown[] = [user('p1', firstPrompt)];
  for (const reads of firstFiles) events.push(asst(reads));
  events.push(user('p2', secondPrompt));
  for (const reads of secondFiles) events.push(asst(reads));
  return parseTranscript(`/tmp/lb${mid}.jsonl`, raw(events), 'p')!;
}

describe('detectLiveBoundary — a compact boundary needs BOTH signals', () => {
  const AB = [['/x/a.ts'], ['/x/b.ts'], ['/x/a.ts'], ['/x/b.ts']];
  const CD = [['/x/c.ts'], ['/x/d.ts'], ['/x/c.ts'], ['/x/d.ts']];

  it('fires when the topic shifts AND the file working set rotates', () => {
    expect(detectLiveBoundary(twoThreads(TOPIC_A, AB, TOPIC_B, CD))).toBe(true);
  });

  it('does NOT fire when the topic shifts but the files DON\'T rotate (same working set)', () => {
    expect(detectLiveBoundary(twoThreads(TOPIC_A, AB, TOPIC_B, AB))).toBe(false);
  });

  it('does NOT fire when the files rotate but the topic DOESN\'T shift (same prompt)', () => {
    // Same prompt text on both sides → content-word overlap = 1.0, no topic shift.
    expect(detectLiveBoundary(twoThreads(TOPIC_A, AB, TOPIC_A, CD))).toBe(false);
  });

  it('does NOT fire with only one prompt (nothing to compare a topic shift against)', () => {
    const events: unknown[] = [user('p1', TOPIC_A)];
    for (const reads of AB.concat(CD)) events.push(asst(reads));
    expect(detectLiveBoundary(parseTranscript('/tmp/lb-solo.jsonl', raw(events), 'p')!)).toBe(false);
  });

  it('does NOT fire when the new thread has not yet rotated enough distinct files', () => {
    // Topic shifts, but the second thread has touched only ONE distinct file so far
    // (< MIN_FILES_EACH_SIDE) — stay soft until the working set actually rotates.
    expect(detectLiveBoundary(twoThreads(TOPIC_A, AB, TOPIC_B, [['/x/c.ts'], ['/x/c.ts']]))).toBe(false);
  });
});
