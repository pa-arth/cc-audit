// ---------------------------------------------------------------------------
// VENDORED from @promptster/config-cost (packages/config-cost/src/pricing.ts).
// Last synced: 2026-09-22 via scripts/sync-pricing.mjs — do not hand-edit; re-run
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
// Upstream-body-sha256: c013b7443d816b6ce26115d8b6fed1c067ecf16b98852dc01738f4cc39a11a04
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
  // ── Claude Fable 5.1 (verified September 2026) ──
  // Same input/output and cache-write rates as Fable 5. Anthropic reduced the
  // cache-read multiplier for 5.1 from 0.1x to 0.025x input ($0.25/MTok).
  'claude-fable-5-1': {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite5min: 12.5,
    cacheWrite1hr: 20,
  },
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
  'claude-mythos-5-1': {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite5min: 12.5,
    cacheWrite1hr: 20,
  },
  // ── Claude Opus 5.5 (verified September 2026) ──
  // Cheaper than Opus 5 on every axis: $4/$20, standard write multipliers
  // (1.25x / 2x), but cache reads at 0.05x input ($0.20/MTok), not 0.1x.
  // Fast mode is $8/$40 — same unpriceable-flag caveat as Opus 5 below.
  'claude-opus-5-5': {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite5min: 5,
    cacheWrite1hr: 8,
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
  // ── Claude Sonnet 5 — $2/$10, ONE rate, no step-up ──
  //
  // #200 (2026-06-30) entered $3/$15 here as a forward-dated "steady state", on
  // the announced plan that Sonnet 5's $2/$10 introductory rate would step up on
  // 2026-09-01. THE STEP-UP DID NOT HAPPEN. Re-checked 2026-09-01, the first day
  // the projection was load-bearing: Anthropic's pricing table still publishes
  // Sonnet 5 at $2 / $10 per MTok, and LiteLLM agrees. The dated INTRO_PRICING
  // override that used to carry $2/$10 is gone with it — there is no longer a
  // cutoff to be on either side of.
  //
  // This is why `litellm-drift` is a NETWORK test and not a snapshot: the
  // divergence appeared the moment the projected rate went live, not when it was
  // written.
  'claude-sonnet-5': {
    input: 2,
    output: 10,
    // Standard Anthropic cache multipliers off input, same as every other entry:
    // read 0.1x, 5-min write 1.25x, 1-hour write 2x.
    cacheRead: 0.2,
    cacheWrite5min: 2.5,
    cacheWrite1hr: 4,
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
//
// EMPTY, deliberately, and the machinery is kept. Its only entry was Sonnet 5's
// $2/$10 through 2026-08-31, added by #200 against an announced step-up to
// $3/$15 that never landed. With the base row corrected to $2/$10 the override
// became an exact duplicate of the row it overrode — a no-op asserting a cutoff
// that does not exist — so it is removed rather than left to read as if Sonnet 5
// were priced two ways. The lookup below still threads a turn timestamp, so the
// next genuinely dated rate is a one-entry edit and not a re-plumbing.
const INTRO_PRICING: Array<{ model: string; until: number; rates: AnthropicModelPricing }> = [];

/**
 * Look up static Anthropic pricing for a model ID.
 * Tries: exact match → strip vendor prefix → prefix match (ignore date suffix).
 * Returns null if not an Anthropic model.
 *
 * When `at` is supplied and falls before a model's dated introductory cutoff,
 * the introductory rate is returned instead of the steady-state base entry.
 * Omitting `at` always yields the steady-state (forward-looking) rate.
 */
/**
 * Bracket affixes we have EVIDENCE for, and the evidence for each.
 *
 * A list rather than a regex literal because that is what it is: an evidence
 * register, and the next entry needs a line to record its evidence on. Adding a
 * span is a one-line edit here plus a refusal test that stops being true — which
 * is the same bar `MODEL_ROLE_ALIASES` sets for admitting a string.
 *
 *   1m — Anthropic's 1M-context variant. Attested by this repo's own
 *        `cost.test.ts` ("resolves the bracketed context variants Claude Code
 *        emits", carrying an explicit *do not narrow this to a date-only match*),
 *        by `boundaryClamps.ts`'s TOKEN_RE comment, and by the model id of the
 *        harness these tools run under.
 *
 * NOT admitted on absence of evidence: teams prod has **zero** rows whose model
 * id contains a bracket at all, across every kind and the whole table (measured
 * 2026-08-21). So prod cannot widen this list and it cannot narrow it either —
 * which is exactly why the entry above cites where `1m` IS attested rather than
 * pointing at a query that returns nothing. An absence measured in one store is
 * not evidence about what a vendor emits.
 */
const OBSERVED_BRACKET_AFFIXES = ['1m'] as const;

/**
 * The affix shapes an Anthropic model id may carry and still resolve to its base
 * key's rate. ANYTHING ELSE FALLS THROUGH TO null.
 *
 * This arm used to be a bare `stripped.startsWith(key)` with no shape
 * constraint, which is the same defect #528 removed from `getOpenAIPricing` —
 * documented three paragraphs up, on that side, as "silently, confidently
 * wrong, which is strictly worse than no number at all". The Anthropic side kept
 * the loose rule because its two real affixes (a date, and the bracketed context
 * variant) were the only ones in the world when it was written.
 *
 * They stopped being the only ones. Cursor auto-routes to Anthropic models and
 * writes its own routing strings into the model field —
 * `claude-opus-5-thinking-high` (32 rows), and `cursor-grok-*-high` on the xAI
 * side. `claude-opus-5-thinking-high` begins with `claude-opus-5`, so the loose
 * rule priced a thinking-tier variant at the base model's rate: a number that is
 * confidently wrong rather than visibly absent. It became reachable the moment
 * teams-cli v0.17.0 started attaching tokens to Cursor rows — before that the
 * rail carried a model and no usage, so nothing ever priced.
 *
 * `changes/cursor-token-metering/design.md` §7 refuses suffix normalisation
 * explicitly: a thinking tier may bill differently from its base and `-fast`
 * almost certainly does, so any such mapping needs per-id evidence that the
 * rates are EQUAL, one entry at a time — the standard `MODEL_ROLE_ALIASES`
 * already holds.
 *
 * This is an instance of a known class, not a one-off: a constant written when
 * it was true, with no subscriber to the vendor shipping something new. The
 * durable half of the guard is that the accepted shapes are ENUMERATED here and
 * pinned by a test that also lists the refused ones — a rule that silently
 * widens is how the first version got here.
 *
 * Accepted, in this order, both optional but at least one present (an empty
 * remainder is an exact match and never reaches this arm):
 *
 *   -20260301 / -2026-03-01   dated variant
 *   [1m]                      bracketed context variant Claude Code emits
 *   -20260301[1m]             both
 *
 * The bracket CONTENT is enumerated too, and the first version of this fix got
 * that wrong. It matched `\[[^\]]*\]` — any bracket content, including an empty
 * one — so `claude-opus-5[fast]` and `claude-opus-5[]` still inherited the base
 * rate. That is the identical defect one shape over: the suffix hole closed and
 * the bracket hole left open, in the very commit whose subject is closing holes.
 * Caught in review on #756.
 */
const ANTHROPIC_AFFIX_RE = new RegExp(
  `^(?:-(?:\\d{4}-\\d{2}-\\d{2}|\\d{8}))?(?:\\[(?:${OBSERVED_BRACKET_AFFIXES.join('|')})\\])?$`,
);

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
    // Prefix match, restricted to AFFIX SHAPES WE HAVE OBSERVED — see
    // {@link ANTHROPIC_AFFIX_RE}.
    //
    // LONGEST KEY FIRST. Object key order is insertion order, so a bare iteration
    // hands the match to whichever entry was typed into the table first — a
    // shorter key silently wins over the more specific one it prefixes, which is
    // precisely the mispricing #528 removed on the OpenAI side. No Anthropic pair
    // collides today; the sort is what keeps that true when the next id lands
    // rather than leaving it to table ordering.
    for (const key of Object.keys(ANTHROPIC_PRICING).sort((a, b) => b.length - a.length)) {
      if (stripped.startsWith(key) && ANTHROPIC_AFFIX_RE.test(stripped.slice(key.length))) {
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
  /**
   * OpenAI only. True when `cachedTokens + cacheWriteTokens > inputTokens` — a
   * row that CONTRADICTS the subset reading documented on
   * {@link ComputeOpenAICostParams.cacheWriteTokens}.
   *
   * This is the observation, not an error. The subset-vs-addend question was
   * unanswerable from the pre-GPT-5.6 corpus because every record had
   * `cache_write_input` at 0, so the honest move is to price under the safe
   * reading and let real rows falsify it rather than to keep guessing. A single
   * `subsetViolated` row is evidence for the addend reading and means the rate
   * math here needs revisiting; zero of them across a cache-heavy 5.6 org is
   * evidence for the subset reading.
   *
   * ⚠ THIS DOCSTRING USED TO END "Absent on the Anthropic leg, whose buckets are
   * additive by contract and need no such test." That sentence was true when it
   * was written and became false on 2026-08-21, when `cursor` joined
   * `SUBSET_CACHE_INTEGRATIONS` (#755): Cursor is the first integration that is
   * SUBSET and auto-routes to `claude-*`, so the Anthropic leg started pricing
   * rows under a reading that "additive by contract" no longer describes. The
   * contract was an assumption about which tools reach that leg, and a new tool
   * is a normal thing to add.
   *
   * The Anthropic leg's falsifier is `subsetClaimOf` in
   * `packages/engine/src/lib/costSpans.ts`, read by the observation gate
   * `anthropic-leg-subset-claim-holds`. It is a THREE-state value rather than a
   * boolean, which is the shape this field should also have: `subsetViolated`
   * being absent conflates "checked, and the row agreed" with "no subset claim
   * was made on this row", and only the caller's memory of which leg it took
   * separates them.
   *
   * It is also emitted into a void — as of 2026-08-21 NOTHING in the tree reads
   * `.subsetViolated` outside this file's own tests. `judge.ts` returns the
   * `PricedCost` and `judgeUsageSink` logs `priced`/`fallbackModel` and not this.
   * Recorded here rather than fixed: giving it a reader is a change to the judge
   * spend path, not to fleet pricing.
   */
  subsetViolated?: boolean;
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
  /**
   * Cache-WRITE rate — the price of a token that was written to cache, NOT a
   * premium added on top of the input rate.
   *
   * Below GPT-5.6 this EQUALS `input`: OpenAI charges no write fee there, so a
   * written token is an ordinary input token. It is deliberately not `0`, for
   * the reason the `pro` tiers set `cachedInput` equal to `input` — a rate that
   * means "no special price" must still bill, or a stray count silently makes
   * real input free. Setting it to 0 under-billed gpt-5.5 by 40% on a
   * 40%-written prompt, which is what `charges no write fee below GPT-5.6`
   * caught before this shipped.
   *
   * This axis did not exist on this interface until 2026-08-12, and its absence
   * was the failure: OpenAI added the fee at the GPT-5.6 GA (2026-07-09) and a
   * table with no field for it priced every 5.6 cache write at $0. Note what
   * did NOT catch that — `litellm-drift.test.ts` cross-checks the RATES in this
   * table and caught stale ones, but a drift test can only compare fields that
   * exist on both sides. A missing rate AXIS is invisible to it. The lesson is
   * the one `PREMIUM_PREFIXES` learned separately: a static table has no
   * subscriber to the vendor's release notes, so the review that matters is
   * "did the vendor add a new KIND of charge", not "did a number move".
   */
  cacheWrite: number;
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
  /**
   * `usage.cache_write_tokens` (Codex rollout: `cache_write_input_tokens`) —
   * prompt tokens written to cache, billed at 1.25x the uncached input rate on
   * GPT-5.6+.
   *
   * TREATED AS A SUBSET of `inputTokens`, like `cachedTokens`. OpenAI's own
   * guide does not state the relationship, so this is the reading the evidence
   * supports rather than a documented fact:
   *
   *  - Codex reports `total_tokens == input_tokens + output_tokens` (fixture:
   *    13451 + 61 == 13512 with cached_input_tokens 13184). A bucket that were
   *    an ADDEND would have to appear in that identity and does not.
   *  - OpenAI's convention throughout is that `input_tokens` is the total and
   *    the `*_details` fields break it down; Anthropic is the one that splits
   *    cache buckets out additively.
   *
   * If the reading is wrong the error is an UNDER-charge, never an over-charge,
   * which is the safe direction for a number we show a customer. It is also not
   * left to faith: {@link computeOpenAICostPriced} reports `subsetViolated` when
   * a real row contradicts it, so Alex's rows will answer the question that the
   * pre-5.6 corpus could not (every record had this field at 0).
   */
  cacheWriteTokens?: number;
  /** `usage.output_tokens` — already includes reasoning tokens. */
  outputTokens: number;
}

// Static OpenAI pricing table (verified July 2026).
// Source: https://openai.com/api/pricing/ and https://developers.openai.com/codex/pricing
// Cached input is 10% of the standard input rate across the GPT-5 family.
// Codex variants (e.g. gpt-5.2-codex) are priced identically to their base model.
// The `pro` tiers publish no cached-input rate in either registry (they do not
// support prompt caching). cachedInput is set EQUAL to input for those so that a
// stray cached-token count can never under-bill them — the discount has to be
// published before we apply it.
export const OPENAI_PRICING: Record<string, OpenAIModelPricing> = {
  // ── GPT-6 Astra (verified September 2026) ──
  // Standard short-context API rate. Requests above 272k input tokens use
  // separate long-context multipliers that this flat table cannot represent.
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50, cacheWrite: 12.5 },
  // Sol and Luna verified 2026-09-22, same short-context caveat as Astra.
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5, cacheWrite: 0.125 },
  // ── GPT-5.6 Cyber (verified 2026-09-22; no long-context tier published) ──
  'gpt-5.6-cyber': { input: 12.5, cachedInput: 1.25, output: 75, cacheWrite: 15.625 },
  // ── GPT-5.6 (GA 2026-07-09) ──
  // Sol matches the GPT-5.5 tier. Terra and Luna were REPRICED after GA and the
  // rows below are the post-repricing rates, cross-checked against LiteLLM by
  // `litellm-drift.test.ts` — which is what caught the stale ones.
  //
  // Luna moved the most, by 5x (1/6/0.1 → 0.2/1.2/0.02), so a stale row here
  // does not fail loudly, it just OVERSTATES every luna org's spend. That is the
  // less-visible half of this table's failure mode: the well-known one is a
  // model MISSING entirely and therefore costing $0 (opus-5, 181 turns/day
  // invisible) or matched by a too-eager prefix and billed 12x under
  // (gpt-5-pro). A wrong-but-present rate is quieter than both, because every
  // downstream number still looks like a number.
  // 2026-08-22: OpenAI cut Sol's short-context rates — input 5 → 4 (-20%),
  // output 30 → 20 (-33.3%), cachedInput 0.5 → 0.4, cacheWrite 6.25 → 5.00.
  // Terra and Luna were NOT repriced and already match; only these two moved.
  //
  // cacheWrite is the reason to read the vendor page and not just the failing
  // assertion. `litellm-drift` compares input / cachedInput / output only, so it
  // flagged three of the four fields and would have left cacheWrite at 6.25 —
  // 25% over — looking green. Same quiet failure the comment above describes.
  //
  // ⚠️ Two things this flat row still cannot say, both pre-existing:
  //   - Sol's rates are PROMOTIONAL "at least through 2026-11-21". OPENAI_PRICING
  //     has no dated-window mechanism (the Anthropic arm has getAnthropicPricing
  //     (model, now) for exactly this); when the promo ends, this row goes stale
  //     silently and only the drift test will say so.
  //   - These are SHORT-context rates. Long context is 8 / 0.8 / 10 / 30 for Sol,
  //     which this table cannot express, so long-context spend is under-billed.
  'gpt-5.6': { input: 4, cachedInput: 0.4, output: 20, cacheWrite: 5 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20, cacheWrite: 5 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2, cacheWrite: 0.25 },
  // ── GPT-5.5 ──
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30, cacheWrite: 5 },
  'gpt-5.5-codex': { input: 5, cachedInput: 0.5, output: 30, cacheWrite: 5 },
  'gpt-5.5-pro': { input: 30, cachedInput: 3, output: 180, cacheWrite: 30 },
  // ── GPT-5.4 ──
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15, cacheWrite: 2.5 },
  'gpt-5.4-codex': { input: 2.5, cachedInput: 0.25, output: 15, cacheWrite: 2.5 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5, cacheWrite: 0.75 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25, cacheWrite: 0.2 },
  'gpt-5.4-pro': { input: 30, cachedInput: 3, output: 180, cacheWrite: 30 },
  // ── GPT-5.3 (Codex line; `spark` is the low-latency variant, same rates) ──
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 1.75 },
  'gpt-5.3-codex-spark': { input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 1.75 },
  'gpt-5.3-chat-latest': { input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 1.75 },
  // ── GPT-5.2 ──
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 1.75 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 1.75 },
  'gpt-5.2-chat-latest': { input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 1.75 },
  'gpt-5.2-pro': { input: 21, cachedInput: 21, output: 168, cacheWrite: 21 },
  // ── GPT-5.1 ──
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10, cacheWrite: 1.25 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10, cacheWrite: 1.25 },
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10, cacheWrite: 1.25 },
  'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2, cacheWrite: 0.25 },
  // ── GPT-5 (legacy) ──
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10, cacheWrite: 1.25 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4, cacheWrite: 0.05 },
  'gpt-5-pro': { input: 15, cachedInput: 15, output: 120, cacheWrite: 15 },
  // Codex CLI's own bundled mini model. Its cached rate is 0.25x input, NOT the
  // 0.1x that holds across the rest of the family — copied from the registry, not
  // derived.
  'codex-mini-latest': { input: 1.5, cachedInput: 0.375, output: 6, cacheWrite: 1.5 },
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
 * the same key and billed 25x OVER. "gpt-5.6" (then $5/$30; $4/$20 since the
 * 2026-08-22 repricing) fell to "gpt-5" at 3x under. None of them produced a null, a warning, or any other signal: the number
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
  // Cache writes are the remaining SUBSET of input, so they are clamped against
  // what `cached` has already claimed. Clamping is what makes the subset reading
  // unable to over-bill: the three buckets can never sum past `inputTokens`, and
  // a row that WOULD have exceeded it is reported via `subsetViolated` rather
  // than silently absorbed — a clamp that hides its own trigger is how an
  // assumption stops being testable.
  const rawWrite = params.cacheWriteTokens ?? 0;
  const cacheWrite = Math.min(rawWrite, params.inputTokens - cached);
  const subsetViolated = cached + rawWrite > params.inputTokens;
  const uncachedInput = params.inputTokens - cached - cacheWrite;
  const usd =
    (uncachedInput * p.input +
      cached * p.cachedInput +
      cacheWrite * p.cacheWrite +
      params.outputTokens * p.output) /
    1_000_000;
  const base = matched
    ? { usd, priced: true }
    : { usd, priced: false, fallbackModel: OPENAI_FALLBACK_MODEL };
  return subsetViolated ? { ...base, subsetViolated } : base;
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

