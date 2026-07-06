// `cc-audit fix` — turn recommendations into REVIEWABLE artifacts. Never touches a
// real file: everything is written to ./.cc-audit/ for the developer to review and
// apply themselves. Sources:
//   - model-pin: a purely LOCAL one-line frontmatter edit → a <name>.proposed patch.
//   - context-guardrail: a LOCAL settings.json patch + statusline script.
//   - config-trim: the hosted config-review — the k=3 judge's net-value findings,
//     written to a <name>.review.md advisory (spends credits; capped). NOT an
//     auto-rewrite: the findings are applied by hand.

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
import { requestConfigReview, type ConfigReview } from './fixClient.js';
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
  /** false ⇒ present as a caution only, don't apply blindly (e.g. unparseable settings.json). */
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

/** Config-review is advisory, not a patch — its findings go to a .review.md doc the
 *  developer reads and applies by hand (distinct suffix so it never looks like a
 *  copy-over-the-original .proposed patch). */
function writeReviewDoc(realFile: string, content: string): string {
  mkdirSync(PROPOSAL_DIR, { recursive: true });
  const out = join(PROPOSAL_DIR, `${basename(dirname(realFile))}__${basename(realFile)}.review.md`);
  writeFileSync(out, content);
  return out;
}

const VERDICT_LABEL: Record<string, string> = {
  net_positive: 'net-positive',
  net_neutral: 'net-neutral',
  net_negative: 'net-NEGATIVE',
  insufficient_evidence: 'insufficient evidence',
};
const verdictLabel = (v: string): string => VERDICT_LABEL[v] ?? v;

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Render the judge's findings as a human-readable review doc. Pure. */
export function renderConfigReviewDoc(realFile: string, review: ConfigReview): string {
  const lines: string[] = [
    `# config-review — ${realFile}`,
    '',
    `Verdict: ${verdictLabel(review.verdict)}`,
    '',
    'Advisory — the hosted judge flagged the items below. Apply them by hand;',
    'nothing here is auto-written to your config.',
    '',
    '---',
    '',
  ];
  const sorted = [...review.findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
  );
  sorted.forEach((f, i) => {
    lines.push(`## ${i + 1}. [${f.severity}] ${f.title}`, '');
    if (f.detail) lines.push(f.detail, '');
    if (f.suggestedChange) lines.push(`**Suggested change:** ${f.suggestedChange}`, '');
  });
  if (review.notes.length > 0) {
    lines.push('---', '', '### engine notes', '');
    for (const n of review.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return lines.join('\n');
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

/** The hosted CLAUDE.md review — the only network/spend step. A failure (offline,
 *  cap hit, timeout) is returned as a `(skipped)` proposal, never thrown, so callers
 *  can't lose their local patches to it. Caller gates via isHostedTrimCandidate. */
export async function buildConfigTrimProposal(
  rec: Recommendation,
  today: string,
  apiBase?: string,
  installKey?: string,
): Promise<FixProposal | null> {
  let review;
  try {
    // Read inside the try: a filesystem error (perms, file removed after the
    // isHostedTrimCandidate check, symlink loop) must surface as a (skipped) proposal,
    // not throw out of the function — the Promise.allSettled caller never inspects rejections.
    const content = readFileSync(rec.file!, 'utf8');
    // Resolve the install key at the actual send site — this function is only reached
    // for a real hosted-trim candidate, so the key is generated/persisted only on egress.
    review = await requestConfigReview(
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
      caution: `review unavailable: ${err instanceof Error ? err.message : String(err)}`,
      summary: 'config-review did not run',
    };
  }
  if (!review) return null; // no report from the server
  if (review.findings.length === 0) {
    // Completed but nothing flagged. If the judge itself was unavailable
    // (insufficient evidence + engine notes), surface WHY rather than vanishing —
    // that silent-null invisibility is exactly what hid the earlier breakage. A
    // clean "nothing to trim" (a real verdict, no notes) just returns null.
    if (review.verdict === 'insufficient_evidence' && review.notes.length > 0) {
      return {
        kind: 'config-trim',
        title: rec.title,
        realFile: rec.file!,
        proposalFile: '(skipped)',
        monthlyUsdSaved: 0,
        safe: true,
        caution: `review incomplete: ${review.notes[0]}`,
        summary: 'config-review returned no findings',
      };
    }
    return null;
  }
  const proposalFile = writeReviewDoc(rec.file!, renderConfigReviewDoc(rec.file!, review));
  const highs = review.findings.filter((f) => f.severity === 'high').length;
  const detail = highs > 0 ? `${highs} high-severity` : `${review.findings.length}`;
  return {
    kind: 'config-trim',
    title: rec.title,
    realFile: rec.file!,
    proposalFile,
    // Local estimate from the rec (~40% of the CLAUDE.md always-on carry) — the
    // potential saving if you act on the findings, not a rewrite-measured delta.
    monthlyUsdSaved: rec.monthlyUsdSaved > 0 ? rec.monthlyUsdSaved : 0,
    safe: true, // advisory — nothing is auto-applied
    caution: null,
    summary: `${verdictLabel(review.verdict)} · ${detail} finding(s) to apply by hand`,
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
      // Network/cap failure on the hosted review — no artifact to show; show why.
      for (const ln of wrap(`— ${p.caution}`, BOX_WIDTH - 5)) rows.push(c.amber(`   ${ln}`));
    } else if (p.kind === 'config-trim') {
      // Advisory findings, not a patch — point at the review doc; nothing to diff or copy.
      rows.push(`   ${c.dim('review:')}  open ${c.cyan(p.proposalFile)} — apply the findings by hand`);
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
  // Only the patch kinds (model-pin, context-guardrail) are copy-over-the-original;
  // config-trim is a hand-applied advisory with its own "review:" pointer.
  if (proposals.some((p) => p.proposalFile !== '(skipped)' && p.kind !== 'config-trim')) {
    rows.push(c.dim("apply by copying a .proposed file over the original once you've reviewed it."));
  }
  return ['', ...panel('REVIEWABLE PATCHES  ·  written to ./.cc-audit/ — nothing applied', rows, c.gold), ''].join('\n');
}
