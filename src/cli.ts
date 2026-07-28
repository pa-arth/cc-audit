#!/usr/bin/env node
// cc-audit — point it at your Claude Code transcripts and see where the money
// and the bad habits are. The analysis is local (no network, no key): parse +
// attribute + report. A bare interactive run then asks exactly TWO questions,
// both default-Yes:
//
//   1. Install the analysis skill — writes ~/.claude/skills/cc-audit/SKILL.md so
//      the developer's OWN agent turns `cc-audit --json` into three improvement
//      plans. The skill text is embedded in this binary (see skill.ts); nothing
//      is fetched, and the model work runs on their subscription, not ours.
//   2. Share data with Promptster — the privacy-safe aggregate + the task gists
//      --judge already sends. Asked ONCE, persisted, never re-prompted (see
//      capture.ts / consent.ts). Never source code or paths, under any flag.
//
// `--json` and any non-TTY run stay strictly non-interactive: they never prompt,
// and only an explicit --judge/--open (or a previously-consented capture) sends
// anything — so CI and the audit skills are unaffected.
//
// Subcommands:
//   cc-audit                  full local report, then the two questions
//   cc-audit skill            install (or print) the analysis skill
//   cc-audit capture          --on / --off / --status for data sharing
//   cc-audit label [--out F]  judge real sessions → a sheet you hand-label (calibration)
//   cc-audit score <F>        score your filled sheet vs the judge (the USEFUL gate)
//   cc-audit label-fluency    sessions → a sheet you rate 0-100 (fluency calibration)
//   cc-audit score-fluency <F> fit the server fluency shapes to your ratings
//   cc-audit fix              turn recommendations into reviewable patches