// ── Cursor (the "Cursor Models" pool: Grok + Composer) ─────────────────────
//
// A THIRD table, and the reason it is a table rather than more rows in the two
// above is worth stating once: Cursor is the BILLER here, not merely the
// transport.
//
// For third-party models Cursor is a pass-through. Verified row by row against
// cursor.com/docs/models on 2026-08-21 — all 40+ Anthropic/OpenAI entries on
// that page carry the same input / cache-write / cache-read / output rates as
// `ANTHROPIC_PRICING` and `OPENAI_PRICING` do, cache-write column included
// (`GPT-5.6 Sol` $5/$6.25/$0.5/$30; `Claude Opus 5` $5/$6.25/$0.5/$25). So a
// Cursor turn that auto-routes to `claude-opus-5` is already priced correctly by
// the Anthropic leg and needs no rail axis, which is why none is added here.
//
// The Cursor Models pool is different: `grok-*` and `composer-*` reach us from
// no other rail and appear in neither table, so 82% of the live external org's
// Cursor turns price at nothing. THAT is the gap this closes.
//
// ✅ THE FORWARD-DATED DIVERGENCE RESOLVED ITSELF — no second axis needed.
// This note used to warn that `claude-sonnet-5` agreed with Cursor's page at
// $2/$10 only because `INTRO_PRICING` overrode the base row until 2026-09-01,
// and that if Cursor did not follow Anthropic's step to $3/$15 the one canonical
// key would have to return two rates depending on who billed it. It said:
// re-check the page after 2026-09-01, do not pre-build the axis on a guess.
//
// Re-checked 2026-09-01. NOBODY stepped: Anthropic's own pricing table still
// publishes Sonnet 5 at $2/$10, which is what Cursor's page said all along and
// what LiteLLM has been asserting against us. The guess that needed the axis was
// ours, not Cursor's — the base row was corrected to $2/$10 and the override
// deleted. One key, one rate, both rails agree. Not pre-building the axis was
// the right call.
//
// PROVENANCE, and how much weight it carries: these rates are read off Cursor's
// published pricing page, dated above. That is the billing contract and the only
// source there is — ops.ai is on an INDIVIDUAL Cursor plan, so there is no Teams
// admin API and no invoice to reconcile against. Cursor's own DOCS have already
// been measured wrong once in this change (the stop-hook payload, three fields,
// 2026-08-18), so treat a rate that disagrees with observed billing as the
// page being wrong, not the observation.
//
// These are API-EQUIVALENT figures, not an invoice — the same footing the codex
// and Claude Code rails are already on, which is what lets the three be SUMMED
// into one org spend number. Any caption over that total must say so.

