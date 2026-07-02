import { describe, it, expect } from 'vitest';
import { ANTHROPIC_PRICING, OPENAI_PRICING, getAnthropicPricing } from '../vendor/pricing.js';

// Drift guard for the VENDORED pricing tables (src/vendor/pricing.ts) — ported
// verbatim from @promptster/config-cost's litellm-drift test so the hand-copied
// mirror can no longer silently diverge from the world (the exact failure that
// shipped 0.4.0 mis-pricing claude-sonnet-5/claude-mythos-5 as Sonnet-fallback).
//
// Our tables must agree with the LiteLLM community pricing DB (the same source
// ccusage uses). Network test that DEGRADES TO PASS when offline (CI stays
// non-flaky); when it can fetch, a rate disagreement is a hard FAIL and a model
// LiteLLM lists but we don't price is a WARN. We keep our own table at runtime
// (no network dep, and our 5m/1h cache-write split is finer than LiteLLM's
// single cache rate); this is purely a heads-up that the world moved.

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PER_M = 1_000_000;

interface LLEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

async function fetchLiteLLM(): Promise<Record<string, LLEntry> | null> {
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, LLEntry>;
  } catch {
    return null;
  }
}

// One fetch shared by both drift tests (lazy so merely importing the module
// doesn't hit the network). A failed fetch resolves to null — both tests then
// degrade to pass identically, exactly as before.
let litellmShared: Promise<Record<string, LLEntry> | null> | undefined;
const litellm = (): Promise<Record<string, LLEntry> | null> =>
  (litellmShared ??= fetchLiteLLM());

// LiteLLM rates are per-token; ours per-million. Agree within 0.1% (or exact).
const agree = (ours: number, theirsPerToken: number | undefined): boolean => {
  if (theirsPerToken == null) return true; // field absent upstream — can't cross-check
  const theirs = theirsPerToken * PER_M;
  return (
    Math.abs(ours - theirs) < 1e-9 || (theirs !== 0 && Math.abs(ours - theirs) / theirs < 0.001)
  );
};

describe('pricing drift vs LiteLLM (network; degrades to pass offline)', () => {
  it('Anthropic rates agree with LiteLLM; flags models we are missing', async () => {
    const ll = await litellm();
    if (!ll) {
      console.warn('[litellm-drift] could not fetch LiteLLM — skipping (offline)');
      return;
    }
    const mismatches: string[] = [];
    for (const [model, p] of Object.entries(ANTHROPIC_PRICING)) {
      const e = ll[model];
      if (!e) {
        console.warn(`[litellm-drift] LiteLLM has no entry for ${model} — can't cross-check`);
        continue;
      }
      if (!agree(p.input, e.input_cost_per_token))
        mismatches.push(
          `${model}.input: ours=${p.input} ll=${(e.input_cost_per_token ?? 0) * PER_M}`,
        );
      if (!agree(p.output, e.output_cost_per_token))
        mismatches.push(
          `${model}.output: ours=${p.output} ll=${(e.output_cost_per_token ?? 0) * PER_M}`,
        );
      if (!agree(p.cacheRead, e.cache_read_input_token_cost))
        mismatches.push(
          `${model}.cacheRead: ours=${p.cacheRead} ll=${(e.cache_read_input_token_cost ?? 0) * PER_M}`,
        );
      // COVERAGE GAP: LiteLLM has a single cache-creation rate, which maps to our
      // 5-minute cache-write rate. Our cacheWrite1hr rate has NO external
      // reference here and goes unverified — check Anthropic's published pricing
      // by hand when touching it.
      if (!agree(p.cacheWrite5min, e.cache_creation_input_token_cost))
        mismatches.push(
          `${model}.cacheWrite5min: ours=${p.cacheWrite5min} ll=${(e.cache_creation_input_token_cost ?? 0) * PER_M}`,
        );
    }
    // Coverage: any canonical Claude model (opus/sonnet/haiku/fable/mythos) LiteLLM
    // lists that we don't price — excluding provider-prefixed + date-suffixed ids.
    const missing = Object.keys(ll).filter(
      (m) =>
        /^claude-(opus|sonnet|haiku|fable|mythos)/.test(m) &&
        !m.includes('/') &&
        !m.includes(':') && // skip Bedrock-style "...-v1:0" variants
        !/-\d{8}/.test(m) &&
        !(m in ANTHROPIC_PRICING),
    );
    if (missing.length) console.warn(`[litellm-drift] not in our table: ${missing.join(', ')}`);

    expect(mismatches, `pricing drift:\n${mismatches.join('\n')}`).toEqual([]);
  }, 20_000);

  it('OpenAI rates agree with LiteLLM', async () => {
    const ll = await litellm();
    if (!ll) {
      console.warn('[litellm-drift] could not fetch LiteLLM — skipping (offline)');
      return;
    }
    const mismatches: string[] = [];
    for (const [model, p] of Object.entries(OPENAI_PRICING)) {
      const e = ll[model];
      if (!e) {
        console.warn(`[litellm-drift] LiteLLM has no entry for ${model} — can't cross-check`);
        continue;
      }
      if (!agree(p.input, e.input_cost_per_token))
        mismatches.push(
          `${model}.input: ours=${p.input} ll=${(e.input_cost_per_token ?? 0) * PER_M}`,
        );
      if (!agree(p.output, e.output_cost_per_token))
        mismatches.push(
          `${model}.output: ours=${p.output} ll=${(e.output_cost_per_token ?? 0) * PER_M}`,
        );
      if (!agree(p.cachedInput, e.cache_read_input_token_cost))
        mismatches.push(
          `${model}.cachedInput: ours=${p.cachedInput} ll=${(e.cache_read_input_token_cost ?? 0) * PER_M}`,
        );
    }
    expect(mismatches, `pricing drift:\n${mismatches.join('\n')}`).toEqual([]);
  }, 20_000);
});

// Offline regression pins for the 2026-07-02 re-sync — these fail even without
// network, so the exact staleness 0.4.0 shipped with can't recur unnoticed.
describe('vendored table covers current models (offline)', () => {
  it('prices claude-sonnet-5 and claude-mythos-5 (non-fallback)', () => {
    expect(getAnthropicPricing('claude-sonnet-5')).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite5min: 3.75,
      cacheWrite1hr: 6,
    });
    expect(getAnthropicPricing('claude-mythos-5')).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite5min: 12.5,
      cacheWrite1hr: 20,
    });
  });

  it('applies Sonnet 5 introductory pricing before the Sept 2026 cutoff', () => {
    const intro = getAnthropicPricing('claude-sonnet-5', new Date(Date.UTC(2026, 6, 2)));
    expect(intro).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite5min: 2.5,
      cacheWrite1hr: 4,
    });
    // At/after the cutoff — and with no timestamp — steady-state rates apply.
    expect(getAnthropicPricing('claude-sonnet-5', new Date(Date.UTC(2026, 8, 1)))?.input).toBe(3);
    expect(getAnthropicPricing('claude-sonnet-5')?.input).toBe(3);
    // Intro override also resolves through the vendor prefix, like the base lookup.
    expect(
      getAnthropicPricing('anthropic/claude-sonnet-5', new Date(Date.UTC(2026, 6, 2)))?.input,
    ).toBe(2);
  });
});
