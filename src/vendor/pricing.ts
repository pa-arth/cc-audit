// ---------------------------------------------------------------------------
// VENDORED from @promptster/config-cost (packages/config-cost/src/pricing.ts).
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
// upstream config-cost table together. The litellm-drift test in config-cost is
// the canonical guard; this mirror has no such guard, so keep them in lockstep.
//
// Mirrored verbatim (no edits) so a future re-sync is a straight file copy.
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

/**
 * Look up static Anthropic pricing for a model ID.
 * Tries: exact match → strip vendor prefix → prefix match (ignore date suffix).
 * Returns null if not an Anthropic model.
 */
export function getAnthropicPricing(model: string): AnthropicModelPricing | null {
  // 1. Exact match
  if (ANTHROPIC_PRICING[model]) return ANTHROPIC_PRICING[model];

  // 2. Strip vendor prefix (e.g. "anthropic/claude-sonnet-4-6")
  const stripped = model.replace(/^[^/]+\//, '');
  if (stripped !== model && ANTHROPIC_PRICING[stripped]) return ANTHROPIC_PRICING[stripped];

  // 3. Prefix match — handle dated variants (e.g. "claude-opus-4-6-20260301")
  for (const key of Object.keys(ANTHROPIC_PRICING)) {
    if (stripped.startsWith(key)) return ANTHROPIC_PRICING[key] ?? null;
  }

  return null;
}

/**
 * Compute the USD cost for an Anthropic API call.
 * Synchronous — uses the static pricing table with Sonnet-tier fallback.
 * Cache write tokens use the 5-minute rate by default.
 */
export function computeCost(params: ComputeCostParams): number {
  const p = getAnthropicPricing(params.model) ?? SONNET_FALLBACK;
  return (
    (params.inputTokens * p.input +
      params.outputTokens * p.output +
      (params.cacheReadTokens ?? 0) * p.cacheRead +
      (params.cacheWriteTokens ?? 0) * p.cacheWrite5min) /
    1_000_000
  );
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

// Static OpenAI pricing table (verified June 2026).
// Source: https://openai.com/api/pricing/ and https://developers.openai.com/codex/pricing
// Cached input is 10% of the standard input rate across the GPT-5 family.
// Codex variants (e.g. gpt-5.2-codex) are priced identically to their base model.
export const OPENAI_PRICING: Record<string, OpenAIModelPricing> = {
  // ── GPT-5.5 ──
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-codex': { input: 5, cachedInput: 0.5, output: 30 },
  // ── GPT-5.4 ──
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-codex': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  // ── GPT-5.2 ──
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  // ── GPT-5 (legacy) ──
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
};

// Mid-tier fallback for an unrecognized OpenAI model id.
const OPENAI_FALLBACK = OPENAI_PRICING['gpt-5.2-codex']!;

/**
 * Look up static OpenAI pricing for a model id.
 * Tries: exact match → strip vendor prefix → prefix match (ignore date suffix).
 * Returns null if not a recognized OpenAI model.
 */
export function getOpenAIPricing(model: string): OpenAIModelPricing | null {
  if (OPENAI_PRICING[model]) return OPENAI_PRICING[model];

  const stripped = model.replace(/^[^/]+\//, '');
  if (stripped !== model && OPENAI_PRICING[stripped]) return OPENAI_PRICING[stripped];

  // Prefix match — handle dated variants (e.g. "gpt-5.2-codex-2026-05-01").
  // Longest key first so "gpt-5.2-codex" wins over "gpt-5.2" / "gpt-5".
  for (const key of Object.keys(OPENAI_PRICING).sort((a, b) => b.length - a.length)) {
    if (stripped.startsWith(key)) return OPENAI_PRICING[key] ?? null;
  }

  return null;
}

/**
 * Compute the USD cost for an OpenAI Responses API call.
 * Synchronous — uses the static pricing table with a mid-tier fallback.
 * Cached tokens are subtracted from the input total and billed at the cached rate.
 */
export function computeOpenAICost(params: ComputeOpenAICostParams): number {
  const p = getOpenAIPricing(params.model) ?? OPENAI_FALLBACK;
  const cached = Math.min(params.cachedTokens ?? 0, params.inputTokens);
  const uncachedInput = params.inputTokens - cached;
  return (
    (uncachedInput * p.input + cached * p.cachedInput + params.outputTokens * p.output) / 1_000_000
  );
}