export interface CursorModelPricing {
  /** Per-million-token rates in USD */
  input: number;
  /**
   * Cache-READ rate. A SUBSET of `input` on this rail, like OpenAI's
   * `cachedInput` and unlike Anthropic's additive `cacheRead` — see
   * `SUBSET_CACHE_INTEGRATIONS` in `costSpans.ts`. Every leg below therefore
   * CARVES it out of input rather than adding it beside.
   *
   * It is a stored rate and not derived: the pool's read discount is 0.25x input
   * on Grok and 0.4x on Composer, so neither the 0.1x that holds across the
   * OpenAI family nor Anthropic's 0.1x would produce it.
   */
  cacheRead: number;
  output: number;
  // NOTE THE ABSENT FIELD. There is deliberately no `cacheWrite` axis: Cursor
  // publishes "—" for every model in this pool, meaning no write fee exists,
  // NOT that one exists at $0. The distinction is the difference between a fact
  // and a verified-looking guess, and here it also decides arithmetic. With no
  // axis, a written token is never carved out of `input` and so bills at the
  // plain input rate — which is exactly what "no write fee" means — and no code
  // path can multiply a write count by a fabricated zero. Prod agrees: across
  // 5,296 Cursor-rail `ai_response` rows fleet-wide, ZERO carry a non-zero cache
  // write (2026-08-21).
  //
  // If Cursor adds a write fee, the fix is to add the field — which will fail to
  // compile at every leg until each one decides what to do with it. A `0` would
  // have shipped silently, the way the OpenAI table's missing write axis did for
  // the whole first month of GPT-5.6.
}