import { readFileSync, writeFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { loadClaudeCodeSessions } from './adapters/claudeCode.js';
import { computeAndWriteKneeCache } from './kneeCache.js';
import { runStatusline } from './statusline.js';
import { runAudit } from './audit.js';
import {
  applyShareLinkAnswer,
  captureDisclosure,
  captureSetting,
  captureStatus,
  sendCapture,
  setCapture,
} from './capture.js';
import { readConsent, writeConsent } from './consent.js';
import type { ContextHygiene } from './contextHygiene.js';
import { buildFootprints, type SessionFootprint } from './footprint.js';
import { parseAdvice, type SharedAdvice } from './advice.js';
import { buildAnalysisPrompt, compactFindings, detectAgent, estimateTokens, runAgentAnalysis } from './agentRun.js';
import { installSkill, invocationHint, isSkillCurrent, SKILL_MARKDOWN } from './skill.js';
import {
  buildHygieneFootprints,
  refineAvoidableCarry,
  toRefinementUpload,
  type HygieneFootprint,
  type HygieneRefinementUpload,
} from './hygieneFootprint.js';
import { judgeFootprints, postReport, type RightSizingResult } from './judgeClient.js';
import { buildLabelSheet, renderScore, scoreLabels, type LabelRow } from './label.js';
import { buildFluencySheet, renderBandSummary, summarizeBands, type FluencyLabelRow } from './labelFluency.js';
import { isHostedTrimCandidate, renderFix, runFix } from './fix.js';
import { DAILY_CAP, spendToday } from './fixClient.js';
import { computeDelta, readBaseline, windowKey, writeSnapshot } from './history.js';
import { getInstallKey } from './installKey.js';
import { machineAnonId, openURL } from './open.js';
import { isPremiumModel } from './pricing.js';
import { type Aggressiveness, renderHygieneRefinement, renderReport, renderRightSizing } from './report.js';
import { checkForUpdate, renderUpdateNotice } from './updateCheck.js';
import { VERSION } from './version.js';

interface Args {
  root?: string;
  sinceDays?: number;
  json: boolean;
  judge: boolean;
  open: boolean;
  printPrompt: boolean;
  shareSessions: boolean;
  rows?: number;
  out?: string;
  n?: number;
  aggressiveness: Aggressiveness;
}

const AGGRO = new Set<Aggressiveness>(['conservative', 'balanced', 'aggressive']);

function ordinal(n: number): string {
  const r = Math.round(n);
  const v = r % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][r % 10] ?? 'th');
  return `${r}${suffix}`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, judge: false, open: false, printPrompt: false, shareSessions: false, aggressiveness: 'balanced' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
    else if (a === '--print-prompt') args.printPrompt = true;
    else if (a === '--judge') args.judge = true;
    else if (a === '--open') args.open = true;
    else if (a === '--share-sessions') args.shareSessions = true;
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--since-days') args.sinceDays = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--rows') args.rows = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--n') args.n = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--aggressiveness') {
      const v = argv[++i];
      if (v && AGGRO.has(v as Aggressiveness)) args.aggressiveness = v as Aggressiveness;
    }
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage:\n' +
          '  cc-audit [--since-days N] [--root DIR] [--rows N] [--json] [--judge] [--open]\n' +
          '          [--share-sessions] [--aggressiveness conservative|balanced|aggressive]\n' +
          '      Analyze ~/.claude transcripts locally. In a terminal, a bare run then asks\n' +
          '      three things, all default Yes:\n' +
          '        1. Run the analysis now on YOUR agent (claude -p / codex exec) — three\n' +
          '           improvement plans printed here, plus the skill installed for next time.\n' +
          '        2. Create a shareable link — the web report, INCLUDING those plans.\n' +
          '        3. Share your data with Promptster (asked once, never re-prompted).\n' +
          '      --print-prompt shows the EXACT prompt that would go to your agent and\n' +
          '          invokes nothing.\n' +
          '      The TOP SPENDERS leaderboard (with your prompt gists) is always LOCAL-only.\n' +
          '      --json prints the aggregate record; it never prompts, and transmits only\n' +
          '          if you already said yes to sharing (cc-audit capture --status).\n' +
          '      --judge calls the hosted right-sizing model (task gist + metadata, never code).\n' +
          '      --open uploads the privacy-safe aggregate and opens a shareable web report.\n' +
          '          When the analysis ran, the report also carries its written plans, which\n' +
          '          quote your REAL dollar figures and command names — more than the\n' +
          '          aggregate alone. Anyone with the URL can read it.\n' +
          '      --share-sessions adds an ANONYMIZED leaderboard (cost share, turns, model,\n' +
          '          plan-mode, trajectory — never gists, projects, or $) to the shared report.\n' +
          '      --judge/--open are never prompted for — the flag IS the consent.\n' +
          '      --aggressiveness gates which over-modeled tasks are recommended as cuts (default balanced).\n' +
          '  cc-audit skill [--print]\n' +
          '      Install the analysis skill to ~/.claude/skills/cc-audit/SKILL.md so your own\n' +
          '      agent can read `cc-audit --json` and write three improvement plans. The text\n' +
          '      is embedded in this binary — nothing is downloaded. --print shows it instead.\n' +
          '  cc-audit capture [--on|--off|--status]\n' +
          '      Data sharing with Promptster: your metrics report + your task gists (the\n' +
          '      prompts you typed, verbatim). We never read your code, diffs, or file tree\n' +
          '      off disk, under any flag — but a gist is what YOU typed, unedited, so a path\n' +
          '      or repo name you put in a prompt goes with it.\n' +
          '      --off is immediate, permanent, and survives upgrades. Bare = --status.\n' +
          '  cc-audit label [--n 50] [--out labels.json] [--since-days N] [--root DIR]\n' +
          '      Judge real sessions and write a sheet to hand-label (set trueMinTier per row).\n' +
          '  cc-audit score <labels.json>\n' +
          '      Score your filled sheet vs the judge: precision (gate ≥90%), recall, confusion.\n' +
          '  cc-audit fix [--since-days N] [--root DIR]\n' +
          '      Turn recommendations into REVIEWABLE patches under ./.cc-audit/ (never applied):\n' +
          '      local model-pin edits + a hosted CLAUDE.md trim (spends credits).\n' +
          '  cc-audit statusline\n' +
          '      LIVE GUARDRAIL label provider for the claude-hud statusline. Prints JSON\n' +
          '      {"label":"…"}: past your PERSONAL context-degradation knee it warns (soft), and\n' +
          '      at a compact boundary it says compact now (hard); otherwise a small ctx gauge.\n' +
          '      Self-discovers the live session from the cwd — no stdin. Strictly local, no\n' +
          '      network; the cross-session knee is cached under ~/.cc-audit/.\n' +
          '  cc-audit statusline --install   (and --uninstall)\n' +
          '      Auto-wire (or remove) the guardrail line in your claude-hud statusLine.command\n' +
          '      in settings.json — backs up first, refuses if the file has comments or a\n' +
          '      foreign --extra-cmd. A bare interactive `cc-audit` run also offers this.\n' +
          '  cc-audit --version\n' +
          '      Print the installed version. A bare run also warns (on stderr) when a newer\n' +
          '      version is published — silence with CC_AUDIT_NO_UPDATE_CHECK=1.\n',
      );
      process.exit(0);
    }
  }
  return args;
}

