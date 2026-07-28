# Changelog

Notable changes to `@promptster/cc-audit`. GitHub Releases carry the same notes
(the publish workflow attaches binaries per `v*` tag — see MAINTAINING.md).

## Unreleased

### Changed

- **The bare interactive run now asks two questions instead of four.** The old offer
  ladder — local config edits, a hosted `CLAUDE.md` rewrite, right-sizing, a claude-hud
  statusline, a public report — was five confirms deep and buried the two that matter.
  What's left, both default *Yes*, both below the whole report:

  1. **Run the analysis now** → three ranked improvement plans, written by your own
     `claude`/`codex` and printed in the same terminal, plus the skill installed for
     next time.
  2. **Share your data with Promptster** → the privacy-safe aggregate plus your task
     gists.

  The removed prompts did not remove the features: `--judge`, `--open`,
  `cc-audit fix`, and `cc-audit statusline --install` all still do exactly what they did.
  They are now flag-driven only, and the `--judge`/`--open` disclosures moved onto the
  flag path so nothing that leaves the machine leaves undisclosed.

### Added

- **Three improvement plans, written by your own agent, in the same run.** Say yes and
  cc-audit invokes `claude -p` (or `codex exec`, resolved deterministically in that order)
  on a compacted summary and prints the plans right there. No session restart, no phrase to
  remember. It runs on **your** subscription — cc-audit never calls a hosted model to
  analyze your sessions.

  Three things keep it honest, and they are the design, not garnish:
  - **The window cost is disclosed before it's spent.** Invoking your agent consumes the
    same rate-limit window this report exists to explain. The confirm names the agent,
    whose subscription pays, and the token estimate.
  - **The input is bounded and says so.** `compactFindings()` sends ~11KB (~3k tokens), not
    the raw ~22KB record — and it declares its own truncation in-band, so the model says
    "your top 8 commands of 12" rather than mistaking a subset for the whole picture.
  - **Degradation is named.** No agent on PATH, a failed invocation, or a timeout leaves the
    measured report above completely intact and states what didn't happen. A partial run
    never reads as a complete one.

  The prompt asks for no tools and carries its data inline, so the read-only posture is
  structural rather than promised (`--allowed-tools ''` on claude, `-s read-only` on codex).
  `cc-audit --print-prompt` renders the exact text that would be sent and invokes nothing.

- **`cc-audit skill [--print]` — the analysis skill, embedded, not downloaded.** Installed
  by the same yes. It is the *better* of the two paths — running inside a session with your
  repo loaded lets it cite the actual line in your actual CLAUDE.md, which a cold shell-out
  can't — it just isn't the one that works in the first ten seconds.

  The skill is an instruction set that runs in your repo with your agent's permissions, so
  it ships inside the CLI rather than being fetched: it installs offline, is readable before
  it ever runs, and there is no delivery path for one bad push to reach every install.
  `--print` dumps the full text without writing anything.

- **`cc-audit capture [--on|--off|--status]` — disclosed data sharing.** Sends the
  privacy-safe aggregate plus your task gists (the prompt text you typed, with model/turn/
  tool counts). **Never your source code, diffs, file paths, or repo names — under any
  flag, with no opt-in.** Attributed to a random install key, not your hostname or email.

  The controls are the point:
  - Asked **once**, in the terminal, with the full list shown before you answer.
  - Never re-prompted in either direction. Declining is permanent until *you* revisit it.
  - `--off` is immediate, permanent, and survives upgrades.
  - `--status` prints the install key your data is stored under so you can request
    deletion against it. Retention: kept until you ask us to delete it.
  - Never answered ⇒ nothing transmitted, including on `--json` and non-TTY runs, which
    never prompt and never opt you in by silence. `--root DIR` runs never transmit.

  README's "what leaves your machine" section was rewritten to match. The old
  "by default: nothing" framing no longer describes the tool once sharing is on; the
  claim the product is written to is the narrower and durable one — **we never touch
  your source code**.

