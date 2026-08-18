# Changelog

Notable changes to `@promptster/cc-audit`. GitHub Releases carry the same notes
(the publish workflow attaches binaries per `v*` tag — see MAINTAINING.md).

## 0.9.0 — 2026-08-18

> **A third axis.** 0.8.0 could tell you what your sessions cost and how long they ran.
> It could not tell you how many were running at the same time — and if you run more
> than one, that single fact reframes every other number in the report. Adds the
> measurement, the report section, and a Windows path fix that predates this release.

### Added

- **`computeConcurrency()` + a `CONCURRENCY` section in the report.** Two totals over
  the same minutes: `agentMinutes` (each session's active minutes summed — how long the
  work would have taken back to back) and `wallMinutes` (their union — how long it
  actually took). Their ratio is the mean number of sessions live whenever anything was
  live.

  ```
  ╭─ CONCURRENCY  ·  how many ran at once, and what it bought ───────────────────╮
  │ 2.7× average — sessions live whenever anything was live                      │
  │ 180.2h of your time carried 484.9h of agent work (+304.6h)                   │
  │ live     yours    agent  share              /agent-hr                        │
  │ 1        58.8h    58.8h  █████████████  33%       6.4                        │
  │ 2        41.8h    83.6h  █████████▎     23%       6.9                        │
  │ 3-4      51.0h   174.8h  ███████████▍   28%       7.2                        │
  │ 5-7      25.6h   141.8h  █████▊         14%       6.6                        │
  │ 8+        3.0h    25.9h  ▊               2%       5.1                        │
  │ solo 33% of your time · two or more 67%  — the tallest bar, still a minority │
  ╰──────────────────────────────────────────────────────────────────────────────╯
  ```

  The card prints the **shape**, not just the average, because the average is the part
  that misleads. Solo is routinely the tallest single bar while being a minority of the
  time, and a reader handed only "2.7×" reads it as *mostly alone*. The solo line says
  outright which it is.

  Three things a single number would have hidden, all reported:

  - **`sensitivity`** sweeps the bridge threshold (1/2/5/10 min) instead of reporting one
    flattering value. The bridge — how long a gap still counts as working — is the
    method's only free parameter. A finding that dies inside its plausible range was
    never a finding, and a reader cannot tell the two apart without the sweep.
  - **`sessionWeightedMean`** beside `meanConcurrent`. The first is how crowded it is
    from inside a running session, the second is what you experience. On the development
    corpus they are 3.8 and 2.7 — they answer different questions and neither is the
    "real" one.
  - **Both prompt rates.** Per **agent** hour asks whether each session needs less of you
    when there are more of them; per **wall** hour is what the day feels like. They move
    in opposite directions (6.4 → 5.1 against 6.4 → 44.1 here), so either alone tells
    half the story. The verdict line is *derived from the ratio*, so a corpus where
    attention does not hold flat gets the opposite sentence rather than the flattering
    one.

  Idle time is excluded rather than averaged in as zero: this measures how many ran when
  anything ran, not an average over the calendar. Prompts counted for steering skip
  sidechain spans — a subagent's task instruction is the machine talking to itself, not
  you steering.

  Local-only for now. Every field is a count or a ratio with no paths, project labels or
  session ids, so it *could* be uploaded — but adding it to the aggregate is a
  schema-version decision, not a rendering one, and is deliberately not made here.

- **`Session.parentSessionId` + `concurrencyKey()`.** Claude Code 2.1.x moved subagent
  turns out of the parent transcript and into `<session>/subagents/agent-*.jsonl`. The
  loader makes one `Session` per **file**, which is right for spend — message-id dedup
  keeps the total honest — and wrong for anything that counts sessions: a parent with six
  subagents reads as **seven** concurrent sessions. Anything counting sessions groups on
  `concurrencyKey()`, and a test asserts the naive version says 7 where the correct one
  says 1.

### Fixed

