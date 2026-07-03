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
  After a sync, review `git diff src/vendor/pricing.ts`, run `npm test`, and update the
  offline pins in the drift test if models were added/removed.

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
npm version patch          # bumps package.json + creates vX.Y.Z tag
git push --follow-tags     # CI builds, tests, and publishes
```

The workflow guards that the tag matches `package.json`'s version. Trigger a dry-run
manually via the Actions tab (workflow_dispatch → dry_run).

Local equivalent (needs `npm login`):

```bash
npm run build:npm
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
npm run bundle
( cd bundles && sha256sum cc-audit-* cc-audit.mjs > SHA256SUMS.txt )
gh release create vX.Y.Z --generate-notes bundles/cc-audit-* bundles/cc-audit.mjs bundles/SHA256SUMS.txt
```
