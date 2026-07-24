# Changelog

Notable changes to `@promptster/cc-audit`. GitHub Releases carry the same notes
(the publish workflow attaches binaries per `v*` tag — see MAINTAINING.md).

## 0.5.1 — 2026-07-24

### Fixed

- **`claude-opus-5` was priced at the Sonnet-tier fallback** — 40% low on every
  Opus 5 turn. The vendored pricing table had drifted 4 commits behind upstream
  `@promptster/config-cost` and had no row for it, so `getAnthropicPricing()`
  returned null and `turnCostUsd()` substituted $3/$15 for the real $5/$25.
  Measured on a 1,528-turn corpus: **$121.51 reported vs $202.52 actual**.
  Re-synced from upstream `main`, which also brings `computeCostPriced` and the
  gpt-5.6 / 5.3 / 5.1 families, `pro`+`nano` tiers, `codex-mini-latest`, and the
  date-suffix-only OpenAI matcher. (The OpenAI half is unreachable until a Codex
  adapter exists — `claudeCode.ts` is still the only ingest — but the mirror is
  kept byte-for-byte so the next sync stays a clean diff.)
- **This is the second time this exact bug shipped.** 0.4.1 fixed it for
  `claude-sonnet-5` / `claude-mythos-5`; the drift guard added then cannot catch
  it, because a *missing* model is a WARN (and the whole test degrades to pass
  offline) while only a *wrong rate on an existing row* hard-fails. The two
  additions below are aimed at the recurrence, not the instance.

### Added

- **Unpriced models are now named in the report, whatever their share.** The old
  warning fired only above a 2% fallback share, which is the wrong measurement:
  a share bounds the error on the *total* and says nothing about any single
  model. Opus 5 was 40% wrong at a **0.47%** share, so the report stayed silent.
  `SpendBreakdown.unpricedModels` carries the model id, dollars, and turn count;
  the report prints the ids, because the id is the only part a reader can act on.
- **Aggregate schema v9** — `dataQuality.unpricedModels`. Model ids already
  travel in `spend.byModel`, so nothing new about the user leaves the machine;
  what is new is that the record states which of its own figures are estimates.
- **`scripts/sync-pricing.mjs` refuses to overwrite a hand-edited mirror.** It
  records a sha256 of the upstream body it copied and fails if the vendored file
  no longer matches (`--force` to override). Not hypothetical: the vendored
  Anthropic lookup carried a longest-key-first prefix sort that upstream lacked,
  and a plain re-copy reverted it with no diff to notice. That fix now lives
  upstream instead (promptster-backend#535).

## 0.4.1 — 2026-07-02

### Fixed

- **Re-synced vendored pricing tables with upstream `@promptster/config-cost`**
  (they had drifted since the 2026-06-30 upstream update). `claude-sonnet-5` and
  `claude-mythos-5` were missing entirely, so their usage was silently priced at
  the Sonnet-tier fallback — under-pricing Mythos 5 ~3.3x and mis-pricing Sonnet 5's
  introductory window.
- **Dated introductory pricing** (`INTRO_PRICING` + the `at?: Date` param on
  `getAnthropicPricing`) is now honored when repricing historical transcripts:
  `turnCostUsd()` (and `turnCarryUsd()`) accept the turn's epoch-ms timestamp and
  all analyses pass it through, so Sonnet 5 usage before Sept 1 2026 bills at the
  intro rate ($2/$10 per Mtok) instead of steady-state ($3/$15). Backward
  compatible — omitting the timestamp yields steady-state rates.

### Added

- **Pricing drift guard** — `src/__tests__/pricingDrift.test.ts`, ported from
  config-cost's `litellm-drift` test: cross-checks the vendored tables against
  LiteLLM's community pricing DB in CI (hard-fail on rate disagreement, warn on
  uncovered models, degrades to pass offline), plus offline regression pins for
  the new entries.
- **`scripts/sync-pricing.mjs`** — one-command re-sync of `src/vendor/pricing.ts`
  from a sibling `promptster-backend` checkout (or `--from <path>`), with a diff
  summary. See MAINTAINING.md "Vendored pricing".

## 0.4.0

Baseline for this changelog (pre-changelog releases are documented in GitHub
Releases only).
