// ---------------------------------------------------------------------------
// VENDORED from @promptster/config-cost (packages/config-cost/src/pricing.ts).
// Last synced: 2026-07-24 via scripts/sync-pricing.mjs — do not hand-edit; re-run
// the script against a fresh backend checkout instead.
//
// ⚠️  DRIFT RISK — this is a hand-copied mirror, not a package dependency.
// When this repo was split out of the promptster-backend monorepo, config-cost
// was a `workspace:*` dependency that doesn't exist on npm, which forced the old
// esbuild bundle-hack to publish. Vendoring the tables unblocked the split.
//
// The PROPER fix is publishing @promptster/config-cost as a standalone npm
// package during pricing centralization, then depending on it here and deleting
// this file (follow-up — see README "Vendored pricing").
//
// Until then: if Anthropic/OpenAI pricing changes, update this file AND the
// upstream config-cost table together. Two guards keep them in lockstep:
//   - src/__tests__/pricingDrift.test.ts — the litellm-drift test (ported from
//     config-cost) cross-checks these tables against LiteLLM's pricing DB in CI.
//   - scripts/sync-pricing.mjs — re-copies this file from a sibling backend
//     checkout (see MAINTAINING.md "Vendored pricing").
//
// Mirrored verbatim (no edits) so a future re-sync is a straight file copy. The
// sha256 below is of the upstream body as copied; sync-pricing.mjs re-checks it and
// refuses to overwrite a hand-edited mirror. Fix pricing bugs UPSTREAM in config-cost
// and re-sync — an edit made only here is reverted by the next sync.
// Upstream-body-sha256: b4aec689142ba072ba444d34cc5c4e4585b0d593a01496c92100217d808b8158
// ---------------------------------------------------------------------------

// ── Anthropic ──────────────────────────────────────────────────────────────

export interface AnthropicModelPricing {
  /** Per-million-token rates in USD */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5min: number;
  cacheWrite1hr: number;
}

export interface ComputeCostParams {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Defaults to 5min cache write rate (most common for per-request caching) */
  cacheWriteTokens?: number;
  /** Turn timestamp — selects dated introductory pricing when applicable. */
  at?: Date;
}

// Static pricing table (verified April 2026).
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Cache multipliers: read = 0.1x input, 5min write = 1.25x input, 1hr write = 2x input.
export const ANTHROPIC_PRICING: Record<string, AnthropicModelPricing> = {
  // ── Claude Fable 5 (verified June 2026: $10/$50, standard cache multipliers) ──
  'claude-fable-5': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite5min: 12.5,
    cacheWrite1hr: 20,
  },
  // ── Claude Mythos 5 (limited availability; same rates as claude-fable-5) ──
  'claude-mythos-5': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite5min: 12.5,
    cacheWrite1hr: 20,
  },
  // ── Claude Opus 5 (verified July 2026: $5/$25, standard cache multipliers —
  // same rates as the 4.x Opus line). NOTE: Opus 5 (and 4.8) support a "fast
  // mode" request flag billed at the Fable tier ($10/$50). That is a per-request
  // parameter, not a distinct model id, and our usage telemetry carries no speed
  // field — a fast-mode turn arrives as plain "claude-opus-5" and is priced here
  // at the standard rate. Under-counts fast-mode spend by 2×; needs a capture-
  // side field before it can be priced. ──
  'claude-opus-5': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5min: 6.25,
    cacheWrite1hr: 10,
  },
  // ── Claude 4.8 / 4.7 (verified June 2026: $5/$25, standard cache multipliers) ──
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5min: 6.25,
    cacheWrite1hr: 10,
  },
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5min: 6.25,
    cacheWrite1hr: 10,
  },
  // ── Claude Sonnet 5 (steady-state rates; intro pricing is handled by the
  // dated INTRO_PRICING override below) ──
  'claude-sonnet-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite5min: 3.75,
    cacheWrite1hr: 6,
  },
  // ── Claude 4.6 ──
  'claude-opus-4-6': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5min: 6.25,
    cacheWrite1hr: 10,
  },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite5min: 3.75,
    cacheWrite1hr: 6,
  },
  // ── Claude 4.5 ──
  'claude-opus-4-5': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5min: 6.25,
    cacheWrite1hr: 10,
  },
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite5min: 3.75,
    cacheWrite1hr: 6,
  },
  // Undated canonical (matches LiteLLM) + dated variant. The undated key also
  // prefix-matches any future date suffix; both rate-identical.
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite5min: 1.25,
    cacheWrite1hr: 2,
  },
  'claude-haiku-4-5-20251001': {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite5min: 1.25,
    cacheWrite1hr: 2,
  },
  // ── Claude 4 ──
  'claude-sonnet-4-20250514': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite5min: 3.75,
    cacheWrite1hr: 6,
  },
  'claude-opus-4-20250514': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite5min: 18.75,
    cacheWrite1hr: 30,
  },
  // ── Claude 4.1 ──
  'claude-opus-4-1': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite5min: 18.75,
    cacheWrite1hr: 30,
  },
  // ── Claude 3.5 ──
  'claude-3-5-haiku-20241022': {
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite5min: 1,
    cacheWrite1hr: 1.6,
  },
};

