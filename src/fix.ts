// `cc-audit fix` — turn recommendations into REVIEWABLE patches. Never touches a
// real file: every proposed change is written to ./.cc-audit/<name>.proposed and
// summarized with the projected $/mo + a safety verdict. The developer reviews the
// diff and applies it themselves. Two patch sources:
//   - model-pin: a purely LOCAL one-line frontmatter edit (no network, no spend).
//   - config-trim: the hosted config-review rewrite engine (spends credits; capped).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  buildGuardScript,
  buildSettingsProposal,
  existingStatusLineCommand,
  GUARD_SCRIPT_NAME,
  readUserSettings,
} from './contextGuard.js';
import { requestConfigRewrite } from './fixClient.js';
import { getInstallKey } from './installKey.js';
import type { Recommendation } from './recommend.js';
import { BOX_WIDTH, c, panel, wrap } from './theme.js';

export interface FixProposal {
  kind: 'model-pin' | 'config-trim' | 'context-guardrail';
  title: string;
  /** The real file the change targets (never written to). */
  realFile: string;
  /** Where the proposed version was written for review. */
  proposalFile: string;
  monthlyUsdSaved: number;
  /** false ⇒ the rewrite dropped a load-bearing instruction — present as a caution only. */
  safe: boolean;
  caution: string | null;
  summary: string;
  /** Companion artifact (the guardrail script) with its install destination. */
  companion?: { artifact: string; installTo: string };
  /** The real file doesn't exist yet — review the proposal directly, no diff to show. */
  realFileMissing?: boolean;
}

const PROPOSAL_DIR = '.cc-audit';

/**
 * Add `model: <tier>` to a SKILL.md's YAML frontmatter. Pure. Returns the patched
 * content, or null if the file already pins a model (nothing to do) or has no
 * frontmatter fence to edit.
 */
export function frontmatterModelPatch(content: string, tier = 'sonnet'): string | null {
  if (/^model:\s*\S+/m.test(content)) return null; // already pinned
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null; // no frontmatter fence — don't guess
  const close = lines.indexOf('---', 1);
  if (close < 1) return null; // unterminated frontmatter
  // Insert right after the opening fence so it's unambiguously in the frontmatter.
  lines.splice(1, 0, `model: ${tier}`);
  return lines.join('\n');
}

function proposalNameFor(realFile: string): string {
  // <parentdir>__<basename>.proposed — disambiguates same-named files (many SKILL.md).
  return `${basename(dirname(realFile))}__${basename(realFile)}.proposed`;
}

function writeProposal(realFile: string, content: string): string {
  mkdirSync(PROPOSAL_DIR, { recursive: true });
  const out = join(PROPOSAL_DIR, proposalNameFor(realFile));
  writeFileSync(out, content);
  return out;
}

/** The hosted config-review only ever reviews a project CLAUDE.md. Other trim-config
 *  recs (dead-weight SKILL.md, plugin/MCP rows with no file) are local advice — their
 *  content must NOT be sent to the rewrite endpoint or burn daily-cap slots. */
export function isHostedTrimCandidate(rec: Recommendation): boolean {
  return rec.kind === 'trim-config' && !!rec.file && basename(rec.file) === 'CLAUDE.md' && existsSync(rec.file);
}

/** Local model-pin patches — pure file edits, no network, no spend. */
export function buildModelPinProposals(recommendations: Recommendation[]): FixProposal[] {
  const proposals: FixProposal[] = [];
  for (const rec of recommendations) {
    if (rec.kind !== 'model-pin' || !rec.file || !existsSync(rec.file)) continue;
    const patched = frontmatterModelPatch(readFileSync(rec.file, 'utf8'));
    if (!patched) continue; // already pinned / no editable frontmatter
    const proposalFile = writeProposal(rec.file, patched);
    proposals.push({
      kind: 'model-pin',
      title: rec.title,
      realFile: rec.file,
      proposalFile,
      monthlyUsdSaved: rec.monthlyUsdSaved,
      safe: true,
      caution: null,
      summary: '+ model: sonnet  (frontmatter)',
    });
  }
  return proposals;
}

/** The hosted CLAUDE.md rewrite — the only network/spend step. A failure (offline,
 *  cap hit, timeout) is returned as a `(skipped)` proposal, never thrown, so callers
 *  can't lose their local patches to it. Caller gates via isHostedTrimCandidate. */
export async function buildConfigTrimProposal(
  rec: Recommendation,
  today: string,
  apiBase?: string,
  installKey?: string,
): Promise<FixProposal | null> {
  let rewrite;
  try {
    // Read inside the try: a filesystem error (perms, file removed after the
    // isHostedTrimCandidate check, symlink loop) must surface as a (skipped) proposal,
    // not throw out of the function — the Promise.allSettled caller never inspects rejections.
    const content = readFileSync(rec.file!, 'utf8');
    // Resolve the install key at the actual send site — this function is only reached
    // for a real hosted-trim candidate, so the key is generated/persisted only on egress.
    rewrite = await requestConfigRewrite(
      [{ path: 'CLAUDE.md', content }],
      today,
      apiBase,
      undefined,
      installKey ?? getInstallKey(),
    );
  } catch (err) {
    return {
      kind: 'config-trim',
      title: rec.title,
      realFile: rec.file!,
      proposalFile: '(skipped)',
      monthlyUsdSaved: 0,
      safe: true,
      caution: `rewrite unavailable: ${err instanceof Error ? err.message : String(err)}`,
      summary: 'config-review did not run',
    };
  }
  if (!rewrite) return null; // engine produced no rewrite
  const proposalFile = writeProposal(rec.file!, rewrite.after);
  const saved = -rewrite.projectedMonthlyUsdDelta; // delta is after-before (negative = saving)
  // safety may be absent (older artifact / skipped cross-check) — treat missing
  // as UNVERIFIED so we never present an unchecked rewrite as safe.
  const safety = rewrite.safety;
  const safe = safety?.verified === true;
  return {
    kind: 'config-trim',
    title: rec.title,
    realFile: rec.file!,
    proposalFile,
    monthlyUsdSaved: saved > 0 ? saved : 0,
    safe,
    caution: safe
      ? null
      : `may drop: ${safety?.droppedImperatives?.slice(0, 5).join(', ') || safety?.warnings?.[0] || 'safety not reported'}`,
    summary: `${rewrite.beforeAlwaysOnTokens.toLocaleString()} → ${rewrite.afterAlwaysOnTokens.toLocaleString()} tok`,
  };
}

