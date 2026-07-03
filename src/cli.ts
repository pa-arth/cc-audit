#!/usr/bin/env node
// cc-audit — point it at your Claude Code transcripts and see where the money
// and the bad habits are. Local-only by default (no network, no key): parse +
// attribute + report. A bare interactive run then walks the value ladder —
// local config edits (the headline lever), hosted right-sizing, then a shareable
// report — each behind a consent gate proportional to what leaves the machine
// (see consent.ts). `--json` and any non-TTY run stay strictly non-interactive:
// only explicit --judge/--open send anything, so CI and the audit skills are
// unaffected.
//
// Subcommands:
//   cc-audit                  full local report, then config edits + right-size + share
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
import { installStatusline, isOfferable } from './statuslineInstall.js';
import { runAudit, type AuditResult } from './audit.js';
import { renderConfigSuggestions } from './configSuggestions.js';
import { readConsent, writeConsent } from './consent.js';
import type { ContextHygiene } from './contextHygiene.js';
import { buildFootprints, type SessionFootprint } from './footprint.js';
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
import { buildConfigTrimProposal, buildModelPinProposals, isHostedTrimCandidate, renderFix, runFix } from './fix.js';
import { DAILY_CAP, spendToday } from './fixClient.js';
import { computeDelta, readBaseline, windowKey, writeSnapshot } from './history.js';
import { getInstallKey } from './installKey.js';
import type { Recommendation } from './recommend.js';
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
  const args: Args = { json: false, judge: false, open: false, shareSessions: false, aggressiveness: 'balanced' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
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
          '      Analyze ~/.claude transcripts locally. In a terminal, a bare run then\n' +
          '      offers exact config edits (local), right-sizing, and a shareable\n' +
          '      report — each asks first.\n' +
          '      The TOP SPENDERS leaderboard (with your prompt gists) is always LOCAL-only.\n' +
          '      --json prints the aggregate record (always local-only, no prompts).\n' +
          '      --judge calls the hosted right-sizing model (task gist + metadata, never code).\n' +
          '      --open uploads the privacy-safe aggregate and opens a shareable web report.\n' +
          '      --share-sessions adds an ANONYMIZED leaderboard (cost share, turns, model,\n' +
          '          plan-mode, trajectory — never gists, projects, or $) to the shared report.\n' +
          '      Passing --judge/--open skips the prompt — the flag is the consent.\n' +
          '      --aggressiveness gates which over-modeled tasks are recommended as cuts (default balanced).\n' +
          '  cc-audit label [--n 50] [--out labels.json] [--since-days N] [--root DIR]\n' +
          '      Judge real sessions and write a sheet to hand-label (set trueMinTier per row).\n' +
          '  cc-audit score <labels.json>\n' +
          '      Score your filled sheet vs the judge: precision (gate ≥90%), recall, confusion.\n' +
          '  cc-audit fix [--since-days N] [--root DIR]\n' +
          '      Turn recommendations into REVIEWABLE patches under ./.cc-audit/ (never applied):\n' +
          '      local model-pin edits + a hosted CLAUDE.md trim (spends credits; usage-capped per install).\n' +
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
      'spend and model fit.',
      '',
      '• Nothing leaves this machine unless you say so below.',
      '• We never read your code, prompts, file paths, or repo names.',
      '• A random anonymous machine ID (a hash, not your hostname) is created',
      '  for dedup only if you later share a report.',
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

/** Tier 0.5 — local config suggestions, the FIRST offer: exact cut/change edits derived
 *  from the audit above. Zero egress, so the confirm defaults Yes (it sits BELOW the
 *  judge confirm on the consent ladder). The optional hosted CLAUDE.md rewrite is a
 *  SEPARATE default-No confirm — it sends the file's FULL CONTENT, more than --judge
 *  sends. The consented rec is RETURNED, not executed, so the network call can run in
 *  parallel with right-sizing. */
async function maybeConfigSuggestions(interactive: boolean, result: AuditResult): Promise<Recommendation | null> {
  if (!interactive || result.configSuggestions.length === 0) return null;
  const n = result.configSuggestions.length;
  p.log.message(
    'Config suggestions are computed locally from the audit above —\n' +
      'nothing leaves this machine, nothing is applied.',
  );
  const ok = await p.confirm({
    message: `Show ${n} exact config edit${n === 1 ? '' : 's'} (cut dead weight, quote never-followed rules) and write .cc-audit/*.proposed patches for reviewable diffs?`,
    initialValue: true,
  });
  if (p.isCancel(ok) || ok !== true) return null;
  // Model-pin patches are local file proposals — written only after the consent above,
  // matching `cc-audit fix` semantics (./.cc-audit/*.proposed, nothing applied).
  const pins = buildModelPinProposals(result.recommendations);
  process.stdout.write(renderConfigSuggestions(result.configSuggestions, pins));

  const trim = result.recommendations.find(isHostedTrimCandidate);
  if (!trim) return null;
  p.log.warn(
    "A hosted trim sends that CLAUDE.md's FULL CONTENT to our config-review service —\n" +
      'more than --judge sends — and spends credits (daily-capped).',
  );
  const wantTrim = await p.confirm({ message: `Request a hosted rewrite of ${trim.file}?`, initialValue: false });
  return !p.isCancel(wantTrim) && wantTrim === true ? trim : null;
}

/** What a consented right-sizing run needs to execute later (the call is deferred so
 *  it can fire in parallel with the hosted trim). */
interface RightSizeConsent {
  footprints: SessionFootprint[];
  hygieneItems: HygieneFootprint[];
}

/** Tier 1 consent — right-sizing. Explicit --judge (flag is consent) or, in an
 *  interactive run, a default-Yes confirm. Prompt/receipt only — no network here. */
async function rightSizeConsent(
  args: Args,
  interactive: boolean,
  sessions: ReturnType<typeof loadClaudeCodeSessions>,
  hygiene: ContextHygiene,
): Promise<RightSizeConsent | undefined> {
  const footprints = buildFootprints(sessions);
  // Context-hygiene items ride in the SAME judge payload (one model pass) — they refine
  // the deterministic avoidable-carry headline by separating stale carry from
  // genuinely-needed big context.
  const hygieneItems = buildHygieneFootprints(hygiene, sessions);
  let want = args.judge;
  if (!want && interactive && footprints.length > 0) {
    p.log.message(
      "Right-sizing sends each task's gist + metadata (model, tokens, turn shape)\n" +
        'to our hosted model — never your code, prompts, or paths.' +
        (hygieneItems.length > 0
          ? `\nThe same call also refines your context-hygiene estimate from ${hygieneItems.length} episodes' task gists (no extra call).`
          : ''),
    );
    const ok = await p.confirm({ message: `Right-size ${footprints.length} sessions?`, initialValue: true });
    want = !p.isCancel(ok) && ok === true;
  }
  if (!want) return undefined;
  if (footprints.length === 0) {
    process.stdout.write('\n  (no premium prompt-driven sessions to right-size)\n');
    return undefined;
  }
  // Explicit flag in a non-interactive run: print the receipt of what's being sent.
  if (args.judge && !interactive) {
    process.stderr.write(
      `Right-sizing ${footprints.length} sessions via the hosted model (task gist + metadata, never code)` +
        (hygieneItems.length > 0 ? ` + refining ${hygieneItems.length} context-hygiene episodes (same call)` : '') +
        '…\n',
    );
  }
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

/** Tier 2 — public shareable report. Explicit --open (flag is consent) or, in an
 *  interactive run, a default-No confirm (the report is public). */
async function maybeShare(
  args: Args,
  interactive: boolean,
  aggregate: unknown,
  rightSizing: unknown,
  hygieneRefinement?: HygieneRefinementUpload,
): Promise<void> {
  let want = args.open;
  if (!want && interactive) {
    p.log.warn(
      'A shareable report uploads the privacy-safe AGGREGATE (shares and counts —\n' +
        'never raw $ amounts or code) to a PUBLIC link anyone with the URL can open.',
    );
    const ok = await p.confirm({ message: 'Create a public shareable report?', initialValue: false });
    want = !p.isCancel(ok) && ok === true;
  }
  if (!want) {
    if (interactive) p.outro('Done — nothing was uploaded.');
    return;
  }
  if (args.open && !interactive) {
    process.stderr.write(
      'Uploading your aggregate metrics — no code, prompts, or paths — to create a shareable link…\n',
    );
  }
  try {
    const post = () => postReport({ aggregate, rightSizing, hygieneRefinement, anonId: machineAnonId() });
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
    if (interactive) p.outro(`Shareable report: ${url}`);
    else process.stdout.write(`\n  Shareable report: ${url}\n`);
    openURL(url);
  } catch (err) {
    const msg = `could not create shareable report: ${err instanceof Error ? err.message : String(err)}`;
    if (interactive) p.log.error(msg);
    else process.stderr.write(`${msg}\n`);
  }
}

/** Interactive offer to wire the live-guardrail statusline into claude-hud. Fits the consent
 *  ladder: default-Yes (it's a local settings edit, nothing leaves the machine), but STRICTLY
 *  interactive — a --json or non-TTY run never reaches here, so settings.json is only ever
 *  modified by an explicit --install/--uninstall or a real "yes". */
async function maybeOfferHudInstall(interactive: boolean): Promise<void> {
  if (!interactive) return;
  if (!isOfferable()) return; // no claude-hud, already installed, foreign extra-cmd, or JSONC
  const ok = await p.confirm({ message: 'Add the context-guardrail line to your claude-hud HUD?', initialValue: true });
  if (p.isCancel(ok) || ok !== true) return;
  const r = installStatusline();
  if (r.ok) p.log.success(r.message);
  else p.log.warn(r.message);
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

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.aggregate, null, 2)}\n`);
    return;
  }
  const delta = baseline ? computeDelta(baseline, result.aggregate) : historyOn ? ('first-run' as const) : undefined;
  process.stdout.write(`${renderReport(result, { rows: args.rows, delta })}\n`);

  // Offer ladder: config suggestions (local, first) → right-sizing → share. Both
  // consents are collected up front so the two consented NETWORK calls (judge +
  // hosted trim) fire concurrently — one round-trip of waiting, not two. The trim
  // request body stays files-only (see fixClient.ts); parallelism changes
  // scheduling, never payloads.
  const trimRec = await maybeConfigSuggestions(interactive, result);
  const consent = await rightSizeConsent(args, interactive, sessions, result.contextHygiene);

  // Offer to auto-wire the live-guardrail statusline into claude-hud (local settings edit,
  // no egress). Interactive-only + gated on a clean, hud-shaped, not-yet-installed config —
  // a --json/non-TTY run never prompts or touches settings.json.
  await maybeOfferHudInstall(interactive);

  const premiumMonthlyUsd = result.spend.byModel
    .filter((m) => isPremiumModel(m.model))
    .reduce((n, m) => n + (m.costUsd / result.spend.windowDays) * 30.44, 0);

  let judgeOut: { result: RightSizingResult; hygieneRefinement?: HygieneRefinementUpload } | undefined;
  if (consent || trimRec) {
    const api = process.env.CC_AUDIT_API ?? undefined;
    const today = new Date().toISOString().slice(0, 10);
    const settle = () =>
      Promise.allSettled([
        consent
          ? // strip the local-only avoidableUsd before sending
            judgeFootprints(consent.footprints, api, consent.hygieneItems.map((h) => h.item))
          : Promise.resolve(undefined),
        trimRec ? buildConfigTrimProposal(trimRec, today, api) : Promise.resolve(null),
      ] as const);
    const label = [
      consent ? `Right-sizing ${consent.footprints.length} sessions` : null,
      trimRec ? 'rewriting CLAUDE.md' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    const [judgeSettled, trimSettled] = interactive ? await withSpinner(label, settle) : await settle();

    // Right-sizing renders first; a failure in one call never discards the other.
    if (consent) {
      if (judgeSettled.status === 'fulfilled' && judgeSettled.value) {
        judgeOut = renderJudgeOutput(consent, judgeSettled.value, args, result.spend.windowDays, premiumMonthlyUsd, result.contextHygiene);
      } else if (judgeSettled.status === 'rejected') {
        const err: unknown = judgeSettled.reason;
        const msg = `right-sizing failed: ${err instanceof Error ? err.message : String(err)}`;
        if (interactive) p.log.error(msg);
        else process.stderr.write(`${msg}\n`);
      }
    }
    // buildConfigTrimProposal never throws (failures come back as a "(skipped)" row).
    if (trimRec && trimSettled.status === 'fulfilled' && trimSettled.value) {
      process.stdout.write(renderFix([trimSettled.value]));
    }
  }
  await maybeShare(args, interactive, result.aggregate, judgeOut?.result.summary, judgeOut?.hygieneRefinement);
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