const SONNET_FALLBACK = ANTHROPIC_PRICING['claude-sonnet-4-6']!;

// Models with dated introductory pricing. Anthropic bills by the date usage
// occurred; since we recompute historical cost from stored tokens, pick the tier
// by the turn's timestamp — a flat table entry would reprice old usage at the new
// rate. `until` is the first instant the steady-state (base-table) rate applies.
// After the cutoff these entries go inert and can be removed.
const INTRO_PRICING: Array<{ model: string; until: number; rates: AnthropicModelPricing }> = [
  {
    model: 'claude-sonnet-5',
    until: Date.UTC(2026, 8, 1), // Sept 1 2026 00:00 UTC (month is 0-indexed: 8 = September)
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5min: 2.5, cacheWrite1hr: 4 },
  },
];

/**
 * Look up static Anthropic pricing for a model ID.
 * Tries: exact match → strip vendor prefix → prefix match (ignore date suffix).
 * Returns null if not an Anthropic model.
 *
 * When `at` is supplied and falls before a model's dated introductory cutoff,
 * the introductory rate is returned instead of the steady-state base entry.
 * Omitting `at` always yields the steady-state (forward-looking) rate.
 */
export function getAnthropicPricing(model: string, at?: Date): AnthropicModelPricing | null {
  // Resolve the BASE (steady-state) entry first, tracking the canonical table
  // key it resolved to so the intro override below can match on that key rather
  // than on a fuzzy string prefix.
  const stripped = model.replace(/^[^/]+\//, '');
  let base: AnthropicModelPricing | null = null;
  let matchedKey: string | null = null;
  if (ANTHROPIC_PRICING[model]) {
    base = ANTHROPIC_PRICING[model]!;
    matchedKey = model;
  } else if (stripped !== model && ANTHROPIC_PRICING[stripped]) {
    base = ANTHROPIC_PRICING[stripped]!;
    matchedKey = stripped;
  } else {
    // Prefix match — handle dated variants (e.g. "claude-opus-4-6-20260301")
    for (const key of Object.keys(ANTHROPIC_PRICING)) {
      if (stripped.startsWith(key)) {
        base = ANTHROPIC_PRICING[key] ?? null;
        matchedKey = key;
        break;
      }
    }
  }

  if (!base) return null;

  // Apply a dated introductory override only when a timestamp is supplied and it
  // is before the cutoff. Match on the resolved canonical key, NOT a string
  // prefix: a dated variant (e.g. "claude-sonnet-5-20260901") resolves to the
  // "claude-sonnet-5" key and gets intro pricing, but a distinct sibling model
  // (e.g. a future "claude-sonnet-5-mini" with its own table entry) exact-matches
  // its own key and is never swept into Sonnet 5's introductory rates.
  if (at) {
    for (const entry of INTRO_PRICING) {
      if (matchedKey === entry.model && at.getTime() < entry.until) return entry.rates;
    }
  }

  return base;
}

/**
 * A cost figure plus whether it was actually PRICED or merely estimated from a
 * fallback rate.
 *
 * The two are not interchangeable and the codebase already knows it in one half:
 * `turnCostUsd` (fleet telemetry) returns exactly this shape and reports
 * `priced: false` rather than invent a rate. The other half — our OWN judge
 * spend — flows through `computeCost`/`computeOpenAICost`, which silently
 * substitute a fallback and hand back a bare number that reads as fact.
 *
 * That asymmetry is the dangerous direction. An unpriced FLEET turn collapses to
 * $0 and disappears, which is at least detectable by absence. An unpriced JUDGE
 * call gets a plausible, specific, wrong dollar figure emitted to PostHog
 * `$ai_generation` — and a number that looks right is never questioned. It is
 * the same failure that let `gpt-5-pro` bill at `gpt-5` rates: not a crash, not a
 * zero, just a confident lie.
 */
export interface PricedCost {
  usd: number;
  /** False when no table entry matched and a fallback rate was substituted. */
  priced: boolean;
  /** The fallback's model id when `priced` is false — for logging. */
  fallbackModel?: string;
}

/** The model whose rates stand in for an unrecognized Anthropic id. */
export const ANTHROPIC_FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Compute the USD cost for an Anthropic API call, reporting whether the rate was
 * real. Prefer this over {@link computeCost} anywhere the figure is published,
 * billed against, or shown to a human — it is the same math, and the only
 * difference is that it admits when it is guessing.
 */
export function computeCostPriced(params: ComputeCostParams): PricedCost {
  const matched = getAnthropicPricing(params.model, params.at);
  const p = matched ?? SONNET_FALLBACK;
  const usd =
    (params.inputTokens * p.input +
      params.outputTokens * p.output +
      (params.cacheReadTokens ?? 0) * p.cacheRead +
      (params.cacheWriteTokens ?? 0) * p.cacheWrite5min) /
    1_000_000;
  return matched
    ? { usd, priced: true }
    : { usd, priced: false, fallbackModel: ANTHROPIC_FALLBACK_MODEL };
}

/**
 * Compute the USD cost for an Anthropic API call.
 * Synchronous — uses the static pricing table with Sonnet-tier fallback.
 * Cache write tokens use the 5-minute rate by default.
 *
 * Returns a bare number, so an unpriced model is indistinguishable from a priced
 * one. Use {@link computeCostPriced} when that distinction matters.
 */
export function computeCost(params: ComputeCostParams): number {
  return computeCostPriced(params).usd;
}

/**
 * @deprecated Use `computeCost()` instead — this drops cache tokens.
 */
export function computeSimpleCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return computeCost({ model, inputTokens, outputTokens });
}