/** Build reviewable patches from the recommendations that have a concrete file edit. */
export async function runFix(
  recommendations: Recommendation[],
  today: string,
  opts: { apiBase?: string; installKey?: string } = {},
): Promise<FixProposal[]> {
  const proposals: FixProposal[] = buildModelPinProposals(recommendations);
  for (const rec of recommendations) {
    // Guardrail first — its target (~/.claude/settings.json) may not exist yet, so it
    // must not fall through the isHostedTrimCandidate gate below. Pure local: no network, no cap.
    if (rec.kind === 'context-guardrail') {
      const settings = readUserSettings();
      const existing = existingStatusLineCommand(settings.parsed);
      const installTo = join(homedir(), '.claude', GUARD_SCRIPT_NAME);
      const script = buildGuardScript({ existingCommand: existing, monthlyUsd: rec.monthlyUsdSaved });
      mkdirSync(PROPOSAL_DIR, { recursive: true });
      const artifact = join(PROPOSAL_DIR, GUARD_SCRIPT_NAME);
      writeFileSync(artifact, script, { mode: 0o755 });
      const corrupt = settings.raw !== null && settings.parsed === null;
      const proposalFile = writeProposal(settings.path, buildSettingsProposal(settings.parsed, installTo));
      proposals.push({
        kind: 'context-guardrail',
        title: rec.title,
        realFile: settings.path,
        proposalFile,
        monthlyUsdSaved: rec.monthlyUsdSaved,
        safe: !corrupt,
        caution: corrupt ? 'your settings.json did not parse — merge the statusLine block by hand' : null,
        summary: existing
          ? `statusline warns at 80% context — wraps your existing statusline command`
          : `statusline warns at 80% context (amber) and 90% (red)`,
        companion: { artifact, installTo },
        realFileMissing: settings.raw === null,
      });
      continue;
    }
    // Local model-pin patches are handled by buildModelPinProposals above; the only
    // remaining file edit is the hosted CLAUDE.md trim (gated + install-key threaded).
    if (!isHostedTrimCandidate(rec)) continue;
    const trim = await buildConfigTrimProposal(rec, today, opts.apiBase, opts.installKey);
    if (trim) proposals.push(trim);
  }
  return proposals;
}

const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;

/** Render the reviewable-patch summary. Pure (takes the proposals). */
export function renderFix(proposals: FixProposal[]): string {
  if (proposals.length === 0) {
    return (
      `\n  ${c.bold(c.orange('cc-audit fix'))} — no reviewable patches.\n` +
      c.dim('  (Your locatable skills are already pinned, and there was no CLAUDE.md to trim.)\n') +
      c.dim('  Run `cc-audit` to see the full report and the behavioral levers.\n')
    );
  }
  const rows: string[] = [];
  let i = 1;
  for (const p of proposals) {
    const recoups = p.monthlyUsdSaved >= 0.5;
    const save = recoups ? c.gold(`~${usd(p.monthlyUsdSaved)}/mo`) : c.dim('—');
    rows.push(`${c.bold(`${i}.`)} [${save}] ${c.bold(p.title)}`);
    for (const ln of wrap(p.summary, BOX_WIDTH - 5)) rows.push(c.dim(`   ${ln}`));
    if (p.proposalFile === '(skipped)') {
      // Network/cap failure on the hosted trim — no artifact to diff; show why.
      for (const ln of wrap(`— ${p.caution}`, BOX_WIDTH - 5)) rows.push(c.amber(`   ${ln}`));
    } else {
      // Keep the ⚠ SAFETY prefix and the git-diff command contiguous (no color
      // mid-string) so they stay greppable in plain mode.
      if (!p.safe) {
        for (const ln of wrap(`⚠ SAFETY: ${p.caution} — review carefully before applying`, BOX_WIDTH - 5)) {
          rows.push(c.amber(`   ${ln}`));
        }
      }
      if (p.companion) {
        rows.push(`   ${c.dim('install:')} ${c.cyan(`cp ${p.companion.artifact} ${p.companion.installTo} && chmod +x ${p.companion.installTo}`)}`);
      }
      if (p.realFileMissing) {
        rows.push(`   ${c.dim('review:')}  new file — review ${p.proposalFile} directly`);
      } else {
        rows.push(`   ${c.dim('review:')}  ${c.cyan(`git diff --no-index ${p.realFile} ${p.proposalFile}`)}`);
      }
    }
    i += 1;
  }
  rows.push(c.dim("apply by copying a .proposed file over the original once you've reviewed it."));
  return ['', ...panel('REVIEWABLE PATCHES  ·  written to ./.cc-audit/ — nothing applied', rows, c.gold), ''].join('\n');
}
