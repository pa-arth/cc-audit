#!/usr/bin/env node
// cc-audit — point it at your Claude Code transcripts and see where the money
// and the bad habits are. Local-only by default (no network, no key): parse +
// attribute + report. A bare interactive run then walks the value ladder —
// hosted right-sizing, then a shareable report — each behind a consent gate
// proportional to what leaves the machine (see consent.ts). `--json` and any
// non-TTY run stay strictly non-interactive: only explicit --judge/--open send
// anything, so CI and the audit skills are unaffected.
//
// Subcommands:
//   cc-audit                  full local report, then interactive right-size + share
//   cc-audit label [--out F]  judge real sessions → a sheet you hand-label (calibration)
//   cc-audit score <F>        score your filled sheet vs the judge (the USEFUL gate)
//   cc-audit fix              turn recommendations into reviewable patches

import { readFileSync, writeFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { loadClaudeCodeSessions } from './adapters/claudeCode.js';
import { runAudit } from './audit.js';
import { readConsent, writeConsent } from './consent.js';
import { buildFootprints } from './footprint.js';
import { judgeFootprints, postReport, type RightSizingResult } from './judgeClient.js';
import { buildLabelSheet, renderScore, scoreLabels, type LabelRow } from './label.js';
import { renderFix, runFix } from './fix.js';
import { machineAnonId, openURL } from './open.js';
import { isPremiumModel } from './pricing.js';
import { type Aggressiveness, renderReport, renderRightSizing } from './report.js';

interface Args {
  root?: string;
  sinceDays?: number;
  json: boolean;
  judge: boolean;
  open: boolean;
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
  const args: Args = { json: false, judge: false, open: false, aggressiveness: 'balanced' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
    else if (a === '--judge') args.judge = true;
    else if (a === '--open') args.open = true;
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
          '          [--aggressiveness conservative|balanced|aggressive]\n' +
          '      Analyze ~/.claude transcripts locally. In a terminal, a bare run then\n' +
          '      offers right-sizing and a shareable report — each asks first.\n' +
          '      --json prints the aggregate record (always local-only, no prompts).\n' +
          '      --judge calls the hosted right-sizing model (task gist + metadata, never code).\n' +
          '      --open uploads the privacy-safe aggregate and opens a shareable web report.\n' +
          '      Passing --judge/--open skips the prompt — the flag is the consent.\n' +
          '      --aggressiveness gates which over-modeled tasks are recommended as cuts (default balanced).\n' +
          '  cc-audit label [--n 50] [--out labels.json] [--since-days N] [--root DIR]\n' +
          '      Judge real sessions and write a sheet to hand-label (set trueMinTier per row).\n' +
          '  cc-audit score <labels.json>\n' +
          '      Score your filled sheet vs the judge: precision (gate ≥90%), recall, confusion.\n' +
          '  cc-audit fix [--since-days N] [--root DIR]\n' +
          '      Turn recommendations into REVIEWABLE patches under ./.cc-audit/ (never applied):\n' +
          '      local model-pin edits + a hosted CLAUDE.md trim (spends credits, daily-capped).\n',
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
  const result = runAudit(sessions, new Date().toISOString());
  const hasTrim = result.recommendations.some((r) => r.kind === 'trim-config' && r.file);
  if (hasTrim) {
    process.stderr.write('Generating a CLAUDE.md trim via the hosted config-review (spends credits, daily-capped)…\n');
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const proposals = await runFix(result.recommendations, today);
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

/** Tier 1 — right-sizing. Runs on an explicit --judge (flag is consent) or, in an
 *  interactive run, after a default-Yes confirm. Returns the verdicts (or undefined). */
async function maybeRightSize(
  args: Args,
  interactive: boolean,
  sessions: ReturnType<typeof loadClaudeCodeSessions>,
  windowDays: number,
  premiumMonthlyUsd: number,
): Promise<RightSizingResult | undefined> {
  const footprints = buildFootprints(sessions);
  let want = args.judge;
  if (!want && interactive && footprints.length > 0) {
    p.log.message(
      "Right-sizing sends each task's gist + metadata (model, tokens, turn shape)\n" +
        'to our hosted model — never your code, prompts, or paths.',
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
      `Right-sizing ${footprints.length} sessions via the hosted model (task gist + metadata, never code)…\n`,
    );
  }
  try {
    const judged = interactive
      ? await withSpinner(`Right-sizing ${footprints.length} sessions`, () => judgeFootprints(footprints))
      : await judgeFootprints(footprints);
    process.stdout.write(
      `${renderRightSizing(footprints, judged, windowDays, premiumMonthlyUsd, args.aggressiveness)}\n`,
    );
    return judged;
  } catch (err) {
    const msg = `right-sizing failed: ${err instanceof Error ? err.message : String(err)}`;
    if (interactive) p.log.error(msg);
    else process.stderr.write(`${msg}\n`);
    return undefined;
  }
}

/** Tier 2 — public shareable report. Explicit --open (flag is consent) or, in an
 *  interactive run, a default-No confirm (the report is public). */
async function maybeShare(
  args: Args,
  interactive: boolean,
  aggregate: unknown,
  rightSizing: unknown,
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
    const post = () => postReport({ aggregate, rightSizing, anonId: machineAnonId() });
    const { url, benchmark, fluency } = interactive ? await withSpinner('Creating shareable report', post) : await post();
    // The gated readout rides on the --open response (no extra egress): a calibrated
    // BAND always, the cohort percentile once the corpus is large enough, plus the
    // single highest-leverage next step. Falls back to the legacy percentile line.
    const emit = (s: string) => (interactive ? p.log.success(s) : process.stdout.write(`\n  ${s}\n`));
    if (fluency?.band) {
      emit(`Fluency band: ${fluency.band}.`);
      if (fluency.percentile !== null) {
        emit(
          `You're in the ${ordinal(fluency.percentile)} percentile of ` +
            `${fluency.cohortSize.toLocaleString()} engineers measured.`,
        );
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

async function main(): Promise<void> {
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

  const result = runAudit(sessions, new Date().toISOString());
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.aggregate, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderReport(result, { rows: args.rows })}\n`);

  const premiumMonthlyUsd = result.spend.byModel
    .filter((m) => isPremiumModel(m.model))
    .reduce((n, m) => n + (m.costUsd / result.spend.windowDays) * 30.44, 0);
  const judged = await maybeRightSize(args, interactive, sessions, result.spend.windowDays, premiumMonthlyUsd);
  await maybeShare(args, interactive, result.aggregate, judged?.summary);
}

void main();