/** Interactive iff we have a real TTY both ways and aren't emitting JSON. Any
 *  non-interactive run does exactly what it did before: explicit flags only. */
function isInteractive(json: boolean): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY) && !json;
}

async function withSpinner<T>(message: string, fn: () => T | Promise<T>): Promise<T> {
  const s = p.spinner();
  s.start(message);
  try {
    const r = await fn();
    s.stop(message);
    return r;
  } catch (err) {
    s.stop(`${message} — failed`);
    throw err;
  }
}

/** Tier 0 — sticky one-time ack before reading ~/.claude. Interactive only; a
 *  non-interactive run reads locally with no prompt (nothing leaves regardless). */
async function ensureLocalReadConsent(interactive: boolean): Promise<void> {
  if (!interactive || readConsent().localRead) return;
  p.intro('Promptster CC Audit');
  p.note(
    [
      'Analyzes your local Claude Code history (~/.claude/projects) to estimate',
      'spend, context waste, and model fit. The analysis itself is local — no',
      'network, no key.',
      '',
      '• We never read your source code or diffs. Not under any flag, ever.',
      '• Nothing leaves this machine until you answer the sharing question at',
      '  the end of this run. If you say yes, what gets sent is spelled out',
      '  there before you answer.',
      '• Attribution is a random install key — never your hostname, email, or',
      '  repo names.',
      '',
      'This is not the assessment CLI (@promptster/cli).',
    ].join('\n'),
    'What this does',
  );
  const ok = await p.confirm({ message: 'Read local transcripts and run the audit?' });
  if (p.isCancel(ok) || !ok) {
    p.cancel('No problem — nothing was read.');
    process.exit(0);
  }
  writeConsent({ localRead: true });
}

