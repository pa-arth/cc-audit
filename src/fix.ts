// `cc-audit fix` — turn recommendations into REVIEWABLE patches. Never touches a
// real file: every proposed change is written to ./.cc-audit/<name>.proposed and
// summarized with the projected $/mo + a safety verdict. The developer reviews the
// diff and applies it themselves. Two patch sources:
//   - model-pin: a purely LOCAL one-line frontmatter edit (no network, no spend).
//   - config-trim: the hosted config-review rewrite engine (spends credits; capped).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { requestConfigRewrite } from './fixClient.js';
import type { Recommendation } from './recommend.js';

export interface FixProposal {
  kind: 'model-pin' | 'config-trim';
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

/** Build reviewable patches from the recommendations that have a concrete file edit. */
export async function runFix(
  recommendations: Recommendation[],
  today: string,
  opts: { apiBase?: string } = {},
): Promise<FixProposal[]> {
  const proposals: FixProposal[] = [];

  for (const rec of recommendations) {
    if (!rec.file || !existsSync(rec.file)) continue;

    if (rec.kind === 'model-pin') {
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
    } else if (rec.kind === 'trim-config') {
      const content = readFileSync(rec.file, 'utf8');
      // The hosted rewrite is the only network/spend step — never let its failure
      // (offline, cap hit, timeout) discard the local model-pin patches above.
      let rewrite;
      try {
        rewrite = await requestConfigRewrite([{ path: 'CLAUDE.md', content }], today, opts.apiBase);
      } catch (err) {
        proposals.push({
          kind: 'config-trim',
          title: rec.title,
          realFile: rec.file,
          proposalFile: '(skipped)',
          monthlyUsdSaved: 0,
          safe: true,
          caution: `rewrite unavailable: ${err instanceof Error ? err.message : String(err)}`,
          summary: 'config-review did not run',
        });
        continue;
      }
      if (!rewrite) continue; // engine produced no rewrite
      const proposalFile = writeProposal(rec.file, rewrite.after);
      const saved = -rewrite.projectedMonthlyUsdDelta; // delta is after-before (negative = saving)
      // safety may be absent (older artifact / skipped cross-check) — treat missing
      // as UNVERIFIED so we never present an unchecked rewrite as safe.
      const safety = rewrite.safety;
      const safe = safety?.verified === true;
      proposals.push({
        kind: 'config-trim',
        title: rec.title,
        realFile: rec.file,
        proposalFile,
        monthlyUsdSaved: saved > 0 ? saved : 0,
        safe,
        caution: safe
          ? null
          : `may drop: ${safety?.droppedImperatives?.slice(0, 5).join(', ') || safety?.warnings?.[0] || 'safety not reported'}`,
        summary: `${rewrite.beforeAlwaysOnTokens.toLocaleString()} → ${rewrite.afterAlwaysOnTokens.toLocaleString()} tok`,
      });
    }
  }
  return proposals;
}

const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;

/** Render the reviewable-patch summary. Pure (takes the proposals). */
export function renderFix(proposals: FixProposal[]): string {
  if (proposals.length === 0) {
    return (
      '\n  cc-audit fix — no reviewable patches.\n' +
      '  (Your locatable skills are already pinned, and there was no CLAUDE.md to trim.)\n' +
      '  Run `cc-audit` to see the full report and the behavioral levers.\n'
    );
  }
  const out: string[] = [];
  out.push('');
  out.push('  REVIEWABLE PATCHES  (written to ./.cc-audit/ — nothing applied)');
  out.push('═'.repeat(64));
  let i = 1;
  for (const p of proposals) {
    const save = p.monthlyUsdSaved >= 0.5 ? `~${usd(p.monthlyUsdSaved)}/mo` : '—';
    out.push(`  ${i}. [${save}] ${p.title}`);
    out.push(`       ${p.summary}`);
    if (p.proposalFile === '(skipped)') {
      // Network/cap failure on the hosted trim — no artifact to diff; show why.
      out.push(`       — ${p.caution}`);
    } else {
      if (!p.safe) out.push(`       ⚠ SAFETY: ${p.caution} — review carefully before applying`);
      out.push(`       review:  git diff --no-index ${p.realFile} ${p.proposalFile}`);
    }
    i += 1;
  }
  out.push('═'.repeat(64));
  out.push('  Apply by copying a .proposed file over the original once you\'ve reviewed it.');
  out.push('');
  return out.join('\n');
}
