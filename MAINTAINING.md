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

- `pricing.ts` is mirrored **verbatim** so re-sync is a straight file copy.
- `tokenizer.ts` vendors **only** `CharCountTokenizer` (zero-dep). Upstream's
  `OpenAiTokenizer` pulls `js-tiktoken`, which cc-audit does not use — leave it out.

**When Anthropic/OpenAI pricing changes, update this repo AND the upstream config-cost
table together.** config-cost has a `litellm-drift` test guarding its table; this mirror
has no such guard, so they can silently diverge.

**Proper fix (follow-up):** publish `@promptster/config-cost` as a standalone npm package
during pricing centralization, depend on it here, and delete `src/vendor/`.

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

### Standalone binaries (`pa-arth/cc-audit-releases`)

`scripts/bundle.mjs` builds `bun --compile` single-file binaries
(darwin-arm64/x64, linux-x64) plus a Node `.mjs` fallback into `bundles/`. These are
uploaded as release assets to the public `pa-arth/cc-audit-releases` repo. Requires `bun`
on PATH. (CI automation for the binary release is a follow-up; the npm path is the one
that matters for `npx`.)
