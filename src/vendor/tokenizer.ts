// ---------------------------------------------------------------------------
// VENDORED from @promptster/config-cost (packages/config-cost/src/tokenizer.ts).
//
// Only the zero-dependency pieces are vendored. Upstream also ships
// `OpenAiTokenizer` (backed by js-tiktoken), but cc-audit uses ONLY
// `CharCountTokenizer`, so we deliberately leave js-tiktoken out and keep this
// package dependency-clean. See vendor/pricing.ts for the drift-risk note.
// ---------------------------------------------------------------------------

export interface Tokenizer {
  /** Count tokens in `text`. Sync or async — callers should await the result. */
  count(text: string): number | Promise<number>;
}

/**
 * Zero-dependency fallback (~4 chars/token). Used when no real tokenizer is
 * available, and as the deterministic tokenizer in tests/golden snapshots.
 */
export class CharCountTokenizer implements Tokenizer {
  count(text: string): number {
    if (!text.trim()) return 0;
    return Math.ceil(text.length / 4);
  }
}