function loadSessionsOrExit(args: Args, interactive: boolean) {
  const sessions = loadClaudeCodeSessions({ root: args.root, sinceDays: args.sinceDays });
  if (sessions.length === 0) {
    const msg = 'No Claude Code transcripts found under ~/.claude/projects.';
    if (interactive) p.cancel(msg);
    else process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
  return sessions;
}

async function runLabel(args: Args): Promise<void> {
  const interactive = isInteractive(args.json);
  await ensureLocalReadConsent(interactive);
  const sessions = loadSessionsOrExit(args, interactive);
  const footprints = buildFootprints(sessions, args.n ?? 50);
  if (footprints.length === 0) {
    process.stderr.write('No premium prompt-driven sessions to label.\n');
    process.exit(1);
  }
  const out = args.out ?? 'cc-audit-labels.json';
  process.stderr.write(`Judging ${footprints.length} sessions via the right-sizing model…\n`);
  const sheet = await buildLabelSheet(footprints);
  writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`);
  process.stdout.write(
    `\nWrote ${sheet.length} rows to ${out}.\n` +
      '  Open it and set "trueMinTier" on each row to the MINIMUM tier you would\n' +
      '  actually trust for that task: "haiku" | "sonnet" | "opus" | "fable".\n' +
      '  (Leave a row null to skip it.) Then run:  cc-audit score ' +
      `${out}\n`,
  );
}

async function runFixCmd(args: Args): Promise<void> {
  const interactive = isInteractive(args.json);
  await ensureLocalReadConsent(interactive);
  const sessions = loadSessionsOrExit(args, interactive);
  const today = new Date().toISOString().slice(0, 10);
  const result = runAudit(sessions, new Date().toISOString());
  // isHostedTrimCandidate already gates on kind === 'trim-config', a CLAUDE.md basename,
  // and existsSync — so the disclosure mirrors runFix's own skip and never fires for a
  // trim whose target was deleted between the audit and this run (no egress ⇒ no disclosure).
  const hasTrim = result.recommendations.some(isHostedTrimCandidate);
  // The CLAUDE.md trim is the only egress step. Generate/persist the install key only
  // when we're actually going to send — a no-trim run stays fully local.
  const installKey = hasTrim ? getInstallKey() : undefined;
  if (hasTrim) {
    // Surface exactly what leaves the machine: your CLAUDE.md content + a persistent
    // install key (identifies this install for the daily cap / dedup — never your code,
    // prompts, or paths). Same copy interactive vs. non-interactive so they can't drift.
    const disclosure =
      'The CLAUDE.md trim sends your CLAUDE.md content + a persistent install key\n' +
      '(identifies this install for the daily cap — never your code, prompts, or paths)\n' +
      `to the hosted config-review. Spends credits · ~${spendToday(today)} of ${DAILY_CAP} today.`;
    if (interactive) p.log.message(disclosure);
    else process.stderr.write(`${disclosure}\n`);
  }
  try {
    const proposals = await runFix(result.recommendations, today, { installKey });
    process.stdout.write(renderFix(proposals));
  } catch (err) {
    process.stderr.write(`fix failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

function runScore(file: string): void {
  let rows: LabelRow[];
  try {
    rows = JSON.parse(readFileSync(file, 'utf8')) as LabelRow[];
  } catch (err) {
    process.stderr.write(`Could not read label sheet ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${renderScore(scoreLabels(rows))}\n`);
}

async function runLabelFluency(args: Args): Promise<void> {
  const interactive = isInteractive(args.json);
  await ensureLocalReadConsent(interactive);
  const sessions = loadSessionsOrExit(args, interactive);
  const sheet = buildFluencySheet(sessions, args.n ?? 60);
  if (sheet.length === 0) {
    process.stderr.write('No substantive sessions to label (each needs ≥3 of your own turns).\n');
    process.exit(1);
  }
  const out = args.out ?? 'cc-audit-fluency-labels.json';
  writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`);
  process.stdout.write(
    `\nWrote ${sheet.length} sessions to ${out}.\n` +
      '  For each row, READ "promptTrajectory" (the prompts you typed to drive the\n' +
      '  agent) and set "trueBand" to one of: Poor | Developing | Strong | Elite —\n' +
      '  your holistic call on how fluently you drove it. (Leave null to skip.)\n' +
      `  Then run:  cc-audit score-fluency ${out}\n`,
  );
}

function runScoreFluency(file: string): void {
  let rows: FluencyLabelRow[];
  try {
    rows = JSON.parse(readFileSync(file, 'utf8')) as FluencyLabelRow[];
  } catch (err) {
    process.stderr.write(`Could not read fluency sheet ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${renderBandSummary(summarizeBands(rows))}\n`);
}

/** QUESTION 1 (default Yes) — install the skill AND run the analysis now.
 *
 *  One yes does both, because they cover different moments and neither replaces the other:
 *
 *  - The SHELL-OUT is the answer to "right now". It runs `claude -p` (or `codex exec`) on
 *    a compacted summary and prints three plans in this terminal, this run. No session
 *    restart, no memorized phrase. That is the whole first-run experience.
 *  - The SKILL is the durable path and produces strictly better output, because it runs
 *    inside a session with their repo loaded and can cite the actual line in the actual
 *    CLAUDE.md. Installing it is a file write — zero friction, so it rides along free.
 *
 *  The cost is disclosed before we spend it. Invoking their agent consumes the same
 *  rate-limit window this report exists to explain; a tool that silently eats the thing it
 *  diagnoses has no business shipping. So the confirm states the agent, the token estimate,
 *  and whose subscription pays.
 *
 *  Degradation is NAMED, never silent (see the spec's tiering requirement): no agent on
 *  PATH, or an invocation that fails or times out, still leaves the deterministic report
 *  above intact — we say what did not happen and hand back the skill invocation. A partial
 *  run must never read as a complete one. */
async function offerAnalysis(
  interactive: boolean,
  aggregate: Record<string, unknown>,
): Promise<SharedAdvice | undefined> {
  if (!interactive) return undefined;
  const agent = detectAgent();
  const skillPending = !isSkillCurrent();
  if (!agent && !skillPending) return undefined; // nothing to offer

  if (!agent) {
    // No agent to run right now — the skill is still worth installing for next session.
    p.log.message(
      'No `claude` or `codex` on your PATH, so the analysis can\'t run here. The skill\n' +
        'still installs, and your agent can run it from inside any session.',
    );
    const ok = await p.confirm({ message: 'Install the analysis skill for next time?', initialValue: true });
    if (p.isCancel(ok) || ok !== true) return undefined;
    const r = installSkill();
    if (r.status === 'failed') p.log.warn(r.message);
    else {
      p.log.success(r.message);
      p.log.message(invocationHint());
    }
    return undefined;
  }

  const prompt = buildAnalysisPrompt(compactFindings(aggregate));
  const tokens = estimateTokens(prompt);
  p.log.message(
    `Runs the analysis on YOUR ${agent.bin} subscription — cc-audit never sends your\n` +
      'sessions to a model of ours. It also installs the skill so future sessions can\n' +
      'coach you with your repo loaded (better output than this cold run).\n' +
      '\n' +
      `  • Costs about ${tokens.toLocaleString()} input tokens of your own rate-limit window —\n` +
      '    the same window this report is about.\n' +
      '  • Sends a compacted summary of the numbers above. No tools, no code, no repo.\n' +
      '  • Inspect the exact prompt first with:  cc-audit --print-prompt',
  );
  const ok = await p.confirm({ message: `Run the analysis now with ${agent.bin} and install the skill?`, initialValue: true });
  if (p.isCancel(ok) || ok !== true) return undefined;

  // The skill install is instant and local; do it first so a failed agent run still
  // leaves them with the durable path.
  const installed = installSkill();
  if (installed.status === 'failed') p.log.warn(installed.message);

  const run = await withSpinner(`Analyzing with ${agent.bin}`, () => runAgentAnalysis(agent, prompt));
  if (!run.ok) {
    // Named degradation: say what failed, and that the report above still stands.
    p.log.warn(
      `${run.error}.\nThe measured report above is complete and unaffected — only the ` +
        `written plans are missing.\n\n${invocationHint()}`,
    );
    return undefined;
  }
  process.stdout.write(`\n${run.text}\n`);
  p.log.success(`Three plans, written by your own ${run.bin}.`);
  if (installed.status !== 'failed') p.log.message(invocationHint());
  // Returned so the shareable link can carry it. The parse is best-effort; `raw` always
  // survives, so a render never depends on the model having followed our format.
  return parseAdvice(run.bin, run.text ?? '');
}

/** QUESTION 2 of 2 (default Yes) — the shareable web report, AND the data-sharing opt-in.
 *
 *  One question, two effects, both disclosed above the confirm. They are bundled because
 *  the link is strictly the larger disclosure: it publishes the report to a URL anyone can
 *  open, which is more exposure than sharing the same numbers privately with us. Someone
 *  who accepts a public link is not being surprised by a private send. It does NOT work in
 *  the other direction, which is why there is no path that turns sharing on without this
 *  warning block having been printed first.
 *
 *  The disclosure names the advice separately from the aggregate, because they are NOT the
 *  same privacy tier. The aggregate is shares and counts. The advice quotes real dollar
 *  figures and real command/subagent names — strictly more. Rolling them into one
 *  reassuring sentence would be the kind of true-in-parts, false-overall copy this project
 *  exists to avoid.
 *
 *  Consent asymmetry, deliberate:
 *    • YES  → publish the link AND switch sharing on, persisted (sticky across runs).
 *    • NO   → publish nothing, and leave the stored sharing setting UNTOUCHED. Declining
 *             a public URL is not the same decision as declining to share, so a No here
 *             must not be recorded as an opt-out, and must not revoke a previous Yes.
 *             Only `cc-audit capture --off` turns sharing off.
 *    • --open (flag) → the flag consents to the LINK only. It never flips the sharing
 *             setting, because no human read this warning on that path. */
async function offerShareLink(
  args: Args,
  interactive: boolean,
  advice: SharedAdvice | undefined,
  gistCount: number,
): Promise<boolean> {
  if (args.open) return true; // the flag is the consent — for the link, and only the link
  if (!interactive) return false;
  p.log.warn(
    'A shareable report uploads to a link ANYONE WITH THE URL can open:\n' +
      '\n' +
      '  • The metrics report you just read, including your spend in dollars. No code.\n' +
      (advice
        ? `  • The three plans your ${advice.agent} just wrote. On top of the dollar figures,\n` +
          '    these name your commands, subagents, and skills — which the metrics above do\n' +
          '    not. Read them again before you say yes.\n'
        : '') +
      '\n' +
      'It cannot be un-published.\n' +
      '\n' +
      captureDisclosure(gistCount),
  );
  const ok = await p.confirm({ message: 'Create a shareable link?', initialValue: true });
  const yes = !p.isCancel(ok) && ok === true;
  applyShareLinkAnswer(yes); // only a yes writes — the asymmetry lives in capture.ts
  return yes;
}

/** What a consented right-sizing run needs to execute later (the call is deferred so
 *  it can fire in parallel with the hosted trim). */
interface RightSizeConsent {
  footprints: SessionFootprint[];
  hygieneItems: HygieneFootprint[];
}

/** Tier 1 — right-sizing. FLAG-ONLY now: `--judge` is the consent, and a bare run never
 *  prompts for it (the bare run's only questions are the skill + capture ones). Prompt
 *  removal did not weaken the disclosure — the receipt below still states exactly what
 *  is sent, and it now prints on BOTH paths because there is no interactive prompt left
 *  to carry it. No network here. */
async function rightSizeConsent(
  args: Args,
  interactive: boolean,
  sessions: ReturnType<typeof loadClaudeCodeSessions>,
  hygiene: ContextHygiene,
): Promise<RightSizeConsent | undefined> {
  if (!args.judge) return undefined;
  const footprints = buildFootprints(sessions);
  // Context-hygiene items ride in the SAME judge payload (one model pass) — they refine
  // the deterministic avoidable-carry headline by separating stale carry from
  // genuinely-needed big context.
  const hygieneItems = buildHygieneFootprints(hygiene, sessions);
  if (footprints.length === 0) {
    process.stdout.write('\n  (no premium prompt-driven sessions to right-size)\n');
    return undefined;
  }
  // The flag IS the consent, so this receipt is the ONLY disclosure of what leaves —
  // including that the call is retained and attributed by an install id (anonId). Route
  // the non-interactive copy to stderr so --json stdout stays pure.
  const receipt =
    `Right-sizing ${footprints.length} sessions via the hosted model (task gist + metadata, never code), ` +
    'retained + attributed by an anonymous install id to improve right-sizing and the benchmark' +
    (hygieneItems.length > 0 ? ` + refining ${hygieneItems.length} context-hygiene episodes (same call)` : '') +
    '…';
  if (interactive) p.log.message(receipt);
  else process.stderr.write(`${receipt}\n`);
  return { footprints, hygieneItems };
}

/** Render a completed judge call (right-sizing panel + optional hygiene refinement). */
function renderJudgeOutput(
  consent: RightSizeConsent,
  judged: RightSizingResult,
  args: Args,
  windowDays: number,
  premiumMonthlyUsd: number,
  hygiene: ContextHygiene,
): { result: RightSizingResult; hygieneRefinement?: HygieneRefinementUpload } {
  process.stdout.write(
    `${renderRightSizing(consent.footprints, judged, windowDays, premiumMonthlyUsd, args.aggressiveness)}\n`,
  );
  // If the backend scored the hygiene items, refine the avoidable-carry headline from
  // the deterministic estimate to what the judge confirmed was actually stale.
  let hygieneRefinement: HygieneRefinementUpload | undefined;
  if (judged.hygiene && judged.hygiene.length > 0) {
    const refined = refineAvoidableCarry(hygiene, consent.hygieneItems, judged.hygiene);
    process.stdout.write(`${renderHygieneRefinement(refined, windowDays)}\n`);
    hygieneRefinement = toRefinementUpload(refined, windowDays);
  }
  return { result: judged, hygieneRefinement };
}

/** Tier 2 — the shareable web report. Consent is either the `--open` flag or the
 *  interactive question (see offerShareLink); this function only performs an
 *  already-granted one. */
async function maybeShare(
  args: Args,
  interactive: boolean,
  want: boolean,
  aggregate: unknown,
  rightSizing: unknown,
  advice?: SharedAdvice,
  hygieneRefinement?: HygieneRefinementUpload,
): Promise<void> {
  if (!want) return;
  if (args.open && !interactive) {
    // Non-interactive --open: the flag is the consent, so this receipt is the only
    // disclosure that runs. It must name the advice, which carries raw $ and command names.
    process.stderr.write(
      'Uploading your aggregate metrics — no code, prompts, or paths — to create a PUBLIC ' +
        'shareable link…' +
        (advice
          ? `\nIncluding the plans your ${advice.agent} wrote, which quote your real dollar ` +
            'figures and command names.'
          : '') +
        '\n',
    );
  }
  try {
    const post = () => postReport({ aggregate, rightSizing, hygieneRefinement, advice, anonId: machineAnonId() });
    const { url, benchmark, fluency } = interactive ? await withSpinner('Creating shareable report', post) : await post();
    // The gated readout rides on the --open response (no extra egress): a calibrated
    // BAND always, the cohort percentile once the corpus is large enough, plus the
    // single highest-leverage next step. Falls back to the legacy percentile line.
    const emit = (s: string) => (interactive ? p.log.success(s) : process.stdout.write(`\n  ${s}\n`));
    if (fluency?.band) {
      const scoreLabel = fluency.score !== null ? `${fluency.score}/100 (${fluency.band})` : fluency.band;
      if (fluency.percentile !== null) {
        // Percentile-primary once the cohort is big enough to rank against.
        emit(
          `You're in the ${ordinal(fluency.percentile)} percentile of ` +
            `${fluency.cohortSize.toLocaleString()} engineers measured.`,
        );
        emit(`Fluency: ${scoreLabel}.`);
      } else {
        // Cold-start: lead with the score+band; ranking is the growth hook.
        emit(`Fluency: ${scoreLabel}.`);
        const toGo = Math.max(0, 30 - fluency.cohortSize);
        emit(`Percentile ranking unlocks at 30 engineers measured — ${toGo} to go.`);
      }
      if (fluency.whatMovesYouUp) emit(`What moves you up: ${fluency.whatMovesYouUp}`);
    } else if (benchmark) {
      emit(
        `You're in the ${ordinal(benchmark.fluencyPercentile)} percentile of ` +
          `${benchmark.cohortSize.toLocaleString()} engineers measured.`,
      );
    }
    if (interactive) p.log.success(`Shareable report: ${url}`);
    else process.stdout.write(`\n  Shareable report: ${url}\n`);
    openURL(url);
  } catch (err) {
    const msg = `could not create shareable report: ${err instanceof Error ? err.message : String(err)}`;
    if (interactive) p.log.error(msg);
    else process.stderr.write(`${msg}\n`);
  }
}

