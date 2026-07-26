import { describe, it, expect } from 'vitest';
import { turnCostTariffs, turnCostUsd } from '../pricing.js';
import { attributeSpend } from '../attribute.js';
import { computeWeeklySpend } from '../temporal.js';
import type { AssistantTurn, Session, Span, TurnUsage } from '../model.js';

// Tariff pins for claude-sonnet-5, whose price changes ON A DATE.
//
// WHY THIS FILE EXISTS. cc-audit v0.5.2 was reported as "40% below Claude Code's own
// cost figure". It is not. Measured on two scripted Sonnet 5 sessions (four transcript
// files, 2 main + 2 subagent), the token totals pinned below price to:
//
//     introductory rate ($2/$10)   $0.49971950   ← cc-audit, to 7 decimal places
//     steady-state rate ($3/$15)   $0.74957925
//     Claude Code's total_cost_usd $0.83613360
//
// The 1.5x is exactly the intro:steady ratio, so Claude Code's figure prices Sonnet 5
// at the steady-state sticker and has not picked up the introductory window. Three
// independent sources say the intro rate is the one Anthropic bills through
// 2026-08-31: the published rate card, the LiteLLM DB that `ccusage` reads (asserted
// live by pricingDrift.test.ts, which compares the TIME-AWARE rate), and our own
// vendored table. Claude Code is the lone dissenter, so we do not follow it — see the
// SPEND card's introductory-rate disclosure, which names both figures instead.
//
// A SEPARATE, UNFIXED DEFECT lives in the residual: $0.74957925 is still 10.35% under
// Claude Code's $0.83613360 at the SAME rates, and one of those sessions reads 2933
// output tokens off the transcript against 3845 on Claude Code's OTel wire — a
// 912-token gap on output alone, after the v0.5.2 per-field max-merge. That is a
// token-side bug, not a pricing one, and is deliberately not addressed here. Nothing
// in this file should be read as pinning the totals as CORRECT — only as pinning which
// TARIFF is applied to whatever tokens the reader hands in.

/** Token totals measured across the four transcripts described above. */
const MEASURED: TurnUsage = {
  input: 90,
  output: 3736,
  cacheRead: 657_985,
  cacheWrite5m: 43_153,
  cacheWrite1h: 55_675,
};

// Exact, not rounded: every rate is a terminating decimal, so both figures are exact
// rationals. (The bug report quotes $0.7495793 — that is the second figure rounded to
// 7dp, which is why the pin below carries the extra digit.)
const INTRO_USD = 0.4997195; //     90*2 + 3736*10 + 657985*0.2 + 43153*2.5  + 55675*4
const STEADY_USD = 0.74957925; //   90*3 + 3736*15 + 657985*0.3 + 43153*3.75 + 55675*6

// The published window: introductory pricing applies THROUGH 2026-08-31, so the first
// instant of steady-state pricing is 2026-09-01T00:00:00Z.
const LAST_INTRO_MS = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
const FIRST_STEADY_MS = Date.UTC(2026, 8, 1, 0, 0, 0, 0);

