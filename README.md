<h1 align="center">cc-audit</h1>

<p align="center">
  <b>Point it at your Claude Code transcripts and see where the money — and the bad habits — are.</b><br/>
  Spend attribution · model right-sizing · context-hygiene waste · AI-fluency signals. <b>100% local by default.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@promptster/cc-audit"><img alt="npm" src="https://img.shields.io/npm/v/%40promptster%2Fcc-audit?color=f28c28&label=npm&labelColor=1a1f29"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-27c93f?labelColor=1a1f29">
  <img alt="telemetry: none" src="https://img.shields.io/badge/telemetry-none-10b981?labelColor=1a1f29">
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-ffcb6b?labelColor=1a1f29">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/pa-arth/cc-audit/main/assets/cc-audit-demo.svg" width="820" alt="cc-audit scanning local Claude Code transcripts and reporting spend, fixable waste, and AI-fluency percentile">
</p>

```bash
npx @promptster/cc-audit
```

That's it. **No install, no API key, no signup.** It reads your local Claude Code history
(`~/.claude/projects`) and shows you spend by model, the *fixable* waste (context you paid to
carry that a `/compact` or `/clear` would have shed), what your always-on config costs every
turn, and AI-fluency signals like plan-mode rate.

> Built by [**Promptster**](https://promptster.ai) — we measure and level up AI-engineering
> fluency across whole teams. `cc-audit` is the local, open-source slice of that, for your own
> machine. [More below ↓](#-built-by-promptster)

---

## Quick start

```bash
# one-off — nothing to install
npx @promptster/cc-audit

# use it regularly? install it
npm i -g @promptster/cc-audit && cc-audit
```

Prefer a single self-contained executable (no Node)? Grab a pre-built binary for macOS
(arm64 / x64) or Linux (x64) from the
[latest release](https://github.com/pa-arth/cc-audit/releases/latest) — or build your own with
`npm run bundle` (via [bun](https://bun.sh)).

## What it finds

- 💸 **Spend, attributed** — `$/mo` by model, your most expensive sessions, and cost broken
  down per prompt when a session actually did two different things.
- ⓪ **Fixable waste, first** — the *avoidable carry*: context held past the `~160K` `/compact`
  line, and task-switches a `/clear` would have reset. Real dollars, billed only above a
  conservative line — never a fabricated "all carry is waste" number.
- ① **Always-on context tax** — what your `CLAUDE.md`, memory, skills, plugins, and MCP
  servers cost you *every turn*. Useful ≠ free.
- 🧭 **AI-fluency signals** — plan-mode rate, prompts-per-session, command/skill leak, subagent
  spend, and a skill/MCP ROI ledger (what's earning its keep vs. dead weight).
- 🎚️ **Model right-sizing** *(opt-in `--judge`)* — which premium-model tasks a cheaper tier
  would have nailed. The frontier-vs-cheap call stays *your* policy; this just prices it.

## Usage

```bash
npx @promptster/cc-audit                 # local audit, then two questions (see below)
npx @promptster/cc-audit --judge         # + hosted right-sizing analysis
npx @promptster/cc-audit --open          # + shareable public web report
npx @promptster/cc-audit --json          # machine-readable, pure stdout
```

A bare run in a terminal ends with **three** questions, all default *Yes*:

1. **Run the analysis now?** Invokes `claude -p` (or `codex exec`) on a compacted summary
   of the report and prints **three ranked improvement plans** right there — no session
   restart, no memorized phrase. The same yes also installs
   `~/.claude/skills/cc-audit/SKILL.md`, so future sessions can coach you *with your repo
   loaded*, which produces better plans than this cold run can. Both paths run on **your**
   subscription; cc-audit never sends your sessions to a model of ours.
2. **Create a shareable link?** Uploads the web report — including the three plans your
   agent just wrote — to a URL you can send to anyone. ⚠️ Those plans quote your **real
   dollar figures** and your command, subagent, and skill names; that is strictly more than
   the privacy-safe metrics carry, and a published URL cannot be un-published. The prompt
   says exactly this before you answer.
3. **Share your data with Promptster?** See [What leaves your machine](#what-leaves-your-machine).
   Asked once, persisted, and never re-prompted in either direction.

The order matters: the analysis runs first so the link has something worth sharing, and so
the link's disclosure can name what the analysis actually produced.

Question 1 discloses its cost before spending it: invoking your agent consumes the same
rate-limit window this report exists to explain, so the confirm states the agent, whose
subscription pays, and the token estimate (~3k, from a compacted summary — not the raw
22KB record, and never your transcripts). `cc-audit --print-prompt` shows the exact prompt
and invokes nothing. No `claude`/`codex` on PATH, or an invocation that fails or times out,
leaves the measured report intact and says what didn't happen — a partial run never reads
as a complete one.

| Flag | What it does |
| --- | --- |
| `--since-days N` | Only look at the last N days. |
| `--root DIR` | Point at a transcript root other than `~/.claude/projects`. |
| `--rows N` | How many rows to show in the leaderboards. |
| `--aggressiveness conservative\|balanced\|aggressive` | How eagerly to flag over-modeled tasks as cuts (default `balanced`). |
| `--judge` | Hosted right-sizing — sends task *gists + metadata*, never code. |
| `--open` | Upload the privacy-safe aggregate and open a shareable web report. |
| `--json` | Print the aggregate record as JSON (pure stdout). |
| `--print-prompt` | Print the exact prompt that would go to your agent. Invokes nothing. |

<details>
<summary>Calibration &amp; patch subcommands</summary>

```bash
cc-audit skill  [--print]  # install the analysis skill (or print its full text)
cc-audit capture --status  # is sharing on? what install key is my data under?
cc-audit capture --off     # stop sharing: immediate, permanent, survives upgrades
cc-audit label   [--n 50]  # judge real sessions → a sheet you hand-label
cc-audit score   <file>    # score your labels vs. the judge (precision/recall)
cc-audit fix               # turn recommendations into reviewable patches (never auto-applied)
```
</details>

## What leaves your machine

**We never read your source code or diffs.** That holds under every flag and has no opt-in —
it is enforced at ingestion, not just asserted here. It is the line, and it does not move.

The *analysis* is local: parse → attribute → report runs with no network and no key. What can
leave, and only after you say so:

| Tier | Trigger | What's sent |
| --- | --- | --- |
| **0** — local read | first run | Sticky one-time ack. Reads `~/.claude/projects`. Nothing leaves. |
| **1** — sharing | the second question, or `cc-audit capture --on` | The privacy-safe *aggregate* (shares, counts, ratios — never raw `$`) **plus your task gists**: the prompt text you typed, with model/turn/tool counts. Never code, diffs, file paths, or repo names. Attributed to a random install key. |
| **1** — right-sizing | `--judge` | Each task's *gist + metadata* to the hosted model. Same exclusions. |
| **2** — shareable link | the second question, or `--open` | The privacy-safe *aggregate* **plus the plans your agent wrote**, to a link anyone with the URL can open. The plans are a higher tier than the aggregate: they quote your real `$` figures and your command/subagent/skill names. Still never your source code. A published URL can't be un-published. |

**On sharing specifically.** It is asked once, in the terminal, with the full list above shown
*before* you answer — not behind a link. Say no and you are never asked again. Say yes and:

- `cc-audit capture --off` stops it immediately and permanently, and survives upgrades.
- `cc-audit capture --status` prints the install key your data is stored under, so you can
  request deletion against it. Retention: kept until you ask us to delete it.
- The install key is a random UUID — not your hostname, email, or repo names — and deleting
  `~/.cc-audit/install.json` resets it.

**If you have never answered the question, nothing is transmitted** — including on `--json`
and non-TTY runs, which never prompt and never opt you in by silence. `--root DIR` runs never
transmit at all (an alternate corpus would pollute both your local history and ours).

## How it works

The deterministic half — parse → attribute → report — runs entirely on your machine. Egress is
a separate tier that only fires on an explicit flag or an answer you gave:

```
                    ┌──────────── LOCAL · deterministic · no network, no key ─────────────┐
  ~/.claude/        │                                                                     │
   projects   ───▶  │   adapter ─▶ model ─▶ attribute ─▶ ┬─ fluency ────────┐             │
  (your             │  (claudeCode)  (Session/  (spend    ├─ alwaysOn ───────┼─▶ report    │
   transcripts)     │                 Span)     by model) └─ contextHygiene ─┘   (TUI)     │
                    └─────────────────────────────────────┬───────────────────────────────┘
                                                          │
                                            consent-gated ▼
                            you said yes ─▶ sharing      aggregate + task gists ─▶ Promptster
                            you said yes ─▶ share link   aggregate + agent plans ─▶ web report
                            --judge      ─▶ right-sizing task gists + metadata  ─▶ hosted model

                    ┌─── LOCAL · your agent, your subscription, your window ───────────────┐
                    │  now:   claude -p / codex exec  ◀─ compacted summary (~3k tok)       │
                    │  later: ~/.claude/skills/cc-audit/SKILL.md ─▶ reads `cc-audit --json`│
                    │  (both embedded in the CLI, never fetched) ─▶ three improvement plans │
                    └──────────────────────────────────────────────────────────────────────┘
```

| Stage | Modules |
| --- | --- |
| **Ingest** | `adapters/claudeCode.ts` → `model.ts` (`Session`/`Span`). Tool-agnostic, so Codex/Cursor adapters can drop in later. |
| **Analyze** *(local)* | `attribute.ts`, `pricing.ts` + `vendor/` (cost tables), `fluency.ts` / `alwaysOn.ts` / `contextHygiene.ts`, tied together by `audit.ts` into an `AuditResult`; `aggregate.ts` is the privacy-safe record. |
| **Render** | `report.ts` + `theme.ts` (the only module that knows ANSI). |
| **Agent path** *(local)* | `agentRun.ts` — detect `claude`/`codex`, compact the findings, invoke with no tools. `skill.ts` — the embedded `SKILL.md`. Neither makes a network call of ours. |
| **Egress** *(consented)* | `capture.ts` (sharing), `judgeClient.ts` (`--judge`), `open.ts` (`--open`), `fixClient.ts` / `fix.ts` (`cc-audit fix`). All behind `consent.ts`. |

The core principle, preserved by design: **no code path phones home until you have said it
can** — a flag you passed, or the sharing question you answered yes to. Nothing is inferred
from silence, and a non-interactive run never opts you in.

## Not the assessment CLI

This is **not** [`@promptster/cli`](https://www.npmjs.com/package/@promptster/cli) (bin:
`promptster`), which candidates use to run Promptster hiring assessments. `cc-audit` audits your
*own* Claude Code spend and fluency. Different command, different job — you can have both
installed without conflict.

## Contributing

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest
npm run lint       # oxlint
node dist/cli.js   # run it locally
```

Pricing tables live in `src/vendor/` (a hand-copied mirror — see
[`MAINTAINING.md`](./MAINTAINING.md)). Issues and PRs welcome.

## 💼 Built by Promptster

`cc-audit` is the open-source, local slice of what [**Promptster**](https://promptster.ai) does
for engineering organizations: measure how fluently a team actually wields AI — spend, waste,
and skill — and turn that into a level-up plan. If the numbers this tool surfaces for *you* are
interesting, they're a lot more interesting across a whole team.

**[See Promptster for teams →](https://promptster.ai)**

## License

[MIT](./LICENSE)
