import { describe, it, expect } from 'vitest';
import { turnCostTariffs, turnCostUsd } from '../pricing.js';
import { attributeSpend } from '../attribute.js';
import { computeWeeklySpend } from '../temporal.js';
import type { AssistantTurn, Session, Span, TurnUsage } from '../model.js';

// Tariff pins for claude-sonnet-5 — ONE rate, at every timestamp.
//
// HISTORY. Sonnet 5 launched at $2/$10 "introductory" with a step-up to $3/$15
// announced for 2026-09-01, and this file used to pin that flip. ANTHROPIC CANCELLED
// THE STEP-UP: $2/$10 is now the standard price (platform.claude.com pricing,
// re-read 2026-09-22). The upstream table dropped the dated override on 2026-09-01.
//
// cc-audit v0.5.2 was reported as "40% below Claude Code's own cost figure". It still
// is, and that is still Claude Code's error: its 2.1.220 client priced Sonnet 5 at
// $3/$15 (see otelReconcile.test.ts), which Anthropic never billed.
//
// A SEPARATE, UNFIXED DEFECT lives in the residual: on the original corpus the
// $3/$15 recomputation was still 10.35% under Claude Code's figure, from a 912-token
// output gap on one session. That is a token-side bug, not a pricing one. Nothing in
// this file pins the totals as CORRECT — only which TARIFF applies.

/** Token totals measured across four Sonnet 5 transcripts (2 main + 2 subagent). */
const MEASURED: TurnUsage = {
  input: 90,
  output: 3736,
  cacheRead: 657_985,
  cacheWrite5m: 43_153,
  cacheWrite1h: 55_675,
};

// Exact: every rate is a terminating decimal.
const SONNET5_USD = 0.4997195; //   90*2 + 3736*10 + 657985*0.2 + 43153*2.5  + 55675*4
const SONNET46_USD = 0.74957925; // 90*3 + 3736*15 + 657985*0.3 + 43153*3.75 + 55675*6

// Either side of the retired cutoff.
const LAST_INTRO_MS = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
const FIRST_STEADY_MS = Date.UTC(2026, 8, 1, 0, 0, 0, 0);

describe('claude-sonnet-5 tariff (pins the rate, not the tokens)', () => {
  it('prices the measured corpus at $2/$10 on both sides of the retired cutoff', () => {
    for (const ts of [LAST_INTRO_MS, FIRST_STEADY_MS]) {
      const { usd, priced } = turnCostUsd('claude-sonnet-5', MEASURED, ts);
      expect(priced).toBe(true);
      expect(usd).toBeCloseTo(SONNET5_USD, 9);
    }
  });

  it('prices at the same rate when no timestamp is supplied', () => {
    expect(turnCostUsd('claude-sonnet-5', MEASURED).usd).toBeCloseTo(SONNET5_USD, 9);
  });

  it('reports equal tariffs, and does not collapse into Sonnet 4.6', () => {
    const t = turnCostTariffs('claude-sonnet-5', MEASURED, LAST_INTRO_MS);
    expect(t.steadyStateUsd).toBe(t.usd);
    // Sonnet 4.6 really is $3/$15. The retired Sonnet 5 row was identical to it; they
    // must now differ.
    const flat = turnCostTariffs('claude-sonnet-4-6', MEASURED, LAST_INTRO_MS);
    expect(flat.steadyStateUsd).toBe(flat.usd);
    expect(flat.usd).toBeCloseTo(SONNET46_USD, 9);
  });

  it('prices a dated Sonnet 5 variant like its base key', () => {
    expect(turnCostUsd('claude-sonnet-5-20260901', MEASURED, LAST_INTRO_MS).usd).toBeCloseTo(
      SONNET5_USD,
      9,
    );
  });
});

// ── Fixture plumbing for the two aggregate-level pins below ──────────────────

const turn = (ts: number, model = 'claude-sonnet-5'): AssistantTurn => ({
  model,
  usage: MEASURED,
  tools: [],
  reads: [],
  thinkingChars: 0,
  textChars: 0,
  ts,
  mode: null,
  toolResultTs: null,
  toolErrorCount: 0,
});

const span = (ts: number, model?: string): Span => ({
  promptId: 'p1',
  command: null,
  invokedSkills: [],
  firstUserText: 'x',
  turns: [turn(ts, model)],
  isSidechain: false,
  autoCompacted: false,
  attributionSkill: null,
  attributionAgent: null,
  userTs: ts,
});

const session = (ts: number, model?: string): Session => ({
  sessionId: 's1',
  project: 'proj',
  cwd: null,
  mtime: ts,
  modes: [],
  spans: [span(ts, model)],
});

describe('no intro disclosure, and one tariff across the card', () => {
  it('attributeSpend discloses no intro-priced model on either side of the cutoff', () => {
    for (const ts of [LAST_INTRO_MS, FIRST_STEADY_MS]) {
      const s = attributeSpend([session(ts)]);
      expect(s.totalUsd).toBeCloseTo(SONNET5_USD, 9);
      expect(s.introPricedModels).toEqual([]);
    }
  });

  it('weekly buckets use the same tariff as the SPEND headline', () => {
    // Regression: computeWeeklySpend once called turnCostUsd WITHOUT the turn
    // timestamp, so the weekly row and the headline could price the same turns
    // differently. Kept so a future dated rate can't reopen it.
    const now = LAST_INTRO_MS;
    const sessions = [session(now - 2 * 24 * 60 * 60 * 1000)];
    const weekly = computeWeeklySpend(sessions, now).reduce((n, b) => n + b.usd, 0);
    expect(weekly).toBeCloseTo(attributeSpend(sessions).totalUsd, 9);
    expect(weekly).toBeCloseTo(SONNET5_USD, 9);
  });
});