// ── OpenAI (Codex / Responses API) ──────────────────────────────────────────

export interface OpenAIModelPricing {
  /** Per-million-token rates in USD */
  input: number;
  /** Cached-input rate — OpenAI bills cached prompt tokens at a discount. */
  cachedInput: number;
  output: number;
}

export interface ComputeOpenAICostParams {
  model: string;
  /**
   * TOTAL input tokens as reported by the Responses API `usage.input_tokens`.
   * INCLUDES cached tokens (unlike Anthropic, where cache reads are a separate
   * bucket). We subtract `cachedTokens` before applying the full input rate so
   * cached tokens are billed once, at the discounted rate.
   */
  inputTokens: number;
  /** `usage.input_tokens_details.cached_tokens` — the cached subset of input. */
  cachedTokens?: number;
  /** `usage.output_tokens` — already includes reasoning tokens. */
  outputTokens: number;
}

// Static OpenAI pricing table (terra/luna re-verified 2026-08-14; rest July 2026).
// Source: https://openai.com/api/pricing/ and https://developers.openai.com/codex/pricing
//
// THIS TABLE IS A HAND-COPIED MIRROR of promptster-backend `packages/config-cost`,
// and it has no subscriber to that repo — cc-audit deliberately does not depend on it.
// So the mirror goes stale silently, and did: the backend corrected gpt-5.6-terra and
// gpt-5.6-luna on 2026-07-31 and this copy kept the launch tiers for two more weeks.
// `pricingDrift.test.ts` is the only thing that notices, which is why a red run there
// is not a test to relax. Its own instruction, from the commit that fixed the backend
// side: find out who is right, do not update the expectation.
//
// Cached input is 10% of the standard input rate across the GPT-5 family, with THREE
// exceptions — all re-verified against LiteLLM 2026-08-14 and pinned by
// pricingPinned.test.ts, which fails if a fourth appears without a reason:
//   gpt-5-pro, gpt-5.2-pro  no published cached rate, so cachedInput is set EQUAL to
//                           input; a stray cached-token count then cannot under-bill.
//                           The discount has to be published before we apply it.
//   codex-mini-latest       genuinely 25%, not 10%.
//
// THIS COMMENT USED TO SAY "the `pro` tiers publish no cached-input rate". That is now
// FALSE: gpt-5.4-pro and gpt-5.5-pro DO publish one (3/M — the ordinary 10%) and the rows
// below correctly carry it. Do not "restore" them to equal-input on the strength of a
// tier-name rule; it would over-bill every cached token they read. The exception is a
// property of what the vendor PUBLISHES, not of the word "pro" in the model name.
//
// Codex variants (e.g. gpt-5.2-codex) are priced identically to their base model.
export const OPENAI_PRICING: Record<string, OpenAIModelPricing> = {
  // ── GPT-5.6 (GA 2026-07-09) ──
  // Sol matches the GPT-5.5 tier. Terra and Luna were REPRICED after GA — the launch
  // tiers were 2.5/15 and 1/6, and this table carried them until 2026-08-14. Do not
  // "restore" them from a launch-day source; the numbers below are the current ones.
  'gpt-5.6': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  // ── GPT-5.5 ──
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-codex': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-pro': { input: 30, cachedInput: 3, output: 180 },
  // ── GPT-5.4 ──
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-codex': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30, cachedInput: 3, output: 180 },
  // ── GPT-5.3 (Codex line; `spark` is the low-latency variant, same rates) ──
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex-spark': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-chat-latest': { input: 1.75, cachedInput: 0.175, output: 14 },
  // ── GPT-5.2 ──
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-chat-latest': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, cachedInput: 21, output: 168 },
  // ── GPT-5.1 ──
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  // ── GPT-5 (legacy) ──
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5-pro': { input: 15, cachedInput: 15, output: 120 },
  // Codex CLI's own bundled mini model. Its cached rate is 0.25x input, NOT the
  // 0.1x that holds across the rest of the family — copied from the registry, not
  // derived.
  'codex-mini-latest': { input: 1.5, cachedInput: 0.375, output: 6 },
};

