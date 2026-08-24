import { describe, it, expect } from 'vitest';
import { cacheRatesUsdPerToken, turnCostTariffs } from '../pricing.js';
import { OPENAI_PRICING } from '../vendor/pricing.js';
import type { TurnUsage } from '../model.js';

// The OpenAI cache-WRITE rate, and why this file exists.
//
// `pricing.ts` used to bill written tokens at `o.input` under a comment reading
// "OpenAI auto-cache: cached input billed at cachedInput; no separate write bucket".
// That was correct until the GPT-5.6 GA (2026-07-09), when OpenAI began charging a
// write premium. From then until the 2026-08-24 re-sync the vendored table had no
// field to bill it from, so every 5.6 cache write was priced 20% under.
//
// The interesting part is what NOTICED, and the answer is nothing: `pricingDrift`
// cross-checks input / cachedInput / output — the fields that exist on both sides of
// the comparison — so an absent rate AXIS is invisible to it no matter how green it
// runs. These assertions are the axis's only guard, which is why they name the OLD
// arithmetic explicitly rather than only asserting the new number.
//
// Note also what the LOCAL corpus can and cannot prove: all 2504 `token_count` rows
// under ~/.codex report `cache_write_input_tokens: 0`, so no real session on this
// machine exercises this path. The usage below is therefore synthetic ON PURPOSE — a
// test that could only run on data we happen to have would have been satisfied by the
// broken code too.

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...over,
});

describe('OpenAI cache-write pricing', () => {
  it('bills a GPT-5.6 write at 1.25x input, not at the input rate', () => {
    const write = 1_000_000;
    const { usd, priced } = turnCostTariffs('gpt-5.6-sol', usage({ cacheWrite5m: write }));
    expect(priced).toBe(true);
    // sol: input 4, cacheWrite 5.
    expect(usd).toBeCloseTo(5, 9);
    // The pre-fix arithmetic, named so restoring it is unmistakable.
    const atInputRate = (write * OPENAI_PRICING['gpt-5.6-sol']!.input) / 1_000_000;
    expect(atInputRate).toBeCloseTo(4, 9);
    expect(usd).not.toBeCloseTo(atInputRate, 6);
    // The old code was under by exactly a fifth.
    expect(atInputRate / usd).toBeCloseTo(0.8, 9);
  });

  it('bills a pre-5.6 write at the input rate — unchanged, and not zero', () => {
    const write = 1_000_000;
    const { usd } = turnCostTariffs('gpt-5.5', usage({ cacheWrite5m: write }));
    // gpt-5.5 has no write fee, so `cacheWrite` equals `input` (5) rather than 0.
    // Equal-to-input is the whole point: a written token is an ordinary input token
    // here, and a 0 rate would have made real input free.
    expect(usd).toBeCloseTo(5, 9);
    expect(usd).toBeGreaterThan(0);
  });

  it('sums both write slots against the single OpenAI rate', () => {
    // The Codex adapter parks OpenAI's one write bucket in `cacheWrite5m`. Nothing may
    // depend on which slot it picked, because Codex reports no TTL split to honour.
    const split = turnCostTariffs('gpt-5.6', usage({ cacheWrite5m: 400_000, cacheWrite1h: 600_000 }));
    const all5m = turnCostTariffs('gpt-5.6', usage({ cacheWrite5m: 1_000_000 }));
    const all1h = turnCostTariffs('gpt-5.6', usage({ cacheWrite1h: 1_000_000 }));
    expect(split.usd).toBeCloseTo(all5m.usd, 9);
    expect(all1h.usd).toBeCloseTo(all5m.usd, 9);
  });

  it('prices the three input-side buckets at three distinct rates', () => {
    // Guards the whole additive split at once: if the adapter's subtraction and this
    // arithmetic ever disagree about which bucket is which, one of these terms moves.
    const { usd } = turnCostTariffs(
      'gpt-5.6-sol',
      usage({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, output: 1_000_000 }),
    );
    // 4 (uncached) + 0.4 (cached) + 5 (written) + 20 (output)
    expect(usd).toBeCloseTo(29.4, 9);
  });

  it('cacheRatesUsdPerToken reports the write rate, not the input rate', () => {
    // This is the compaction counterfactual's write price. Understating it biases the
    // recommendation TOWARD compacting, which is the direction that costs money.
    const sol = cacheRatesUsdPerToken('gpt-5.6-sol');
    expect(sol.cacheWrite).toBeCloseTo(5 / 1_000_000, 15);
    expect(sol.cacheRead).toBeCloseTo(0.4 / 1_000_000, 15);
    expect(sol.cacheWrite).not.toBeCloseTo(4 / 1_000_000, 15);

    // Below 5.6 the two coincide — the same number, now for a stated reason.
    const older = cacheRatesUsdPerToken('gpt-5.5');
    expect(older.cacheWrite).toBeCloseTo(5 / 1_000_000, 15);
  });

  it('leaves the Anthropic arm on its own two write rates', () => {
    // Anthropic bills 5-minute and 1-hour writes differently; the OpenAI collapse must
    // not have leaked across the branch.
    const w5 = turnCostTariffs('claude-opus-4-6', usage({ cacheWrite5m: 1_000_000 }));
    const w1 = turnCostTariffs('claude-opus-4-6', usage({ cacheWrite1h: 1_000_000 }));
    expect(w5.usd).toBeGreaterThan(0);
    expect(w1.usd).toBeGreaterThan(w5.usd);
  });
});