- **Transcript paths were split on `/` only.** The loader builds them with `join()` from
  `node:path`, which emits backslashes on Windows, so the split returned a single
  segment there: the whole absolute path became the `sessionId`, and — with the new
  parent link — every subagent became an independent top-level session, inflating
  session count, peak, mean concurrency and minutes bought by however many subagents a
  run spawned.

  The `sessionId` half of this predates this release and shipped in every prior version.
  Both sites now go through one helper, so a third caller cannot reintroduce it.

## 0.8.0 — 2026-08-15

> **Two numbers you have been reading are wrong in 0.7.0, and both are corrected here.**
> The always-on breakdown was censused off disk instead of measured off the transcript,
> and the OpenAI table still carried `gpt-5.6`'s launch-day rates. If you audit Codex
> sessions, the second one has been overstating `gpt-5.6-luna` turns **5x** ever since
> the vendor repriced — recorded in our backend on 2026-07-31, two days after 0.7.0
> shipped. Upgrade before you cite a Codex figure.

### Fixed

- **`gpt-5.6-terra` / `gpt-5.6-luna` carried the launch tiers.** Both were repriced
  after GA; this copy of the table never got the correction.

  ```
  terra  2.5 / 15 / 0.25  ->  2   / 12  / 0.2
  luna   1   /  6 / 0.1   ->  0.2 /  1.2 / 0.02
  ```

  So luna turns were billed **5x** over and terra **1.25x** over in every report
  0.7.0 produced. A wrong-but-present rate is the quiet failure of this table — a
  missing model bills $0 and disappears, a bad prefix match bills 12x under, but a
  stale rate leaves every downstream number still looking like a number.

  The defect is not the two rows. `src/vendor/pricing.ts` is a hand-copied mirror of
  the backend's `config-cost` with **no subscriber** to it, so it can only go stale
  silently, and did, for two weeks. Diffed the two tables in full: 29 OpenAI rows and
  16 Anthropic rows on both sides, identical key sets, these two the only divergence —
  one missed sync, not a pattern. `pricingDrift.test.ts` is the one thing that noticed,
  and it did its job: it went red on the first CI run after the repricing and stayed
  red rather than being relaxed to green. It now says in its own header that a red run
  means *find out who is right*, never *update the expectation*.

  Added `pricingPinned.test.ts`, a deterministic companion: drift asks whether the
  VENDOR moved and degrades to pass offline, this asks whether OUR table moved
  underneath us and runs everywhere. Only rows with a reason to be pinned are in it.

- **A `pro`-tier pricing comment that would have caused the next mis-pricing.** The
  header claimed the `pro` tiers publish no cached-input rate and must be set to
  `cachedInput == input`. False since `gpt-5.4-pro` / `gpt-5.5-pro` — both publish
  3/M, the ordinary 10%, and the table correctly carries it. A reader trusting the
  comment would have "restored" them and over-billed every cached token they read.
  The real exception set is three rows, now named with reasons instead of derived
  from the word "pro": `gpt-5-pro` and `gpt-5.2-pro` (genuinely no published rate)
  and `codex-mini-latest` (genuinely 25%).

- **The turn-1 prefix now includes what it READ from cache.** `computeAlwaysOn`
  sampled `input + cacheWrite` from the first main-chain turn, which is the prefix
  only when the session opened **cold**. A session resuming in a project it has run in
  before finds the prefix already cached — it reads everything and writes nothing — so
  the observed standing context came out smallest exactly where it is largest.

  Turn 1 reads from cache in **97.9%** of 522 local sessions. The median prefix moves
  40,272 → 59,645 (1.48x), landing within 1.8% of the same quantity measured
  independently by differencing `claude -p` runs (60,738). Every existing fixture
  carried `cache_read: 0`, which is why nothing caught it.

- **A resumed transcript no longer inflates `fixedPrefixTokens`.** Attachment
  collection closes at the first main-chain assistant row, which on a resumed
  transcript is a replay owned by an earlier file and is then dropped by the cross-file
  dedup — leaving the measured prefix on a *later* turn that has the whole replayed
  conversation folded into its cache read. Turn-1-sized attribution against a much
  larger measurement inflates the residual, and the reconciliation check cannot catch
  it because it only fires on a negative remainder.

  Such a session is now declined and counted rather than measured wrongly. The
  observed `standingContextTokens` is deliberately unaffected — a resumed turn really
  did carry that much; only the breakdown is unanswerable, and `unmeasured` says so
  with its own reason. **Zero instances in the 926-session authoring corpus**, so this
  corrects no number today; it closes a path that would have been invisible when it
  did fire.

