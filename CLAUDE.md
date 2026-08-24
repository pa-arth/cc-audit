# cc-audit

`@promptster/cc-audit` — point it at your local Claude Code transcripts and see where the
money and the bad habits are. Spend attribution, model right-sizing, AI-fluency signals.
Distributed as `npx @promptster/cc-audit` (a single-file bundle) and as standalone binaries.

**Core principle: local-first, consent-tiered egress.** The deterministic half (parse →
attribute → report) runs fully local with no network and no key. Only explicit opt-in steps
send anything, each gated proportional to what leaves the machine. Preserve this — never add
a code path that phones home on a bare/non-interactive run.

## Commands

```bash
pnpm build      # tsc → dist/  (run before node dist/cli.js or the bundlers)
pnpm typecheck  # tsc --noEmit
pnpm lint       # oxlint
pnpm test       # vitest run   (pnpm test:watch for watch)
pnpm dev        # tsc --watch

pnpm build:npm  # → bundles/npm/  (esbuild single file + clean package.json; the npm artifact)
pnpm bundle     # → bundles/      (bun --compile binaries + esbuild .mjs fallback; needs bun)
```

Package manager is **pnpm**, pinned by the `packageManager` field (`pnpm-lock.yaml` is the
committed lockfile; `pnpm install --frozen-lockfile` in CI). `scripts/only-pnpm.mjs` runs on
`preinstall` and REJECTS npm/yarn — this package is not published with that guard active
elsewhere, but here it is the rule. Use `corepack pnpm` if a stale pnpm shadows the pinned
one on PATH. Always `pnpm build` before running `node dist/cli.js`.

## Architecture

`src/cli.ts` is the entry point and the only place that orchestrates I/O, prompts, and the
consent flow. Everything it calls is a pure-ish module:

- **Ingest** — `adapters/claudeCode.ts` reads `~/.claude/projects` and
  `adapters/codex.ts` reads `~/.codex/sessions` → `model.ts` `Session`/`Span` types. The
  model is tool-agnostic so a Cursor adapter can drop in later.

  **Codex is opt-in behind `--codex`, and that is a correctness choice, not caution.** The
  rails do not observe the same things: Codex ships reasoning as `encrypted_content` (no
  `thinkingChars`), has no `Read` tool (no `reads`, so no redundant-read rate) and no plan
  mode. Those fields come back 0/`[]`, which is indistinguishable from "measured and found
  absent" — averaged in silently, a Codex-heavy user's fluency signals fall because of what
  the FORMAT omits. `Session.source` exists so a signal can select its rail instead.
  Spend, tokens, models, tools and file ops are fully measured on both.

  `--codex` also writes no history snapshot, never transmits, and is REFUSED alongside
  `--judge`/`--open`: `AggregateRecord.tool` is a frozen `z.literal('claude_code')`, so a
  two-rail corpus cannot be labelled honestly at the current schema version.

  **The two rails invert the token conventions.** `TurnUsage` is ADDITIVE (Anthropic:
  `input` excludes the cache buckets). Codex is SUBSET (`input_tokens` is the total,
  `cached_input_tokens`/`cache_write_input_tokens` are inside it), so `toTurnUsage`
  subtracts them back out. Reading Codex's `input_tokens` straight through double-counts
  the largest bucket in the file — cacheRead is 303M of 313M tokens on the local corpus.
  Its other trap is `token_count`: use `last_token_usage` (per request), never a difference
  of `total_token_usage`, and suppress a row that exactly repeats the previous one. That
  suppression is what makes all 25 local rollouts reconcile to the token.
- **Analyze (local, deterministic)** — `attribute.ts` (spend by model/command), `pricing.ts` +
  `vendor/` (cost tables), `fluency.ts` / `alwaysOn.ts` / `conditionalContext.ts` (fluency
  signals), `audit.ts` (ties it together into an `AuditResult`), `aggregate.ts` (the
  privacy-safe record). `report.ts` + `theme.ts` render the TUI.
- **Egress (opt-in)** — `footprint.ts` builds task gists; `judgeClient.ts` (`--judge`
  right-sizing), `open.ts` + the `--open` upload (shareable report), `fixClient.ts` / `fix.ts`
  (`cc-audit fix` reviewable patches). All hit backend HTTP endpoints behind `CC_AUDIT_API`.
- **`index.ts`** — the importable library surface (CLI lives in `cli.ts`, not exported there).

### The bare interactive run asks TWO questions
Both default Yes, both at the very bottom, after the whole report. **Order is load-bearing**:
the analysis runs first because its output is what makes the link worth creating, and the
link's disclosure has to name what the analysis actually produced.
1. **Run the analysis now, and install the skill** (`agentRun.ts` + `skill.ts`). One yes does
   both because they cover different moments:
   - **Shell-out** (`claude -p` / `codex exec`) answers "right now" — plans printed in the
     same terminal, same run. This is the first-run experience; the skill path alone (install
     → restart session → recall a phrase) is too much friction before any value lands.
   - **Skill** is the durable path and produces *better* plans, because it runs inside a
     session with their repo loaded and can cite the actual line in the actual CLAUDE.md.
     Installing is a file write, so it rides along free.

   Both instruction sets are EMBEDDED in the binary, never fetched — they execute with the
   user's agent's permissions, so a network delivery path would be an instruction supply
   chain. Posture is structural, not asserted: the data goes inline and no tools are granted
   (`--allowed-tools ''` / `-s read-only`).

   **Two rules the shell-out must keep.** (a) Disclose the window cost before spending it —
   invoking their agent consumes the same rate-limit window the report explains. (b) Bound
   the input: `compactFindings()` sends ~11KB, not the raw ~22KB record, and DECLARES its
   truncation in-band so the model can't mistake a subset for everything. Degradation is
   named — no agent, failure, or timeout leaves the deterministic report intact and says what
   didn't happen. A partial run must never read as complete.
