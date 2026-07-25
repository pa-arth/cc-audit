# Changelog

Notable changes to `@promptster/cc-audit`. GitHub Releases carry the same notes
(the publish workflow attaches binaries per `v*` tag — see MAINTAINING.md).

## Unreleased

### Fixed

- **Output tokens were undercounted on every streamed message — the bill ran
  ~3.5% low overall, and 19% low on output alone.** Claude Code logs one
  assistant message across several JSONL rows sharing a `message.id`. The merge
  in `adapters/claudeCode.ts` folded each row's content blocks together but kept
  the *first* row's `usage`, on the documented premise that usage is "repeated
  identically" across rows. That premise holds for `input_tokens`,
  `cache_read_input_tokens`, and `cache_creation_input_tokens` — all fixed when
  the request is sent — but **`output_tokens` is a running total that grows as
  the stream emits**, so the first row carries a partial count. Now merged with
  a per-field max.

  The signature made it hard to spot: because only one of five buckets was
  affected, totals looked plausible and the three input-side buckets reconciled
  perfectly against an independent implementation. Measured on a 1,637-session
  corpus, 13,763 message ids carried a varying output count across their rows;
  `claude-opus-4-8` alone was short 12,527,810 output tokens (**$313.20**).

  Verified against `ccusage` on the same transcripts: **$11,113.75 vs $11,113.80
  — a $0.05 spread on $11k (0.0004%)**, previously $383 (3.5%). Every model
  except `opus-4-8` now matches to the cent.

  Known residual, the same $0.05: when a resumed session replays a message into
  a second transcript, the global `seen` set lets the *earlier* file own it, so a
  mid-stream truncation there keeps its partial count. 2,114 tokens across the
  corpus; not worth coupling the cross-file dedup to usage to recover.

### Changed

- **The report no longer says "window".** `Nd window` and `$X over window` were
  its most-asked-about strings — nothing on screen said what the window *was*,
  so the `/mo` figure read like it should match a monthly bill. The spend card
  now names both figures: `actual $X` over an explicit date range, then
  `projected $Y/mo` as that rate scaled to a month, with a note that only
  sessions still on disk are counted (Claude Code prunes per `cleanupPeriodDays`).
- **`SpendBreakdown.windowDays` spans turn timestamps, not session file mtimes**,
  and `firstDay`/`lastDay` are new. mtime was a proxy for when work happened and
  skewed both ways — an untouched project dir stretches the span and understates
  `/mo`; a bulk touch collapses it. ~2% on real data (30.31d vs 30.99d). Falls
  back to mtimes when no turn carries a timestamp.
- The unpriced-model warning no longer fires on models with **$0.00** of spend
  (Claude Code's locally-generated `<synthetic>` turns). A fallback rate applied
  to zero tokens is wrong by zero dollars. It also overflowed `BOX_WIDTH`, since
  `card()` pads but never wraps; now split across two lines.

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