### Changed

- **The always-on breakdown is measured from the transcript, not censused off disk.**
  It used to answer "what did you put in your context" by walking `~/.claude`. The
  context is not assembled from disk — Claude Code assembles it and records it,
  itemised, as typed `attachment` rows ahead of the first assistant turn, and none of
  those were being read. Over 501 local sessions:

  ```
  skill listing    967 tok  ->   5,683 tok   (skillCount 15 -> 78)
  hook output     no field  ->     948 tok
  auto-memory       folded  ->   2,990 tok
  fixedPrefix     no field  ->  49,623 tok   (82% of the floor, and not yours to cut)
  ```

  This is a class, not four bugs: a disk census has **no subscriber to a Claude Code
  release**. Built-in skills ship inside the binary and are never on disk; the agent
  listing and deferred-tool delta move when the tool updates while nothing in
  `~/.claude` does. It cannot be wrong once and then fixed — it goes stale every
  release, silently.

  It was also not stale in one direction. It never read `settings.json >
  skillOverrides`, so six skills you had switched **off** were sized and billed every
  turn, and `readdirSync().isDirectory()` is false for a symlinked directory, so four
  more were invisible. The membership set was wrong, not just the magnitude, so
  scaling the floor up would not have fixed it. The listing's own `names[]` is now the
  authority and `skillCarry[].loaded` says so.

  The disk census is **retained and demoted**: it attributes a measured block to your
  files, it no longer decides how big the block is. Plugin and user-command listings
  turn out to appear *inside* the injected skill listing, so they are slices of it
  rather than addends — the old formula would have double-counted them the moment the
  listing became measured.

  Also in this area: `~/.claude/commands/**` is walked at all now (six `opsx:*`
  commands load into every listing and had never been counted); `mcpDeferred` is read
  from `deferred_tools_delta` in the sessions **as they ran** rather than inferred from
  the auditing process's own environment; unknown is `null` plus a named reason and
  never `0`, so a session that recorded no attachments votes neither a zero into a
  median nor an opinion on deferral; and a negative reconciliation remainder now FAILS
  and is reported per session, because clamping is how this whole defect class hides.

- **Aggregate `schemaVersion` 9 → 10.** `skillDescriptionTokens` is **removed** rather
  than kept beside `skillListingTokens`: a field that keeps its name while changing
  meaning lets a downstream comparison silently mix two quantities. Consumers should
  treat its absence as "this run measured the listing" — not as a zero.

### Internal

- Fixtures for this area are **recorded from real transcripts** by
  `scripts/record-injected-fixture.mjs`, never hand-authored — structure, field names,
  string lengths and usage numbers preserved, content replaced with same-length filler
  (size-faithful under `CharCountTokenizer`). A fixture written from the design doc
  would have passed against a broken parser, because the doc had both the kind list and
  the per-kind content field wrong.

  Two recorder defects were found and fixed by using it: identity fields were filled
  with *constant* filler, so a two-turn recording collapsed into one turn, and
  `tool_result.tool_use_id` was filled while the `tool_use.id` it names was not —
  severing a join the parser reads, and, because filler is length-preserving, pointing
  two distinct results at one key. Both produced fixtures encoding a shape Claude Code
  cannot emit, which is the exact failure recording fixtures exists to prevent.
  Identity is now a memoized bijection, and every fixture is asserted to keep the join
  intact.

- The unmeasured-reason strings are bounded and enumerable (`UNMEASURED_REASONS`).
  v10 put the first sentence-shaped strings into the uploaded aggregate, and the
  upload endpoint screens every string leaf and rejects the **whole capture** on a
  breach — while `sendCapture()` ignores the response by design so telemetry can never
  break a local run. Unbounded, the failure mode is every user's record silently not
  arriving from the release that lengthened a sentence.