2. **Shareable link + data sharing** (`offerShareLink` + `advice.ts` + `capture.ts`) — ONE
   confirm with two effects: publish the web report (carrying the agent's written plans
   alongside the aggregate) and switch on sharing with Promptster.

   **Bundling only runs one way, and that direction is the argument.** The link is the
   larger disclosure — a URL anyone can open beats sending the same numbers privately to us
   — so someone who accepts the link is not surprised by the send. The reverse would be
   indefensible. Consequently there is NO path that turns sharing on without
   `captureDisclosure()` having printed first, and `--open` consents to the link ONLY
   (nobody read the disclaimer on a flag).

   **A No is not an opt-out.** Declining a public URL is a different decision from declining
   to share, so a No writes nothing: it must not record `capture: false` and must not revoke
   a previous Yes. Only `cc-audit capture --off` turns it off. `ConsentState.capture` stays
   tri-state (`undefined` = never answered) — that is what keeps a No from being logged as
   a decision it wasn't.

   **The advice is a HIGHER privacy tier than the aggregate and the copy must keep them
   separate.** The aggregate is shares and counts. The plans quote real dollar figures and
   real command/subagent/skill names — which is exactly what makes them useful. Rolling both
   into one reassuring sentence would be true-in-parts and false-overall. Source code still
   never leaves, on this path like every other.

   The advice text is FREE-FORM model output. `parseAdvice()` is best-effort and returns
   `plans: null` when the shape is unfamiliar; `raw` is always populated. **Never make a
   render depend on the parse** — a strict parser's failure mode here is a blank report.

A third question needs a real argument. The ladder was five confirms, then three, and each
cut was because the extra prompt read as noise rather than as a choice.

### Consent tiers (see `consent.ts`)
- **Tier 0** local read — sticky one-time ack, persisted to `~/.cc-audit/consent.json`.
- **Tier 1** sharing — aggregate + task gists to `/v1/public/solo-capture`, keyed on the
  install key. Turned on by a *yes* to the second question or `cc-audit capture --on`;
  turned off only by `cc-audit capture --off`. Sticky; a no to the question writes nothing.
- **Tier 1** `--judge` — task gist + metadata to the hosted model, never code/paths. Flag-only.
- **Tier 2** shareable link — aggregate + the agent's plans, to a URL anyone holding it can
  read. The second question, or `--open`. A reachable URL can't be un-published, so the
  disclosure runs on BOTH paths (the non-interactive `--open` receipt names the advice too).
  `--open` grants Tier 2 only — it never escalates into Tier 1 sharing.

**Source code and diffs never leave, under any flag.** There is no opt-in for it. That is the
claim the product is written to — never "nothing leaves your machine", which capture makes false.

`--json` and any non-TTY run are strictly non-interactive: they never prompt, and transmit only
on an explicit `--judge`/`--open` or a previously-answered sharing consent. Silence never opts
anyone in. `--root DIR` never transmits (it would pollute both local history and the corpus).
**stdout under `--json` must stay pure JSON** — route diagnostics/notices to stderr.

## Conventions that bite

- **Theme/color** (`theme.ts`) is the only module that knows ANSI. Color auto-disables when
  not a TTY, under `NO_COLOR`, or in tests — so report assertions match plain text. Use the
  `c.*` helpers; don't emit escapes elsewhere.
- **Vendored pricing** (`src/vendor/`) is a hand-copied mirror of `@promptster/config-cost`.
  Mirrored VERBATIM — never hand-edit it; `scripts/sync-pricing.mjs` re-copies from a backend
  checkout and refuses to overwrite a modified mirror. Two guards watch it: `pricingDrift`
  (vs LiteLLM, needs network, degrades to pass) and `pricingPinned` (offline, deterministic).
  Neither can see a missing rate AXIS — that hole cost six weeks of 20%-under GPT-5.6 cache
  writes. `MAINTAINING.md` has the full drift history and the two invariants that look like
  bugs and are not.
- **Version** (`src/version.ts`) — `VERSION` is injected at bundle time via esbuild/bun
  `--define:__CC_AUDIT_VERSION__` (both build scripts read it from `package.json`). The raw
  `tsc` dev build has no define, so it falls back to reading `package.json`. If you add a
  build path, inject the define or the bundle reports a stale/wrong version.
- **Update check** (`src/updateCheck.ts`) — best-effort npm-registry check, cached a day in
  `~/.cc-audit`, short timeout, never throws, never blocks. Notice goes to **stderr** (so it
  can't corrupt `--json`). Silenced by `CC_AUDIT_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` / `CI`.
- **Tests** live in `src/__tests__/`. For anything touching `~/.cc-audit`, isolate by setting
  `process.env.HOME` to a tmpdir in `beforeAll` (see `consent.test.ts`, `updateCheck.test.ts`).

## Releasing & hosted API

See `MAINTAINING.md` — npm publish is automated on a `v*` tag; `CC_AUDIT_API` env var points
at the backend; the `aggregate.ts` Zod schema is the source of truth for the report contract.