/** `cc-audit skill [--print]` — install the embedded analysis skill, or show its text. */
function runSkillCmd(argv: string[]): void {
  if (argv.includes('--print')) {
    process.stdout.write(SKILL_MARKDOWN);
    return;
  }
  const r = installSkill();
  const out = r.status === 'failed' ? process.stderr : process.stdout;
  out.write(`${r.message}\n`);
  if (r.status === 'failed') process.exit(1);
  process.stdout.write(`\n${invocationHint()}\n`);
}

/** `cc-audit capture [--on|--off|--status]` — the one-command opt-out (and back in).
 *  Immediate, persisted to ~/.cc-audit/consent.json, and survives upgrades. */
function runCaptureCmd(argv: string[]): void {
  if (argv.includes('--off')) {
    setCapture(false);
    process.stdout.write('Capture OFF. Nothing will be sent, and you will not be asked again.\n');
    return;
  }
  if (argv.includes('--on')) {
    setCapture(true);
    process.stdout.write(captureStatus());
    return;
  }
  process.stdout.write(captureStatus());
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (sub === 'label') {
    await runLabel(parseArgs(argv.slice(1)));
    return;
  }
  if (sub === 'score') {
    const file = argv[1];
    if (!file || file.startsWith('-')) {
      process.stderr.write('Usage: cc-audit score <labels.json>\n');
      process.exit(1);
    }
    runScore(file);
    return;
  }
  if (sub === 'label-fluency') {
    await runLabelFluency(parseArgs(argv.slice(1)));
    return;
  }
  if (sub === 'score-fluency') {
    const file = argv[1];
    if (!file || file.startsWith('-')) {
      process.stderr.write('Usage: cc-audit score-fluency <fluency-labels.json>\n');
      process.exit(1);
    }
    runScoreFluency(file);
    return;
  }
  if (sub === 'fix') {
    await runFixCmd(parseArgs(argv.slice(1)));
    return;
  }
  if (sub === 'skill') {
    runSkillCmd(argv.slice(1));
    return;
  }
  if (sub === 'capture') {
    runCaptureCmd(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  const interactive = isInteractive(args.json);
  await ensureLocalReadConsent(interactive);
  const sessions = interactive
    ? await withSpinner('Scanning ~/.claude transcripts', () => loadSessionsOrExit(args, interactive))
    : loadSessionsOrExit(args, interactive);

  const result = runAudit(sessions, new Date().toISOString(), { shareSessions: args.shareSessions });

  // Run history (LOCAL, best-effort, silent — --json stdout purity holds by construction).
  // An alternate --root corpus would pollute the ~/.cc-audit timeline, so history is off there.
  const historyOn = !args.root;
  const key = windowKey(args.sinceDays);
  const today = new Date().toISOString().slice(0, 10);
  const baseline = historyOn ? readBaseline(key, today) : undefined;
  if (historyOn) writeSnapshot(result.aggregate, key, today);

  // Capture rides on an answer already given — it NEVER prompts here. An alternate
  // --root corpus is excluded from TRANSMISSION for the same reason history is (it
  // would pollute the timeline, and in the fixture case the corpus too); the gists are
  // still built so the disclosure can state a truthful count.
  const captureGists = () => buildFootprints(sessions);
  const mayTransmit = !args.root;

  // Inspectable instructions: print the EXACT prompt that would be sent to their agent
  // and invoke nothing. Required by the spec, and it is the cheapest way for a
  // security-minded developer to satisfy themselves before ever saying yes.
  if (args.printPrompt) {
    const prompt = buildAnalysisPrompt(compactFindings(result.aggregate as unknown as Record<string, unknown>));
    process.stdout.write(`${prompt}\n`);
    process.stderr.write(`\n(~${estimateTokens(prompt).toLocaleString()} input tokens. Nothing was sent.)\n`);
    return;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.aggregate, null, 2)}\n`);
    // The skill's own path is `cc-audit --json`, so this is the hot capture route.
    // Awaited but silent and best-effort: stdout purity holds by construction (sendCapture
    // writes nothing, ever) and a failure can't fail the run.
    if (mayTransmit) await sendCapture(result.aggregate, captureGists());
    return;
  }
  const delta = baseline ? computeDelta(baseline, result.aggregate) : historyOn ? ('first-run' as const) : undefined;
  process.stdout.write(`${renderReport(result, { rows: args.rows, delta })}\n`);

  // Right-sizing is flag-only now (--judge); the bare run's only questions are the two
  // at the bottom of this function.
  const consent = await rightSizeConsent(args, interactive, sessions, result.contextHygiene);

  const premiumMonthlyUsd = result.spend.byModel
    .filter((m) => isPremiumModel(m.model))
    .reduce((n, m) => n + (m.costUsd / result.spend.windowDays) * 30.44, 0);

  let judgeOut: { result: RightSizingResult; hygieneRefinement?: HygieneRefinementUpload } | undefined;
  if (consent) {
    const api = process.env.CC_AUDIT_API ?? undefined;
    // strip the local-only avoidableUsd before sending; anonId lets the backend
    // persist + attribute the judge call (benchmark cohort / dedup), never a path
    const call = () => judgeFootprints(consent.footprints, api, consent.hygieneItems.map((h) => h.item), machineAnonId());
    const label = `Right-sizing ${consent.footprints.length} sessions`;
    try {
      const judged = interactive ? await withSpinner(label, call) : await call();
      if (judged) {
        judgeOut = renderJudgeOutput(consent, judged, args, result.spend.windowDays, premiumMonthlyUsd, result.contextHygiene);
      }
    } catch (err) {
      const msg = `right-sizing failed: ${err instanceof Error ? err.message : String(err)}`;
      if (interactive) p.log.error(msg);
      else process.stderr.write(`${msg}\n`);
    }
  }
  // ── The two questions, both default Yes, both below the whole report so the developer
  // has seen what the tool is worth before either of them. Order is load-bearing: the
  // analysis must run first because its output is what makes the shareable link worth
  // creating, and the link's disclosure has to name what the analysis actually produced.
  const gists = captureGists();
  const advice = await offerAnalysis(interactive, result.aggregate as unknown as Record<string, unknown>);
  const wantLink = await offerShareLink(args, interactive, advice, gists.length);
  await maybeShare(
    args,
    interactive,
    wantLink,
    result.aggregate,
    judgeOut?.result.summary,
    advice,
    judgeOut?.hygieneRefinement,
  );
  // Sharing is not a third question: it rides on the answer above (or on a setting from a
  // previous run / `cc-audit capture --on`). sendCapture re-checks this itself — the guard
  // is duplicated here only to skip the spinner when there is nothing to send.
  const share = captureSetting() === true && mayTransmit;
  if (share) {
    const sent = interactive ? await withSpinner('Sharing with Promptster', () => sendCapture(result.aggregate, gists)) : await sendCapture(result.aggregate, gists);
    // Only ever a note. A failed send is not the developer's problem and must not read
    // as an error in their report — the next run will carry the data.
    if (interactive && sent) p.log.success('Shared — thank you. Turn it off any time with: cc-audit capture --off');
  }
  if (interactive) p.outro('Done.');
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === '--version' || sub === '-v' || sub === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  // The live-guardrail statusline (and its detached cache-refresh sidecar) must be FAST and
  // strictly local — bypass the network update check entirely and return before run().
  if (sub === 'statusline') {
    runStatusline(process.argv.slice(3));
    return;
  }
  if (sub === '__refresh-knee') {
    // Internal: the detached sidecar spawnKneeRefresh() launches. Rebuild the knee cache and
    // exit. Not user-facing — no output, never throws.
    const rootIdx = process.argv.indexOf('--root');
    computeAndWriteKneeCache({ root: rootIdx >= 0 ? process.argv[rootIdx + 1] : undefined });
    return;
  }
  // Kick the update check off up front so its (cached, short-timeout) fetch
  // overlaps the audit; we only await the already-running promise at the end.
  // Routed to stderr so it never corrupts --json on stdout. Never throws.
  const updatePromise = checkForUpdate(VERSION).catch(() => undefined);
  try {
    await run();
  } finally {
    const notice = await updatePromise;
    if (notice) process.stderr.write(`\n${renderUpdateNotice(notice)}\n`);
  }
}

void main();