## 0.7.0 — 2026-07-28

> **The two gaps named in 0.6.0 are closed.** The share page now renders the agent's
> plans, and data sharing transmits — both server halves shipped and are deployed. The
> 0.6.0 note below is left as written, because it was accurate at that release.

### Added

- **The plans are remembered, so a weekly run compounds.** Until now every run
  re-derived the same advice from scratch and had no idea whether you'd acted on it.
  The aggregate could measure that a number moved; nothing recorded what had been
  *recommended*, so "did they do it?" was unanswerable in principle, not just unbuilt.

  `writeAdvice()` now persists each run's plans to
  `~/.cc-audit/history/advice/<YYYY-MM-DD>-<window>.json` — `{generatedAt, agent, raw,
  plans, closing}` — beside the aggregate snapshot they were written about. Same
  one-file-per-day-per-window rule as snapshots, so a same-day rerun overwrites instead
  of accumulating near-duplicates, and the same `--root` exclusion, so an alternate
  corpus can't pollute the real timeline.

  SKILL.md gains **§3 "Check what you told them last time"** and the skill version bumps
  to 3 so existing installs refresh. It reads prior plans, names the field each targeted,
  quotes prev → cur, and says whether it moved.

  Three constraints on that section, which are the difference between useful and
  actively misleading:
  - **It must not claim credit.** A number moving is not proof the advice caused it — a
    quiet week or a finished project moves the same fields. It reports the movement
    alongside what was advised and stops.
  - **A plan you ignored is the most useful thing it can report.** Flat field plus the
    same plan about to be repeated ⇒ say so and ask what got in the way, rather than
    reprinting an identical plan weekly.
  - **Only compare within a window key.** A `w30` run and a bare `all` run cover
    different spans; diffing across them yields a number that means nothing.

  Stored in a *subdirectory* rather than as sibling files: `readBaseline()` matches every
  entry in `history/` against `SNAPSHOT_NAME`, and `<day>-<key>-advice.json` would have
  parsed as window key `w30-advice` — harmless today, but only by accident. A test pins
  that the snapshot lane is unaffected by a directory full of advice.

  `plans` is nullable on read, deliberately. `parseAdvice()` returns `plans: null`
  whenever the model's output shape is unfamiliar, and `raw` is always populated —
  rejecting those entries would silently drop exactly the weeks the model wrote prose.

  **Local only.** This is the most specific artifact cc-audit keeps: it names commands,
  skills, and real dollar figures. No egress path reads that directory — not `capture.ts`,
  not `open.ts`, not `judgeClient.ts`.

### Fixed

- **`--help` and the module header still described the old three-question flow**, left
  over from the two-question change. `--help` is user-facing and was telling people about
  a "Share your data with Promptster" prompt that no longer exists.

## 0.6.0 — 2026-07-28

> **Known gaps at the moment of this release**, stated here rather than discovered later.
> Both are server-side; the local half of the tool is unaffected.
>
> - **The shareable link renders the metrics but not yet the agent's plans.** The CLI
>   uploads them and the second question's disclosure names them, so until the receiving
>   end ships, that page shows less than the prompt said it would. It shows nothing it
>   said it wouldn't — the gap is under-delivery, not over-exposure.
> - **Data sharing transmits nothing yet.** The ingest endpoint is not deployed, so
>   `sendCapture()` gets a 404 and returns false silently, by design (a failed send must
>   never break a local run). Opting in today is recorded locally and starts having an
>   effect when the endpoint lands. Nothing is queued or retried from disk.
>
> Everything that runs locally — parse, attribute, report, the agent analysis, the skill
> install — is complete and unaffected by both.

### Changed

