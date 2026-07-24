import { describe, it, expect } from 'vitest';
import { getAnthropicPricing, getOpenAIPricing } from '../vendor/pricing.js';
import { turnCostUsd } from '../pricing.js';
import { attributeSpend } from '../attribute.js';
import { runAudit } from '../audit.js';
import { renderReport } from '../report.js';
import type { AssistantTurn, Session, Span, TurnUsage } from '../model.js';

// Regression suite for the drift that shipped v0.5.0: the vendored table was 4
// commits behind @promptster/config-cost, so `claude-opus-5` had no row, fell to
// the Sonnet-tier fallback, and was billed 40% low ($121.51 vs $202.52 across
// 1,528 real turns) — with NO warning, because the fallback share (0.47%) sat
// under the report's 2% threshold. Two distinct failures, tested separately:
// the missing rate, and the silence about it.

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...over,
});

const turn = (model: string | null, u: Partial<TurnUsage> = {}): AssistantTurn => ({
  model,
  usage: usage(u),
  tools: [],
  reads: [],
  thinkingChars: 0,
  textChars: 0,
  ts: null,
  mode: null,
  toolResultTs: null,
  toolErrorCount: 0,
});

const span = (turns: AssistantTurn[]): Span => ({
  promptId: 'p1',
  command: null,
  invokedSkills: [],
  firstUserText: '',
  turns,
  isSidechain: false,
  autoCompacted: false,
  attributionSkill: null,
  attributionAgent: null,
  userTs: null,
});

const session = (turns: AssistantTurn[]): Session => ({
  sessionId: 's1',
  project: 'proj',
  cwd: null,
  mtime: 0,
  modes: [],
  spans: [span(turns)],
});

describe('pricing table coverage', () => {
  it('prices claude-opus-5 at its own rate, not the Sonnet fallback', () => {
    const p = getAnthropicPricing('claude-opus-5');
    expect(p).not.toBeNull();
    expect(p!.input).toBe(5);
    expect(p!.output).toBe(25);

    // The end-to-end number, at the token mix that exposed it.
    const { usd, priced } = turnCostUsd('claude-opus-5', usage({ output: 1_000_000 }));
    expect(priced).toBe(true);
    expect(usd).toBeCloseTo(25, 6); // 15 under the Sonnet fallback
  });

  it('resolves bracketed context variants (claude-opus-4-8[1m]) via prefix match', () => {
    // These are real ids in Claude Code transcripts. A date-suffix-only matcher
    // (as used for OpenAI) would drop them to the fallback — do not tighten the
    // Anthropic prefix leg without handling this shape.
    const p = getAnthropicPricing('claude-opus-4-8[1m]');
    expect(p).not.toBeNull();
    expect(p!.input).toBe(getAnthropicPricing('claude-opus-4-8')!.input);
  });

  it('does not let OpenAI family members inherit a shorter key’s price', () => {
    // gpt-5-pro billed at gpt-5 rates was 12x under; gpt-5-nano was 25x over.
    expect(getOpenAIPricing('gpt-5-pro')!.input).toBe(15);
    expect(getOpenAIPricing('gpt-5-nano')!.input).toBe(0.05);
    expect(getOpenAIPricing('gpt-5.6')!.input).toBe(5);
    // A dated variant still resolves to its base model.
    expect(getOpenAIPricing('gpt-5.2-codex-2026-05-01')!.input).toBe(1.75);
    // An unknown id resolves to null rather than silently inheriting.
    expect(getOpenAIPricing('gpt-5-imaginary')).toBeNull();
  });
});

describe('unknown-model reporting', () => {
  const sessions = [
    session([
      turn('claude-sonnet-4-6', { output: 10_000_000 }), // $150 — the bulk
      turn('made-up-model-9', { output: 10_000 }), // pennies — a tiny share
    ]),
  ];

  it('names every unpriced model id in the spend breakdown', () => {
    const spend = attributeSpend(sessions);
    expect(spend.unpricedModels).toHaveLength(1);
    expect(spend.unpricedModels[0]!.model).toBe('made-up-model-9');
    expect(spend.unpricedModels[0]!.turns).toBe(1);
    // The exact condition that hid claude-opus-5: well under the 2% share gate.
    expect(spend.unpricedShare).toBeLessThan(0.02);
  });

  it('surfaces the id in the report even when its share is below the 2% gate', () => {
    const out = renderReport(runAudit(sessions, '2026-07-24T00:00:00Z'));
    expect(out).toContain('made-up-model-9');
    expect(out).toContain('no pricing-table entry');
  });

  it('says nothing when every model is priced', () => {
    const clean = [session([turn('claude-sonnet-4-6', { output: 1000 })])];
    expect(attributeSpend(clean).unpricedModels).toEqual([]);
    const out = renderReport(runAudit(clean, '2026-07-24T00:00:00Z'));
    expect(out).not.toContain('no pricing-table entry');
  });
});