describe('claude-sonnet-5 dated tariff (pins the rate, not the tokens)', () => {
  it('prices the measured corpus at the introductory rate inside the window', () => {
    const { usd, priced } = turnCostUsd('claude-sonnet-5', MEASURED, LAST_INTRO_MS);
    expect(priced).toBe(true);
    expect(usd).toBeCloseTo(INTRO_USD, 9);
  });

  it('prices the measured corpus at the steady-state rate from 2026-09-01', () => {
    const { usd, priced } = turnCostUsd('claude-sonnet-5', MEASURED, FIRST_STEADY_MS);
    expect(priced).toBe(true);
    expect(usd).toBeCloseTo(STEADY_USD, 9);
  });

  it('flips tariff across the cutover on a single millisecond', () => {
    const before = turnCostUsd('claude-sonnet-5', MEASURED, LAST_INTRO_MS).usd;
    const after = turnCostUsd('claude-sonnet-5', MEASURED, FIRST_STEADY_MS).usd;
    expect(after / before).toBeCloseTo(1.5, 12);
    // FIRST_STEADY_MS is one ms after LAST_INTRO_MS — the boundary is exact, not fuzzy.
    expect(FIRST_STEADY_MS - LAST_INTRO_MS).toBe(1);
  });

  it('falls back to the steady-state rate when no timestamp is supplied', () => {
    // An omitted timestamp must never be read as "now". A caller that forgets it gets
    // the forward-looking rate, which is the safe direction (over-, not under-bill).
    expect(turnCostUsd('claude-sonnet-5', MEASURED).usd).toBeCloseTo(STEADY_USD, 9);
  });

  it('reports both tariffs, and marks them equal when no intro rate applies', () => {
    const inWindow = turnCostTariffs('claude-sonnet-5', MEASURED, LAST_INTRO_MS);
    expect(inWindow.usd).toBeCloseTo(INTRO_USD, 9);
    expect(inWindow.steadyStateUsd).toBeCloseTo(STEADY_USD, 9);

    // A model with no dated window: the two figures must be identical, which is what
    // keeps the report's disclosure silent for everyone else.
    const flat = turnCostTariffs('claude-sonnet-4-6', MEASURED, LAST_INTRO_MS);
    expect(flat.steadyStateUsd).toBe(flat.usd);
    // ...and Sonnet 4.6's flat rate equals Sonnet 5's POST-cutover rate, which is the
    // arithmetic check that the intro override is not leaking across table keys.
    expect(flat.usd).toBeCloseTo(STEADY_USD, 9);
  });

  it('does not sweep a dated Sonnet 5 variant out of the introductory window', () => {
    // A date-suffixed id resolves to the "claude-sonnet-5" table key and must inherit
    // the intro rate with it.
    expect(
      turnCostUsd('claude-sonnet-5-20260901', MEASURED, LAST_INTRO_MS).usd,
    ).toBeCloseTo(INTRO_USD, 9);
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

describe('introductory rate is surfaced, and applied consistently across the card', () => {
  it('attributeSpend reports the intro spend alongside its steady-state twin', () => {
    const s = attributeSpend([session(LAST_INTRO_MS)]);
    expect(s.totalUsd).toBeCloseTo(INTRO_USD, 9);
    expect(s.introPricedModels).toHaveLength(1);
    const [m] = s.introPricedModels;
    expect(m!.model).toBe('claude-sonnet-5');
    expect(m!.costUsd).toBeCloseTo(INTRO_USD, 9);
    expect(m!.steadyStateCostUsd).toBeCloseTo(STEADY_USD, 9);
    expect(m!.turns).toBe(1);
  });

  it('leaves introPricedModels empty when no turn is inside a window', () => {
    // Same corpus, one ms later. Nothing to disclose, so the report block vanishes —
    // this is what makes the disclosure self-retiring rather than date-maintained.
    const s = attributeSpend([session(FIRST_STEADY_MS)]);
    expect(s.totalUsd).toBeCloseTo(STEADY_USD, 9);
    expect(s.introPricedModels).toEqual([]);
    // A model that never had an intro rate is likewise absent.
    expect(attributeSpend([session(LAST_INTRO_MS, 'claude-sonnet-4-6')]).introPricedModels).toEqual(
      [],
    );
  });

  it('weekly buckets use the same tariff as the SPEND headline', () => {
    // Regression: computeWeeklySpend called turnCostUsd WITHOUT the turn timestamp, so
    // the weekly run-rate row priced Sonnet 5 at $3/$15 while the "actual" line above it
    // priced the same turns at $2/$10 — two figures 1.5x apart in the same card.
    const now = LAST_INTRO_MS;
    const sessions = [session(now - 2 * 24 * 60 * 60 * 1000)];
    const weekly = computeWeeklySpend(sessions, now).reduce((n, b) => n + b.usd, 0);
    expect(weekly).toBeCloseTo(attributeSpend(sessions).totalUsd, 9);
    expect(weekly).toBeCloseTo(INTRO_USD, 9);
  });
});