/**
 * Cursor's own model pool, at the rates Cursor bills for them.
 *
 * Rates from https://cursor.com/docs/models, read 2026-08-21.
 *
 * `-fast` is a REAL price tier, not decoration: it is 2x input and cache-read
 * across the pool, 2x output on Grok 4.6 and Composer 2.5, and 3x output on Grok
 * 4.5. That asymmetry is why each tier is its own row and why
 * {@link getCursorPricing} resolves only documented effort/speed aliases — a `-fast` id falling back to its
 * base key would under-bill by 2-3x, which is the mispricing #528 removed on the
 * OpenAI side arriving through a different door.
 */
export const CURSOR_PRICING: Record<string, CursorModelPricing> = {
  // Grok (xAI, resold by Cursor). Priced at CURSOR's rates, not xAI's list —
  // the customer's bill comes from Cursor.
  // Grok 4.7 added 2026-09-22. Its "500k" context tier ($4/$1/$12, fast
  // $6/$1.5/$18) is not rowed: no observed id to key it on.
  'grok-4.7': { input: 2, cacheRead: 0.5, output: 6 },
  'grok-4.7-fast': { input: 4, cacheRead: 1, output: 12 },
  'grok-4.6': { input: 2, cacheRead: 0.5, output: 6 },
  'grok-4.6-fast': { input: 4, cacheRead: 1, output: 12 },
  'grok-4.5': { input: 2, cacheRead: 0.5, output: 6 },
  'grok-4.5-fast': { input: 4, cacheRead: 1, output: 18 },
  // Composer — Cursor's own model. §4.2, owner-decided 2026-08-18.
  'composer-2.5': { input: 0.5, cacheRead: 0.2, output: 2.5 },
  'composer-2.5-fast': { input: 3, cacheRead: 0.5, output: 15 },
};