- **The bare interactive run now asks two questions instead of five.** The old offer
  ladder — local config edits, a hosted `CLAUDE.md` rewrite, right-sizing, a claude-hud
  statusline, a public report — was five confirms deep and buried the two that matter.
  What's left, both default *Yes*, both below the whole report:

  1. **Run the analysis now** → three ranked improvement plans, written by your own
     `claude`/`codex` and printed in the same terminal, plus the skill installed for
     next time.
  2. **Create a shareable link** → the web report carrying those plans, **and** data
     sharing with Promptster switched on. One confirm, two effects, with the full
     disclaimer for both printed immediately above it.

  Order is load-bearing: the analysis runs first so the link has something worth
  sharing, and so the link's disclosure can name what the analysis actually produced.

  Sharing is bundled into the link question in one direction only, and that direction
  is the argument: publishing to a URL anyone can open is a *larger* disclosure than
  sending the same numbers privately to us, so someone who accepts the link is not
  surprised by the send. There is no path that turns sharing on without the disclaimer
  having printed first — `--open` consents to the link alone, because nobody read the
  disclaimer on a flag.

  **Answering no is not an opt-out.** It publishes nothing and leaves your sharing
  setting exactly as it was: it does not record a decline, and it does not revoke a
  previous yes. Sharing is turned off by `cc-audit capture --off` and by nothing else.

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

- **The shareable web report now carries the agent's written plans.** The link is a real
  question again (it had been demoted to flag-only), and it renders the coaching, not just
  the metrics.

  **This raises what the link exposes, and the disclosure says so rather than glossing it.**
  The aggregate is the metrics report you just read, dollar figures included — it always
  was; `spend.perMonthUsd` and `fluency.carryUsd` are raw USD. The plans go further still:
  they *name* your commands, subagents, and skills, which the aggregate never does. Those
  are two different privacy tiers and the prompt lists them as two bullets, because one
  reassuring sentence covering both would be true in parts and false overall. Source code
  still never leaves, here as everywhere.

  The plans are free-form model output, so `advice.ts` treats structure as a bonus:
  `parseAdvice()` splits them into `{n, title, body}` plus the closing line when the shape
  is recognizable, and returns `plans: null` when it isn't. The verbatim `raw` text is
  *always* present, so a renderer is correct either way. A strict parser's failure mode here
  would be a blank report card, which is worse than an unstyled one. Parser is tested
  against the verbatim output of a real `claude -p` run, not an idealized fixture.

- **`cc-audit skill [--print]` — the analysis skill, embedded, not downloaded.** Installed
  by the same yes. It is the *better* of the two paths — running inside a session with your
  repo loaded lets it cite the actual line in your actual CLAUDE.md, which a cold shell-out
  can't — it just isn't the one that works in the first ten seconds.

  The skill is an instruction set that runs in your repo with your agent's permissions, so
  it ships inside the CLI rather than being fetched: it installs offline, is readable before
  it ever runs, and there is no delivery path for one bad push to reach every install.
  `--print` dumps the full text without writing anything.

- **`cc-audit capture [--on|--off|--status]` — disclosed data sharing.** Sends the
  aggregate plus your task gists (the prompt text you typed, verbatim, 700 chars each,
  with model/turn/tool counts). **We never read your source code, diffs, or file tree off
  disk — under any flag, with no opt-in.** Attributed to a random install key, not your
  hostname or email.

  Note the shape of that claim, because the earlier wording overreached. It said "never
  your source code, diffs, file paths, or repo names". The first two are enforced at
  ingestion. The last two were not: a gist is your prompt *unedited*, and `footprint.ts`
  applies no redaction, so a path or repo name you typed goes with it. Measured against a
  real 30-day corpus: 3 of 25 gists contained a repo name the developer had typed
  ("add CI to cc-audit"). 0 contained a file path or a code fence in that sample — but
  nothing prevents one. The copy now says what is enforced and what is merely typical.

  The controls are the point:
  - Switched on only by a *yes* to the shareable-link question — which prints this full
    list immediately above it — or by an explicit `cc-audit capture --on`.
  - Answering *no* to that question writes nothing at all: not a recorded decline, and
    not a revocation of a previous yes.
  - `--off` is immediate, permanent, and survives upgrades. It is the only thing that
    turns sharing off.
  - `--status` prints the install key your data is stored under so you can request
    deletion against it, and prints the exact `curl` that performs it — no account,
    no email, effective immediately. Retention: de-identified after 90 days, or
    deleted sooner on request.
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
