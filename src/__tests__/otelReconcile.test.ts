import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { turnCostTariffs } from '../pricing.js';
import type { TurnUsage } from '../model.js';

// Reconciliation against Claude Code's OWN telemetry, from a captured OTLP stream.
//
// WHY. cc-audit derives cost from an undocumented private format, so "is our
// arithmetic right" has no purely local answer — every other test grades our own
// homework. Claude Code's `claude_code.api_request` event is the one external
// referent: it carries the FINAL per-request token counts plus Anthropic's own
// `cost_usd` for the same request, keyed by a `request_id` the transcript also
// records. That makes an exact, external check possible.
//
// HOW THE FIXTURES WERE MADE (procedure in MAINTAINING.md "OTel reconciliation").
// Two scripted `claude -p` sessions on claude-sonnet-5 were captured BOTH ways at
// once — through the transcript and through a local OTLP/HTTP-JSON receiver
// (`scripts/otlp-capture.py`) with CLAUDE_CODE_ENABLE_TELEMETRY=1:
//
//   otel-api-request-wire.jsonl   raw OTLP batches, filtered to api_request records
//                                 and otherwise verbatim. The ONLY post-capture edit
//                                 is that five identity attributes (user.id,
//                                 user.email, user.account_uuid, user.account_id,
//                                 organization.id) were replaced with placeholders,
//                                 because this repo is public. Nothing under test
//                                 was touched.
//   otel-transcript-tokens.jsonl  the transcript side, projected to per-requestId
//                                 token counts. A projection, not a rewrite: paths,
//                                 prose and prompts are excluded on purpose, both
//                                 for the repo's privacy invariant and because the
//                                 numbers are the whole subject.
//
// Corpus: 10 requests, 4 of them subagent sidechains, 5 of them streamed across
// multiple JSONL rows. Captured 2026-07-26 against Claude Code 2.1.220.
//
// Offline and deterministic: reads two files and does arithmetic.

interface WireReq {
  model: string;
  requestId: string;
  input: number;
  output: number;
  cacheRead: number;
  /** The wire reports ONE cache-creation figure with no 5m/1h split. That is the
   *  point of the last test in this file. */
  cacheCreation: number;
  costUsd: number;
}

interface TranscriptReq extends TurnUsage {
  requestId: string;
  rows: number;
  sidechain: boolean;
  stopReason: string | null;
}

const fixture = (n: string) =>
  readFileSync(join(__dirname, 'fixtures', n), 'utf8')
    .split('\n')
    .filter((l) => l.trim());

function loadWire(): WireReq[] {
  const out: WireReq[] = [];
  for (const line of fixture('otel-api-request-wire.jsonl')) {
    for (const rl of JSON.parse(line).body.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const a: Record<string, unknown> = {};
          for (const x of lr.attributes ?? []) a[x.key] = Object.values(x.value)[0];
          out.push({
            model: String(a['model']),
            requestId: String(a['request_id']),
            // OTLP/JSON encodes int64 as a string in some SDKs, a number in others.
            input: Number(a['input_tokens'] ?? 0),
            output: Number(a['output_tokens'] ?? 0),
            cacheRead: Number(a['cache_read_tokens'] ?? 0),
            cacheCreation: Number(a['cache_creation_tokens'] ?? 0),
            costUsd: Number(a['cost_usd'] ?? 0),
          });
        }
      }
    }
  }
  return out;
}

const loadTranscript = (): TranscriptReq[] =>
  fixture('otel-transcript-tokens.jsonl').map((l) => JSON.parse(l) as TranscriptReq);

// Any instant at/after the cutover resolves the steady-state row; one inside the
// window resolves the introductory row. Fixed dates, so this stays deterministic
// after the window closes.
const STEADY = Date.UTC(2026, 8, 1);
const IN_WINDOW = Date.UTC(2026, 6, 26);

const wire = loadWire();
const tr = loadTranscript();
const byId = new Map(tr.map((t) => [t.requestId, t]));
const usage = (t: TranscriptReq): TurnUsage => ({
  input: t.input,
  output: t.output,
  cacheRead: t.cacheRead,
  cacheWrite5m: t.cacheWrite5m,
  cacheWrite1h: t.cacheWrite1h,
});

describe('OTel reconciliation — the captured corpus', () => {
  it('pairs every wire request with a transcript request', () => {
    expect(wire.length).toBeGreaterThanOrEqual(10);
    expect(new Set(wire.map((w) => w.requestId)).size).toBe(wire.length);
    for (const w of wire) {
      expect(w.model).toBe('claude-sonnet-5');
      expect(byId.has(w.requestId), `no transcript row for ${w.requestId}`).toBe(true);
    }
    // The corpus must keep exercising the two cases that make it worth having.
    expect(tr.filter((t) => t.sidechain).length).toBeGreaterThan(0);
    expect(tr.filter((t) => t.rows > 1).length).toBeGreaterThan(0);
  });
});

