// Per-turn cost in USD, reusing the vendored config-cost authoritative pricing
// tables (src/vendor/pricing.ts). We compute directly from the pricing object
// (not computeCost) so we can bill the 5-minute vs 1-hour cache-write buckets at
// their distinct rates — that precision matters for the ±5% reconciliation gate.

import { getAnthropicPricing, getOpenAIPricing } from './vendor/pricing.js';
import type { TurnUsage } from './model.js';

// Sonnet-tier fallback for an unrecognized model id — never crash, but the report
// flags any spend that hit this path so a missing price can't silently distort.
const FALLBACK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5min: 3.75, cacheWrite1hr: 6 };

/** The five-bucket Anthropic arithmetic, in one place. Both tariff passes below go
 *  through this so the billed figure and the steady-state figure can never drift
 *  apart by anything other than the rates handed in. */
function anthropicUsd(p: AnthropicRates, u: TurnUsage): number {
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite5m * p.cacheWrite5min +
      u.cacheWrite1h * p.cacheWrite1hr) /
    1_000_000
  );
}

type AnthropicRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5min: number;
  cacheWrite1hr: number;
};

export interface TariffCost {
  /** What the turn actually cost — the rate Anthropic bills for that timestamp. */
  usd: number;
  /** False when no table entry matched and the Sonnet-tier fallback was substituted. */
  priced: boolean;
  /**
   * The same turn at the model's STEADY-STATE rate, ignoring any dated
   * introductory window. Equal to `usd` whenever no intro rate applied.
   *
   * This is NOT an error bar — `usd` is the invoice. It exists because other tools
   * price a model inside its introductory window at the steady-state sticker
   * instead (Claude Code's own cost figure does exactly this for Sonnet 5), so a
   * reader reconciling the two needs the second number NAMED rather than left as
   * an unexplained multiple. See the SPEND card's introductory-rate disclosure.
   */
  steadyStateUsd: number;
}

/**
 * Cost of one assistant turn at both the billed and the steady-state tariff.
 * Pass the turn's epoch-ms timestamp (`AssistantTurn.ts`) as `ts` so dated
 * introductory pricing (e.g. Sonnet 5 until Sept 2026) prices historical usage at
 * the rate that was actually billed; omitting it uses the steady-state rate for
 * both figures.
 */
export function turnCostTariffs(
  model: string | null,
  u: TurnUsage,
  ts?: number | null,
): TariffCost {
  const at = ts != null ? new Date(ts) : undefined;
  const a = model ? getAnthropicPricing(model, at) : null;
  if (a) {
    // Second lookup with no timestamp = the steady-state (base-table) row. When no
    // intro window covers `at`, both lookups return the same rates and the two
    // figures are identical, so the disclosure stays silent on its own.
    const steady = getAnthropicPricing(model!) ?? a;
    return { usd: anthropicUsd(a, u), priced: true, steadyStateUsd: anthropicUsd(steady, u) };
  }
  const o = model ? getOpenAIPricing(model) : null;
  if (o) {
    // OpenAI auto-cache: cached input bills at `cachedInput`, written input at
    // `cacheWrite`. No OpenAI model carries a dated introductory rate, so
    // steady-state == billed.
    //
    // THIS USED TO SAY "no separate write bucket" and bill writes at `o.input`.
    // That was true until the GPT-5.6 GA (2026-07-09), when OpenAI started charging
    // a write premium; `cacheWrite` is 1.25x input on 5.6+ and EQUALS input below it,
    // so the old line was exactly right on every pre-5.6 model and 20% under on 5.6+.
    // The rate is per-model precisely so the cutover is not a version check here.
    //
    // `u` is the ADDITIVE five-bucket shape (see TurnUsage): `input` is the UNCACHED
    // remainder, disjoint from cacheRead/cacheWrite. OpenAI's wire format is the
    // opposite — `input_tokens` is the total and the cache buckets are subsets — so
    // the Codex adapter subtracts them out. Do not add a subset clamp here; by this
    // point the split has already happened.
    const usd =
      (u.input * o.input +
        u.output * o.output +
        u.cacheRead * o.cachedInput +
        (u.cacheWrite5m + u.cacheWrite1h) * o.cacheWrite) /
      1_000_000;
    return { usd, priced: true, steadyStateUsd: usd };
  }
  const usd = anthropicUsd(FALLBACK, u);
  return { usd, priced: false, steadyStateUsd: usd };
}

/**
 * Cost of one assistant turn. Pass the turn's epoch-ms timestamp (`AssistantTurn.ts`)
 * as `ts` so dated introductory pricing (e.g. Sonnet 5 until Sept 2026) reprices
 * historical usage at the rate that was actually billed; omitting it uses the
 * steady-state table rate.
 *
 * Callers that need to explain a divergence from another tool's figure want
 * {@link turnCostTariffs}, which also returns the steady-state price.
 */
export function turnCostUsd(
  model: string | null,
  u: TurnUsage,
  ts?: number | null,
): { usd: number; priced: boolean } {
  const { usd, priced } = turnCostTariffs(model, u, ts);
  return { usd, priced };
}

export function turnTokens(u: TurnUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** Per-TOKEN cache-read and cache-write ($/token) rates for a model — the two prices the
 *  compact counterfactual turns on: carried context is cache-READ into every later turn,
 *  and the compacted summary is cache-WRITTEN once (Anthropic's 5-minute write bucket, the
 *  1.25× input rate). OpenAI bills its own write rate — `cacheWrite`, equal to input below
 *  GPT-5.6 and 1.25x input from 5.6 on. Unknown model ⇒ the Sonnet-tier fallback, matching
 *  turnCostUsd.
 *
 *  This used to read "OpenAI has no separate cache write" and price re-caching at the
 *  uncached input rate. Understating the write side biases the counterfactual TOWARD
 *  compacting, which is the direction that costs the reader money. */
export function cacheRatesUsdPerToken(model: string | null): { cacheRead: number; cacheWrite: number } {
  const a = model ? getAnthropicPricing(model) : null;
  if (a) return { cacheRead: a.cacheRead / 1_000_000, cacheWrite: a.cacheWrite5min / 1_000_000 };
  const o = model ? getOpenAIPricing(model) : null;
  if (o) return { cacheRead: o.cachedInput / 1_000_000, cacheWrite: o.cacheWrite / 1_000_000 };
  return { cacheRead: FALLBACK.cacheRead / 1_000_000, cacheWrite: FALLBACK.cacheWrite5min / 1_000_000 };
}

const PREMIUM_PREFIXES = ['claude-opus', 'claude-fable', 'gpt-5.5', 'claude-mythos'];
export function isPremiumModel(model: string | null): boolean {
  return !!model && PREMIUM_PREFIXES.some((p) => model.startsWith(p));
}
