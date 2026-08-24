# Maintaining cc-audit

Internal notes for maintainers. Not shipped to npm (only `cc-audit.mjs`, `README.md`,
`LICENSE` are in the published tarball).

## Repo split lineage

This repo was extracted from the `promptster-backend` monorepo
(`packages/cc-audit`, on branch `feat/cc-audit-judge-consent-cutoffs`) to decouple it
from the workspace. The hosted judge API stays a loose HTTP boundary — see
**Hosted API** below.

## Vendored pricing (drift risk)

`src/vendor/pricing.ts` and `src/vendor/tokenizer.ts` are **hand-copied mirrors** of
`@promptster/config-cost` (`packages/config-cost/src/{pricing,tokenizer}.ts` in the
backend). They were vendored because config-cost is a `workspace:*` dep that doesn't
exist on npm.

- `pricing.ts` is mirrored **verbatim** (vendor header + upstream body, no edits) so
  re-sync is a straight file copy.
- `tokenizer.ts` vendors **only** `CharCountTokenizer` (zero-dep). Upstream's
  `OpenAiTokenizer` pulls `js-tiktoken`, which cc-audit does not use — leave it out.
  The sync script below does NOT touch it.

**When Anthropic/OpenAI pricing changes, update this repo AND the upstream config-cost
table together.** Two guards keep the mirror honest (added after 0.4.0 shipped stale
tables that silently mis-priced `claude-sonnet-5`/`claude-mythos-5` as Sonnet fallback):

- **Drift test** — `src/__tests__/pricingDrift.test.ts` is config-cost's `litellm-drift`
  test ported to run against the vendored tables: it cross-checks every entry against
  LiteLLM's community pricing DB (hard-fail on rate disagreement, warn on models LiteLLM
  lists that we don't price, degrades to pass offline so CI stays non-flaky). It also
  carries offline regression pins for the current-model entries + the Sonnet 5
  introductory-pricing window.
- **Sync script** — `node scripts/sync-pricing.mjs` re-copies the pricing source from a
  sibling backend checkout (probes `../promptster-backend/packages/config-cost/src/pricing.ts`;
  override with `--from <path>`), prepends the vendor header, and prints a diff summary
  (model keys added/removed). Idempotent: re-running against the same source is a no-op.
  After a sync, review `git diff src/vendor/pricing.ts`, run `pnpm test`, and update the
  offline pins in the drift test if models were added/removed.

### The drift history, and what it teaches

This section holds what used to be commentary inside `src/vendor/pricing.ts`. It was moved
here on the 2026-08-24 re-sync for a structural reason: the mirror is copied **verbatim**,
so any note written into it is deleted by the next sync — and those notes were themselves
what made the sync script refuse to run (`--force` was required to land the cache-write
axis). Notes about the mirror belong beside the mirror, not inside it.

The mirror has gone stale **three** times, and every one was the same mechanism — a
hand-copied table has no subscriber to the repo it was copied from:

1. **2026-07-31 → 2026-08-14, terra/luna.** The backend corrected `gpt-5.6-terra` and
   `gpt-5.6-luna`; this copy kept the launch tiers for two more weeks. Published 0.7.0 went
   out with luna 5x over.
