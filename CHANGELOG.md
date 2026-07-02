# Changelog

Notable changes to `@promptster/cc-audit`. GitHub Releases carry the same notes
(the publish workflow attaches binaries per `v*` tag — see MAINTAINING.md).

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