describe('the transcript loses no tokens — including streamed and subagent turns', () => {
  // This is the check the 0.5.2 streamed-output undercount would have failed. It also
  // retires the hypothesis that the transcript's own per-field maximum is a partial
  // count: on this corpus the streamed, multi-row messages match the wire exactly.
  it('per-request output tokens match the wire exactly', () => {
    for (const w of wire) {
      expect(byId.get(w.requestId)!.output, `output mismatch on ${w.requestId}`).toBe(w.output);
    }
  });

  it('input, cache-read and total cache-creation match the wire exactly', () => {
    for (const w of wire) {
      const t = byId.get(w.requestId)!;
      expect(t.input).toBe(w.input);
      expect(t.cacheRead).toBe(w.cacheRead);
      expect(t.cacheWrite5m + t.cacheWrite1h).toBe(w.cacheCreation);
    }
  });
});

describe('our pricing reproduces Claude Code’s own cost_usd', () => {
  it('exactly, per request, at the steady-state tariff', () => {
    for (const w of wire) {
      const ours = turnCostTariffs(w.model, usage(byId.get(w.requestId)!), STEADY);
      // To the cent is not enough: a tariff error hides inside a cent on a small
      // request. Agreement is to 1e-9 — exact in floating point.
      expect(ours.usd, `cost mismatch on ${w.requestId}`).toBeCloseTo(w.costUsd, 9);
    }
  });

  it('exactly, summed across the corpus', () => {
    const theirs = wire.reduce((n, w) => n + w.costUsd, 0);
    const ours = wire.reduce(
      (n, w) => n + turnCostTariffs(w.model, usage(byId.get(w.requestId)!), STEADY).usd,
      0,
    );
    expect(ours).toBeCloseTo(theirs, 9);
  });

  it('and shows Claude Code is NOT applying the Sonnet 5 introductory rate', () => {
    // The reported "cc-audit runs 40% below /cost" defect, in one assertion. Their
    // figure is exactly 1.5x an introductory-rate recomputation of the same tokens,
    // which is the intro:steady ratio — so the divergence is entirely tariff choice,
    // not a token or arithmetic error. See pricingSonnet5Tariff.test.ts.
    const theirs = wire.reduce((n, w) => n + w.costUsd, 0);
    const intro = wire.reduce(
      (n, w) => n + turnCostTariffs(w.model, usage(byId.get(w.requestId)!), IN_WINDOW).usd,
      0,
    );
    expect(theirs / intro).toBeCloseTo(1.5, 9);
  });
});

describe('the OTLP wire alone cannot reproduce an exact bill', () => {
  // Load-bearing for anything that would replace the transcript read with OTel: the
  // wire collapses cache creation into ONE bucket, but the 5-minute and 1-hour write
  // tiers price at 1.25x and 2.0x input. This corpus is a real mix — some requests
  // are pure 1h, the subagent ones pure 5m — so neither single-tier guess works, and
  // there is no attribute on the wire to choose between them.
  const base = (w: WireReq, rate: number) =>
    (w.input * 3 + w.output * 15 + w.cacheRead * 0.3 + w.cacheCreation * rate) / 1_000_000;

  it('is a genuine mix of cache-write tiers, not uniformly one', () => {
    expect(tr.some((t) => t.cacheWrite1h > 0 && t.cacheWrite5m === 0)).toBe(true);
    expect(tr.some((t) => t.cacheWrite5m > 0 && t.cacheWrite1h === 0)).toBe(true);
  });

  it('misses by far more than a rounding error under either single-tier guess', () => {
    const theirs = wire.reduce((n, w) => n + w.costUsd, 0);
    const all1h = wire.reduce((n, w) => n + base(w, 6), 0);
    const all5m = wire.reduce((n, w) => n + base(w, 3.75), 0);
    const err = (x: number) => Math.abs(x - theirs) / theirs;
    // Measured 2026-07-26: +10.4% assuming all-1h, -23.9% assuming all-5m. Pinned
    // loosely so re-capturing the corpus doesn't churn the numbers, but tightly
    // enough that "OTel is good enough for exact cost" cannot pass.
    expect(err(all1h)).toBeGreaterThan(0.05);
    expect(err(all5m)).toBeGreaterThan(0.05);
    expect(theirs).toBeGreaterThan(all5m); // all-5m UNDER-bills
    expect(all1h).toBeGreaterThan(theirs); // all-1h OVER-bills
  });
});
