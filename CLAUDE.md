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
npm run build      # tsc → dist/  (run before node dist/cli.js or the bundlers)
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint
npm test           # vitest run   (npm run test:watch for watch)
npm run dev        # tsc --watch

npm run build:npm  # → bundles/npm/  (esbuild single file + clean package.json; the npm artifact)
npm run bundle     # → bundles/      (bun --compile binaries + esbuild .mjs fallback; needs bun)
```

Package manager is **npm** (`package-lock.json` is the committed lockfile; `npm ci` in CI).
Always `npm run build` before running `node dist/cli.js`.

## Architecture

`src/cli.ts` is the entry point and the only place that orchestrates I/O, prompts, and the
consent flow. Everything it calls is a pure-ish module:

- **Ingest** — `adapters/claudeCode.ts` reads `~/.claude/projects` → `model.ts` `Session`/`Span`
  types. The model is tool-agnostic so Codex/Cursor adapters can drop in later.
- **Analyze (local, deterministic)** — `attribute.ts` (spend by model/command), `pricing.ts` +
  `vendor/` (cost tables), `fluency.ts` / `alwaysOn.ts` / `conditionalContext.ts` (fluency
  signals), `audit.ts` (ties it together into an `AuditResult`), `aggregate.ts` (the
  privacy-safe record). `report.ts` + `theme.ts` render the TUI.
- **Egress (opt-in)** — `footprint.ts` builds task gists; `judgeClient.ts` (`--judge`
  right-sizing), `open.ts` + the `--open` upload (shareable report), `fixClient.ts` / `fix.ts`
  (`cc-audit fix` reviewable patches). All hit backend HTTP endpoints behind `CC_AUDIT_API`.
- **`index.ts`** — the importable library surface (CLI lives in `cli.ts`, not exported there).

### The bare interactive run asks exactly TWO questions
Both default Yes, both at the very bottom, after the whole report:
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
2. **Share data** (`capture.ts`) — asked ONCE, persisted, **never re-prompted in either
   direction**. Re-asking someone who declined is what turns disclosed capture into a dark
   pattern; `ConsentState.capture` is tri-state (`undefined` = not yet asked) for exactly this.

Adding a third question needs a real argument. The ladder used to be four and it was noise.

### Consent tiers (see `consent.ts`)
- **Tier 0** local read — sticky one-time ack, persisted to `~/.cc-audit/consent.json`.
- **Tier 1** sharing — aggregate + task gists to `/v1/public/solo-capture`, keyed on the
  install key. Sticky answer; `cc-audit capture --off/--on/--status`.
- **Tier 1** `--judge` — task gist + metadata to the hosted model, never code/paths. Flag-only.
- **Tier 2** `--open` — privacy-safe aggregate to a PUBLIC link. Flag-only, never a question:
  a reachable URL can't be un-published and prompt context carries credentials.

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
- **Vendored pricing** (`src/vendor/`) is a hand-copied mirror of `@promptster/config-cost`
  with no drift guard. When Anthropic/OpenAI pricing changes, update here AND upstream. See
  `MAINTAINING.md`.
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
