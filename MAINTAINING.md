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
- judge / percentile endpoints — right-sizing + benchmarking

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