- **An external check on our cost math: reconciliation against Claude Code's own
  telemetry.** Every other test in this repo compares cc-audit to cc-audit.
  `src/__tests__/otelReconcile.test.ts` joins a captured OTLP stream to the matching
  transcripts on `request_id` — Claude Code's `claude_code.api_request` event carries
  the final per-request token counts plus Anthropic's own `cost_usd` — and asserts
  our arithmetic reproduces their figure exactly. Fixtures captured both ways at once
  from two scripted sessions (10 requests, 4 subagent sidechains, 5 streamed across
  multiple rows); procedure and scrubbing rules in MAINTAINING.md.

  | pricing basis | vs Claude Code's `cost_usd` |
  |---|---|
  | transcript, with the 5m/1h split | **exact — every request, to 1e-9** |
  | wire only, all cache writes as 1h | +10.4% |
  | wire only, all cache writes as 5m | −23.9% |

  Three things this settles. **(1) Our transcript read loses no tokens** — including
  on the streamed multi-row messages and subagent sidechains that have actually
  broken before; this is the check the 0.5.2 undercount would have failed, and it
  retires the theory that the transcript's own per-field maximum is itself partial.
  **(2) Claude Code prices Sonnet 5 at the steady-state $3/$15**, not the live
  introductory $2/$10 — exactly 1.5x ours, which is the entire reported "cc-audit
  runs 40% below `/cost`" defect, now pinned by assertion rather than argued.
  **(3) The OTLP wire cannot reproduce an exact bill:** it collapses cache creation
  into one figure while the 5m and 1h write tiers price at 1.25x and 2.0x input, and
  real corpora mix them — here the subagent requests were 5m and the main chain 1h,
  with no wire attribute to tell them apart. That is a hard ceiling for anything
  proposing to source cost from OTel instead of the transcript.

- `scripts/otlp-capture.py` — a dependency-free OTLP/HTTP-JSON receiver for
  re-capturing the corpus. Stores raw wire batches untouched so fixtures stay
  captured rather than authored.

### Fixed

- **The weekly run-rate row priced Sonnet 5 at a different tariff than the
  headline above it.** `computeWeeklySpend` called `turnCostUsd` without the turn
  timestamp, so it always resolved the steady-state rate while every other call
  site passed `t.ts` and got the dated introductory rate. For a Sonnet 5 corpus
  that put two figures **1.50x apart inside the same SPEND card**, off the same
  turns. One missing argument, and no type error — the parameter is optional.

### Added

- **The SPEND card now discloses introductory-rate pricing.** cc-audit was
  reported as running "40% below Claude Code's own cost figure" on Sonnet 5. It is
  not. Anthropic's published card lists Sonnet 5 twice — $2/$10 per MTok through
  2026-08-31, $3/$15 from 2026-09-01 — and our vendored table transcribes both rows
  exactly, cache tiers included. The LiteLLM DB that `ccusage` reads publishes
  $2/$10 as well. **Claude Code's own cost figure uses $3/$15**, which is the
  entire 1.5x: on a measured two-session corpus the same tokens price to
  $0.49971950 (intro — matching cc-audit to seven decimal places) versus
  $0.74957925 (steady-state).

  We keep the rate that matches the console and the rate card, and *name* the other
  one rather than adopt it — a reader comparing this card to `/cost` now sees both
  figures and the multiple between them instead of an unexplained gap.
  `attributeSpend` populates the disclosure only when the two tariffs actually
  differ for a turn's timestamp, so it self-retires when the last introductory
  window closes. There is no date to maintain.

  Dropping the introductory entry instead would have been wrong three ways: it
  reprices *history* (the override exists precisely so old usage keeps the rate it
  was billed at), it overstates the invoice by 1.5x for anyone on an API key, and it
  fails `pricingDrift.test.ts`, which cross-checks the time-aware rate against
  LiteLLM. That last one is not an argument — it was verified by deleting the entry
  and watching the guard fail.

- `src/__tests__/pricingSonnet5Tariff.test.ts` pins the tariff so the next change
  fails loudly instead of silently repricing history: both dollar figures for the
  measured corpus, the cutover across a single millisecond, no-timestamp falling
  back to steady-state, a dated `-20260901` variant staying inside the window, and
  the weekly-bucket regression above. Every assertion was confirmed to fail against
  the unfixed code.

### Known

- **A ~10% undercount survives at steady-state rates and is NOT fixed here.** The
  measured corpus recomputes to $0.74957925 against Claude Code's own $0.83613360 —
  10.35% low at the *same* tariff — and one of its sessions reads 2933 output tokens
  off the transcript against 3845 on Claude Code's OTel wire, a 912-token gap on
  output alone *after* the 0.5.2 per-field max-merge. Two candidate causes were
  measured and ruled out on a 1,614-file corpus: no assistant row is missing a
  `usage` block (0 of 187,657), and the documented cross-file `seen` residual is
  exactly 2,114 tokens — 0.003% of output, three orders of magnitude too small. The
  remaining lead is that the transcript's highest observed `output_tokens` for a
  message is *itself* sometimes partial: 3,356 message ids carry
  `stop_reason: null` on their max-output row, meaning the last row logged was not
  the stream's final chunk. That population averages 12.4 output tokens, so it
  disappears into a 69.9M-token corpus while plausibly dominating a short scripted
  session. Unconfirmed — it needs a wire capture alongside the transcript, which is
  its own investigation.

## 0.5.2 — 2026-07-25

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