/**
 * Model ids that NAME a model in the Cursor pool but do not identify a PRICED
 * tier — recognised so they can be refused with the right reason.
 *
 * Task 4.3, decided: the per-day build strings stay UNPRICED. Four shapes are in
 * prod (2026-08-21, 412 rows, none carrying tokens):
 *
 *   grok-4-6-0805-row17-48300032-fp4-effort-high   122
 *   grok-4-6-0808-row24-52297728-fp4-effort-high    93
 *   grok-4-6-fp4-effort-high                        85
 *   grok-4-6-0809-row26-54198272-fp4-effort-high    21
 *
 * `row17` / `48300032` are a build checkpoint and `fp4` a quantization. Cursor
 * publishes a rate for none of those internal builds. Public `cursor-grok-*`
 * ids are different: Cursor documents effort as an independent control and
 * publishes one Standard and one Fast price, so those exact alias shapes are
 * resolved below without interpreting an internal build string.
 *
 * The point of recognising them anyway is the ACTION a coverage alert names.
 * `no_rate_table` tells the reader "add the row", which is the wrong fix and the
 * one somebody closes by stripping the suffix — exactly the confidently-wrong
 * number `ANTHROPIC_AFFIX_RE` refuses. `unresolved_variant` tells them "get
 * per-id evidence that this tier bills like its base". See `coverage.ts`.
 *
 * This recogniser NEVER produces a dollar. It is deliberately separate from
 * {@link CURSOR_PRICING} so that widening it can only change a reason string,
 * never a price.
 */