// Mid-tier fallback for an unrecognized OpenAI model id.
const OPENAI_FALLBACK = OPENAI_PRICING['gpt-5.2-codex']!;

/**
 * A prefix match is only legitimate for a DATE suffix — that is the entire
 * reason the prefix leg exists ("gpt-5.2-codex-2026-05-01" is gpt-5.2-codex).
 *
 * A bare `startsWith` is far broader than that, and the difference is not
 * academic: every unrecognized member of a family silently inherits the price of
 * whichever shorter key it happens to begin with. "gpt-5-pro" ($15/$120) matched
 * "gpt-5" and billed at $1.25/$10 — 12x under. "gpt-5-nano" ($0.05/$0.40) matched
 * the same key and billed 25x OVER. "gpt-5.6" ($5/$30) fell to "gpt-5" at 3x
 * under. None of them produced a null, a warning, or any other signal: the number
 * was simply, confidently wrong, which is strictly worse than no number at all.
 *
 * Requiring a date suffix means an unknown model now falls through to null and
 * then to the declared fallback — still an estimate, but an honest and uniform
 * one that a coverage check can actually detect.
 */
const DATE_SUFFIX_RE = /^-(\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Look up static OpenAI pricing for a model id.
 * Tries: exact match → strip vendor prefix → dated-variant match.
 * Returns null if not a recognized OpenAI model.
 */
export function getOpenAIPricing(model: string): OpenAIModelPricing | null {
  if (OPENAI_PRICING[model]) return OPENAI_PRICING[model];

  const stripped = model.replace(/^[^/]+\//, '');
  if (stripped !== model && OPENAI_PRICING[stripped]) return OPENAI_PRICING[stripped];

  // Dated variants only. Longest key first so "gpt-5.2-codex-2026-05-01" resolves
  // against "gpt-5.2-codex" rather than being tested against "gpt-5.2" first.
  for (const key of Object.keys(OPENAI_PRICING).sort((a, b) => b.length - a.length)) {
    if (stripped.startsWith(key) && DATE_SUFFIX_RE.test(stripped.slice(key.length))) {
      return OPENAI_PRICING[key] ?? null;
    }
  }

  return null;
}

/** The model whose rates stand in for an unrecognized OpenAI id. */
export const OPENAI_FALLBACK_MODEL = 'gpt-5.2-codex';

/**
 * Compute the USD cost for an OpenAI Responses API call, reporting whether the
 * rate was real. See {@link PricedCost} for why the distinction matters.
 *
 * The OpenAI fallback is the more treacherous of the two: the family spans
 * $0.05/MTok (nano) to $30/MTok (pro), so substituting a mid-tier rate for an
 * unknown sibling can be wrong by 25x in EITHER direction — and it will not look
 * wrong.
 */
export function computeOpenAICostPriced(params: ComputeOpenAICostParams): PricedCost {
  const matched = getOpenAIPricing(params.model);
  const p = matched ?? OPENAI_FALLBACK;
  const cached = Math.min(params.cachedTokens ?? 0, params.inputTokens);
  const uncachedInput = params.inputTokens - cached;
  const usd =
    (uncachedInput * p.input + cached * p.cachedInput + params.outputTokens * p.output) / 1_000_000;
  return matched
    ? { usd, priced: true }
    : { usd, priced: false, fallbackModel: OPENAI_FALLBACK_MODEL };
}

/**
 * Compute the USD cost for an OpenAI Responses API call.
 * Synchronous — uses the static pricing table with a mid-tier fallback.
 * Cached tokens are subtracted from the input total and billed at the cached rate.
 *
 * Returns a bare number; use {@link computeOpenAICostPriced} when you need to
 * know whether the rate was real.
 */
export function computeOpenAICost(params: ComputeOpenAICostParams): number {
  return computeOpenAICostPriced(params).usd;
}