2. **2026-08-22 → 2026-08-24, gpt-5.6/sol.** OpenAI repriced them off the GPT-5.5 tier,
   the backend fixed config-cost the same day (#780, `d2357e89`), and this copy carried
   5/0.5/30 for two more days — 25% over on input, 50% over on output.
3. **2026-07-09 → 2026-08-24, the cacheWrite AXIS.** The worst of the three, and invisible
   to everything above. OpenAI added a cache-write premium at the GPT-5.6 GA; upstream grew
   a `cacheWrite` field for it on 2026-08-12; this mirror had no such field, so
   `pricing.ts` billed written tokens at the plain input rate — 20% under on every 5.6
   write, for six weeks.

**The lesson is #3, not #1 or #2.** `pricingDrift` compares `input` / `cachedInput` /
`output`: the fields that exist on **both** sides. A missing rate **axis** is invisible to
it however green it runs, and `pricingPinned` was pinning per-row objects that simply had no
such key. So the review that matters is *"did the vendor add a new KIND of charge"*, not
*"did a number move"*. `pricingPinned.test.ts` now asserts the axis as a rule
(`cacheWrite === input * 1.25` on 5.6+, `=== input` below), which is the shape that fails
when a fourth model family arrives with a fifth kind of rate.

Two invariants that look like bugs and are not:

- **`cachedInput === input` on `gpt-5-pro` / `gpt-5.2-pro`** — those tiers publish no cached
  rate, and a discount is never applied before the vendor publishes it. Do NOT extend this
  to other `*-pro` keys on the strength of the name: `gpt-5.4-pro` and `gpt-5.5-pro` DO
  publish an ordinary 10% cached rate, and "correcting" them would over-bill every cached
  token they read. The exception is a property of what the vendor PUBLISHES.
- **`cacheWrite === input` below GPT-5.6** — a written token is an ordinary input token
  there. Setting it to `0` would make real input free on any row reporting a write count.

When the drift test goes red: **find out who is right, then fix the wrong side.** Do not
update the expectation to match the code — that is the exact habit that lets a wrong rate
ship.

**Proper fix (follow-up):** publish `@promptster/config-cost` as a standalone npm package
during pricing centralization, depend on it here, and delete `src/vendor/` + the script.

## Hosted API

cc-audit talks to backend endpoints over HTTP via the `CC_AUDIT_API` env var
(defaults to production). Endpoints:

- `POST /v1/public/cost-audit-report` — `--open` aggregate upload + shareable report
- `POST /v1/public/config-review` — hosted CLAUDE.md trim (`cc-audit fix`)
- `POST /v1/public/cost-audit` — `--judge` right-sizing **and** the context-hygiene
  ride-along — see below
- judge / percentile endpoints — right-sizing + benchmarking

### `--judge` ride-along: context-hygiene refinement

The avoidable-carry headline (missed `/compact` + `/clear`) is computed **fully local +
deterministic** in `contextHygiene.ts` — that number always renders with no network. The
deterministic detector flags *where* context ran overdue and a conservative *cost*, but
can't tell stale finished-task context from a genuinely-needed big working set. The
hosted judge sharpens it, and it rides in the **same** `/v1/public/cost-audit` request as
right-sizing — **no extra model call**.

- **Request** gained an optional `hygiene: HygieneJudgeItem[]` field alongside `sessions`
  (`{ kind: 'overdue'|'switch', peakTokens, turns, gists: string[] }`). `gists` are the
  user's own task gists in the episode window — the **same Tier-1 surface** as the
  right-sizing footprint gists (700-char truncated, harness tags scrubbed; never code,
  paths, sessionId, or project). The located episode stays local.
- **Response** may add an optional positional `hygiene: HygieneVerdict[]`
  (`{ staleShare: 0–1, confidence, reason }`), one per sent item. The backend should score
  the gist sequence: one task across the window ⇒ low `staleShare` (context was needed);
  many distinct tasks with no reset ⇒ high `staleShare` (lots of reclaimable carry). The
  CLI folds these in via `refineAvoidableCarry` (per-episode share + average extrapolated
  to the unsent remainder) and reprints the headline as `deterministic → refined`.
- **Backward compatible both ways:** an old backend ignores the extra request field and
  returns no `hygiene` array ⇒ the CLI keeps the deterministic headline. A new backend
  seeing no `hygiene` in the request just skips it.

On `--open`, the CLI also sends the refined number to `/v1/public/cost-audit-report` as a
sibling of `rightSizing`: `hygieneRefinement: { refinedUsdPerMonth, deterministicUsdPerMonth,
avgStaleShare, judgedCount }` (per-month $ + share + count — never gists). The store should
persist it and return it on `CostReportResponse.hygieneRefinement` so the **web report**
renders the same `deterministic → refined` headline as the TUI. Without `--judge`, it's
absent and the web report shows the deterministic `aggregate.contextHygiene` figure — the
same fallback as the terminal. The Promptster frontend duplicates these types in
`src/lib/api/client.ts` (no build coupling — keep them in sync; see the `contextHygiene`
block + `CostReportHygieneRefinement`).

Keep the request/response contract stable across the split. The aggregate Zod schema in
this repo (`src/aggregate.ts`) is the **source of truth**; the Promptster frontend keeps
its own duplicated `CostReportAggregate` type — no build coupling.

## Releasing

### npm (`npx @promptster/cc-audit`)

Publish is automated via GitHub Actions (`.github/workflows/publish.yml`) on a `v*` tag.

Required repo secret: **`NPM_TOKEN`** — an npm automation token with publish rights to
the `@promptster` scope.

```bash
pnpm version patch         # bumps package.json + creates vX.Y.Z tag
git push --follow-tags     # CI builds, tests, and publishes
```

The workflow guards that the tag matches `package.json`'s version. Trigger a dry-run
manually via the Actions tab (workflow_dispatch → dry_run).

Local equivalent (needs `npm login`):

```bash
pnpm run build:npm
npm publish ./bundles/npm --access public   # the leading ./ matters
```

### Standalone binaries (GitHub Release)

`scripts/bundle.mjs` builds `bun --compile` single-file binaries
(darwin-arm64/x64, linux-x64) plus a Node `.mjs` fallback into `bundles/`. Requires `bun`
on PATH locally.

**Automated:** the `Publish to npm` workflow (on a `v*` tag push) builds these on the runner
and attaches them — plus a `SHA256SUMS.txt` — to the GitHub Release for that tag, right after
the npm publish. The npm path stays the critical one for `npx`; the release steps run after it
so a bun/release hiccup can't block publish. Release creation uses the automatic `GITHUB_TOKEN`
(hence `permissions: contents: write`), so no extra secret is needed.

Cutting a release manually (needs `gh` + `bun`):

```bash
pnpm run bundle
( cd bundles && sha256sum cc-audit-* cc-audit.mjs > SHA256SUMS.txt )
gh release create vX.Y.Z --generate-notes bundles/cc-audit-* bundles/cc-audit.mjs bundles/SHA256SUMS.txt
```

## OTel reconciliation (external check on our cost math)

`src/__tests__/otelReconcile.test.ts` is the only test in this repo that grades our
arithmetic against something we did not write. Everything else compares cc-audit to
cc-audit; this compares it to **Claude Code's own telemetry**.

Claude Code emits a `claude_code.api_request` event carrying the FINAL per-request
token counts plus Anthropic's own `cost_usd`, keyed by a `request_id` the transcript
also records. That makes an exact join possible, so the question "did we read the
tokens right, and do we price them right" has an external answer.

**Findings pinned by that test** (captured 2026-07-26, Claude Code 2.1.220):

| pricing basis | vs Claude Code's `cost_usd` |
|---|---|
| transcript, with the 5m/1h split | **exact — every request, to 1e-9** |
| wire only, assume all cache writes are 1h | +10.4% |
| wire only, assume all cache writes are 5m | −23.9% |

1. **Our transcript read loses no tokens** — including on streamed multi-row messages
   and subagent sidechains, both present in the corpus. This is the check the 0.5.2
   streamed-output undercount would have failed.
2. **Claude Code prices Sonnet 5 at the steady-state $3/$15**, not the introductory
   $2/$10 that is live through 2026-08-31. Its figure is exactly 1.5x ours. That is
   the whole of the reported "cc-audit runs 40% below `/cost`" defect.
3. **The OTLP wire cannot reproduce an exact bill.** It collapses cache creation into
   one `cache_creation_tokens` figure, but the 5-minute and 1-hour write tiers price
   at 1.25x and 2.0x input, and real corpora mix them (here: subagent requests were
   5m, main-chain 1h). No wire attribute distinguishes them. Anything proposing to
   replace the transcript read with OTel inherits this as a hard cost-fidelity
   ceiling — it is not tunable.

### Re-capturing the corpus

Fixtures are captured, never hand-written. To refresh them:

```bash
python3 scripts/otlp-capture.py wire.jsonl 4318 &     # receiver -> wire.jsonl
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_LOGS_EXPORT_INTERVAL=1000 \
  claude -p "<a prompt that streams a long answer AND dispatches a subagent>" \
  --model claude-sonnet-5 --allowedTools "Read,Bash,Glob,Grep,Agent"
```

Then filter the batches to `claude_code.api_request` records for
`fixtures/otel-api-request-wire.jsonl`, and project the matching transcript rows
(join on `requestId`, per-field max across rows) into
`fixtures/otel-transcript-tokens.jsonl`.

Two rules when you do:

- **Keep a subagent and a multi-row streamed message in the corpus.** The pairing test
  asserts both are present, because they are the cases that have actually broken.
- **Scrub identity before committing — this repo is public.** The wire carries
  `user.email`, `user.id`, `user.account_uuid`, `user.account_id` and
  `organization.id` on every record. Replace those five values with placeholders and
  leave everything else byte-identical; the committed fixture is otherwise verbatim.
  Do not commit transcript prose, prompts, or `cwd` paths — the transcript fixture is
  deliberately a token-only projection.