const CURSOR_FAMILY_RE = /^(?:cursor-)?(?:grok|composer)-\d+[.-]\d+(?:$|[-.])/;

/** Does this id name a model in the Cursor pool, priced tier or not? */
export function isCursorFamily(model: string): boolean {
  return CURSOR_FAMILY_RE.test(model.replace(/^[^/]+\//, ''));
}

/**
 * Look up Cursor-pool pricing for a model id.
 *
 * Exact table match first, then documented Cursor Grok effort/speed aliases.
 * There is no general prefix or build-string arm — see {@link CURSOR_PRICING}
 * for why a prefix match is unsafe on this rail specifically. An unrecognised tier falls through to null and is reported by
 * {@link isCursorFamily} as a variant we refuse to guess at, which is the
 * honest answer and the one a human can act on.
 *
 * Returns null for every Anthropic and OpenAI id — the key sets are disjoint,
 * asserted in `pricing.test.ts` — so consulting this table cannot move a Claude
 * Code or Codex figure by construction rather than by call-site discipline.
 */
export function getCursorPricing(model: string): CursorModelPricing | null {
  if (CURSOR_PRICING[model]) return CURSOR_PRICING[model];
  const stripped = model.replace(/^[^/]+\//, '');
  if (stripped !== model && CURSOR_PRICING[stripped]) return CURSOR_PRICING[stripped];
  const alias = /^(?:cursor-)?(grok-4\.[567])-(?:low|medium|high|xhigh)(-fast)?$/.exec(stripped);
  if (alias) return CURSOR_PRICING[`${alias[1]}${alias[2] ?? ''}`] ?? null;
  return null;
}
