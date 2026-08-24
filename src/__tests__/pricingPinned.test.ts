import { describe, it, expect } from 'vitest';
import { OPENAI_PRICING } from '../vendor/pricing.js';

// Offline companion to pricingDrift.test.ts, added on review of #29.
//
// WHY BOTH. `pricingDrift` compares this table against LiteLLM and is the only thing that
// can notice the WORLD moving — but it DEGRADES TO PASS when it cannot fetch, which is
// correct (CI must not be flaky on a network blip) and which means it proves nothing
// offline. So a regression of the exact rows it just corrected would sail through any
// offline or network-degraded run. These two tests answer different questions:
//
//   pricingDrift   — has the vendor changed the price?         (needs network, may skip)
//   this file      — has OUR table changed underneath us?      (deterministic, always runs)
//
// Only rows with a specific reason to be pinned belong here. Pinning all 29 would turn
// every legitimate vendor repricing into a two-file edit and train people to update the
// expectation to match the code, which is the exact habit that lets a wrong rate ship.
describe('OpenAI rates that have already regressed once', () => {
  // gpt-5.6 terra and luna were repriced after GA. This table carried the LAUNCH tiers
  // for two weeks after promptster-backend corrected its own copy (2026-07-31), because
  // the two tables are hand-copied with no dependency between them. Published 0.7.0 went
  // out with luna 5x over. Restoring the launch numbers from a launch-day source is the
  // specific regression this pins.
  it('gpt-5.6-terra and gpt-5.6-luna hold the POST-repricing rates', () => {
    expect(OPENAI_PRICING['gpt-5.6-terra']).toEqual({ input: 2, cachedInput: 0.2, output: 12, cacheWrite: 2.5 });
    expect(OPENAI_PRICING['gpt-5.6-luna']).toEqual({ input: 0.2, cachedInput: 0.02, output: 1.2, cacheWrite: 0.25 });
    // The launch tiers, named so a diff that reintroduces them is unmistakable.
    expect(OPENAI_PRICING['gpt-5.6-terra']!.input).not.toBe(2.5);
    expect(OPENAI_PRICING['gpt-5.6-luna']!.input).not.toBe(1);
  });

  // Then it happened AGAIN, one model over, and the pin above could not see it because
  // it names two keys rather than the family. OpenAI repriced gpt-5.6 / gpt-5.6-sol off
  // the GPT-5.5 tier on 2026-08-22; promptster-backend corrected config-cost the same
  // day (#780, d2357e89) and this mirror carried 5/0.5/30 until 2026-08-24 — 25% over on
  // input, 50% over on output. Same mechanism as terra/luna: a hand-copied table with no
  // subscriber to the repo it was copied from.
  it('gpt-5.6 and gpt-5.6-sol hold the POST-repricing rates, not the GPT-5.5 tier', () => {
    expect(OPENAI_PRICING['gpt-5.6']).toEqual({ input: 4, cachedInput: 0.4, output: 20, cacheWrite: 5 });
    expect(OPENAI_PRICING['gpt-5.6-sol']).toEqual({ input: 4, cachedInput: 0.4, output: 20, cacheWrite: 5 });
    // The GPT-5.5 tier they used to be pegged to, named so a diff that restores it —
    // e.g. by re-deriving Sol's price from "Sol matches GPT-5.5" — is unmistakable.
    expect(OPENAI_PRICING['gpt-5.6']!.input).not.toBe(OPENAI_PRICING['gpt-5.5']!.input);
    expect(OPENAI_PRICING['gpt-5.6-sol']!.output).not.toBe(30);
  });

  // The cacheWrite AXIS, added to this table on the 2026-08-24 re-sync from config-cost
  // (upstream added it 2026-08-12). It is pinned as a RULE rather than per-row because the
  // failure it guards is structural: OpenAI introduced a cache-write premium at the GPT-5.6
  // GA (2026-07-09), and a table with no field for it priced every 5.6 write at the plain
  // input rate — 20% under. Note what could NOT have caught that: pricingDrift compares
  // input / cachedInput / output, the fields present on both sides, so a missing rate AXIS
  // is invisible to it however green it runs. The review that matters is "did the vendor add
  // a new KIND of charge", not "did a number move".
  //
  // `cacheWrite` equal to input is NOT the same as free — a written token is an ordinary
  // input token below 5.6, and setting it to 0 would make real input free on any row that
  // reports a write count.
  it('cacheWrite is 1.25x input on GPT-5.6+, and equal to input below it', () => {
    for (const [model, p] of Object.entries(OPENAI_PRICING)) {
      const premium = model.startsWith('gpt-5.6');
      expect(p.cacheWrite, `${model} carries a cacheWrite rate`).toBeTypeOf('number');
      expect(p.cacheWrite, `${model}: ${premium ? '5.6+ premium' : 'no write fee'}`).toBeCloseTo(
        premium ? p.input * 1.25 : p.input,
        6,
      );
      // Never 0. A rate meaning "no special price" must still bill.
      expect(p.cacheWrite, `${model} cacheWrite must not be 0`).toBeGreaterThan(0);
    }
  });

  it('cached input stays 10% of input, except where the vendor says otherwise', () => {
    // The table header states this as an invariant. A repricing that breaks it is far
    // more likely a transcription slip than a real vendor change, so failing here makes
    // someone confirm rather than assume.
    //
    // The exceptions are NAMED, not pattern-matched. The header used to derive them from
    // the word "pro" in the model id, and that rule was already false: gpt-5.4-pro and
    // gpt-5.5-pro publish an ordinary 10% cached rate (3/M, confirmed against LiteLLM
    // 2026-08-14) which this table correctly carries. A name-shaped rule would have
    // "corrected" them to equal-input and over-billed every cached token they read.
    // A NEW exception fails this test on purpose: it should arrive with a reason.
    const EXCEPTIONS: Record<string, 'no-published-cached-rate' | 'vendor-rate-is-25pct'> = {
      'gpt-5-pro': 'no-published-cached-rate',
      'gpt-5.2-pro': 'no-published-cached-rate',
      'codex-mini-latest': 'vendor-rate-is-25pct',
    };
    for (const [model, p] of Object.entries(OPENAI_PRICING)) {
      const why = EXCEPTIONS[model];
      if (why === 'no-published-cached-rate') {
        // Equal to input, deliberately: never discount a rate the vendor has not published.
        expect(p.cachedInput, `${model}: ${why}`).toBe(p.input);
        continue;
      }
      if (why === 'vendor-rate-is-25pct') {
        expect(p.cachedInput, `${model}: ${why}`).toBeCloseTo(p.input * 0.25, 6);
        continue;
      }
      expect(p.cachedInput, `${model} cached should be 10% of input`).toBeCloseTo(p.input / 10, 6);
    }
  });
});
