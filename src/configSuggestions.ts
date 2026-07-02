// Config change suggestions — the headline lever, rendered as EXACT edits: which
// file, which line to cut, which skill to delete, with the measured evidence beside
// each one. Everything here is derived from analyses the audit already ran (roiLedger,
// conditionalContext, recommendations) — no recomputation, and strictly LOCAL: paths,
// skill names, and instruction text never enter the aggregate.
//
// Honesty rules follow recommend.ts: savings are estimates and quoted only when a
// real $/mo exists (honest 0 otherwise); every suggestion is a CANDIDATE, not a
// mandate — the two-sided dead-weight verdict and the value call stay with the user.

import type { AlwaysOnTax } from './alwaysOn.js';
import type { FixProposal } from './fix.js';
import { locateSkillFile, type Recommendation } from './recommend.js';
import type { RoiLedger } from './roiLedger.js';
import { BOX_WIDTH, c, panel, wrap } from './theme.js';

export interface ConfigSuggestion {
  kind: 'delete-skill' | 'cut-instruction' | 'model-pin' | 'remove-mcp' | 'disable-plugin';
  title: string;
  /** Absolute path of the file to edit; null when there's no single editable file. */
  file: string | null;
  /** Exact instruction text to cut (cut-instruction only). */
  quote: string | null;
  /** The concrete change to make. */
  action: string;
  /** The measurement backing the suggestion — read rates, invocation counts, tokens. */
  evidence: string;
  /** Estimated monthly saving; honest 0 when the saving isn't quantifiable. */
  monthlyUsdSaved: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Map the audit's already-computed signals into ranked, exact config edits. */
export function buildConfigSuggestions(
  r: {
    roiLedger: RoiLedger;
    alwaysOn: AlwaysOnTax;
    recommendations: Recommendation[];
    sessionCount: number;
  },
  cwds: string[],
): ConfigSuggestion[] {
  const out: ConfigSuggestion[] = [];

  // Dead-weight skills: on disk, listing re-paid every turn, ~0 invocations. The
  // verdict is two-sided (unused → delete; mismatched trigger → rewrite) — say both.
  for (const sk of r.roiLedger.skills) {
    if (sk.verdict !== 'dead-weight' || !sk.onDisk) continue;
    out.push({
      kind: 'delete-skill',
      title: `\`${sk.name}\` loads every turn but was never invoked`,
      file: locateSkillFile(sk.slug, cwds),
      quote: null,
      action:
        'Delete it, or rewrite its `description:` trigger keywords so it actually fires — ' +
        "transcripts can't tell which; open the file and decide.",
      evidence: `0 invocations across ${r.sessionCount} sessions · ~${Math.round(sk.carryTokens).toLocaleString()} tok/turn standing`,
      monthlyUsdSaved: sk.carryUsdPerMonth,
    });
  }

  // Never-followed instructions: a "read X" rule we MEASURED firing in a minority of
  // sessions. The quote + sourcePath make the cut exact. Unverified (null-rate) items
  // are excluded — cutting on no evidence violates the honesty rules above.
  for (const cc of r.alwaysOn.conditionalContext) {
    if (cc.observedReadRate === null || cc.observedReadRate >= 0.5) continue;
    const where = cc.source === 'skill' ? `skill \`${cc.skill}\`` : cc.source === 'global-claude-md' ? 'global CLAUDE.md' : 'project CLAUDE.md';
    out.push({
      kind: 'cut-instruction',
      title: `"${cc.file}" rule in your ${where} is mostly ignored`,
      file: cc.sourcePath,
      quote: cc.instruction,
      action: 'Cut the line, or move it into a skill so the file loads on demand instead of by standing rule.',
      evidence:
        `followed in ${pct(cc.observedReadRate)} of ${cc.sessionsConsidered} sessions · ` +
        `${cc.tokens.toLocaleString()} tok when it fires`,
      monthlyUsdSaved: 0, // conditional loads aren't costed as monthly carry — honest 0
    });
  }

  // Model pins: already file-anchored + costed by recommend.ts; pass through.
  for (const rec of r.recommendations) {
    if (rec.kind !== 'model-pin' || !rec.file) continue;
    out.push({
      kind: 'model-pin',
      title: rec.title,
      file: rec.file,
      quote: null,
      action: rec.action,
      evidence: 'runs premium with no `model:` pin in the frontmatter',
      monthlyUsdSaved: rec.monthlyUsdSaved,
    });
  }

  // Dead MCP servers that also pay standing tokens (deferred ones cost ~0 — skip).
  for (const m of r.roiLedger.mcp) {
    if (!m.deadWeight || m.deferred) continue;
    out.push({
      kind: 'remove-mcp',
      title: `MCP server \`${m.server}\` is configured but never invoked`,
      file: null,
      quote: null,
      action: 'Remove it from ~/.claude.json — its tool schemas load standing for tools you never call.',
      evidence: `0 invocations across ${r.sessionCount} sessions · eagerly loaded (not deferred)`,
      monthlyUsdSaved: 0, // standing token $ not separately costed — honest 0
    });
  }

  // Unused plugins: listing tax paid every turn, invoked 0× in the window.
  for (const p of r.alwaysOn.plugins) {
    if (p.invoked || p.listingTokens < 50) continue;
    const saved =
      r.alwaysOn.pluginListingTokens > 0
        ? r.alwaysOn.pluginListingUsd * (p.listingTokens / r.alwaysOn.pluginListingTokens)
        : 0;
    out.push({
      kind: 'disable-plugin',
      title: `\`${p.name}\` plugin loads every turn but was never invoked`,
      file: null,
      quote: null,
      action: 'Disable via `/plugin` (candidate — keep it if you use it occasionally).',
      evidence: `0 invocations across ${r.sessionCount} sessions · ~${Math.round(p.listingTokens).toLocaleString()} tok/turn of listings`,
      monthlyUsdSaved: saved,
    });
  }

  // Rank by $/mo; honest-zero rows keep their kind order (stable sort) at the tail.
  return out.sort((a, b) => b.monthlyUsdSaved - a.monthlyUsdSaved);
}

const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;

/** Render the suggestions panel (+ the review line for any local pin patches). Pure. */
export function renderConfigSuggestions(suggestions: ConfigSuggestion[], pinProposals: FixProposal[]): string {
  if (suggestions.length === 0) {
    return (
      `\n  ${c.bold(c.orange('config suggestions'))} — nothing to cut.\n` +
      c.dim('  (No dead-weight skills, ignored standing rules, or missing pins measured.)\n')
    );
  }
  const pinByFile = new Map(pinProposals.map((p) => [p.realFile, p]));
  const rows: string[] = [];
  let i = 1;
  for (const s of suggestions) {
    const recoups = s.monthlyUsdSaved >= 0.5;
    const save = recoups ? c.gold(`~${usd(s.monthlyUsdSaved)}/mo`) : c.dim('—');
    rows.push(`${c.bold(`${i}.`)} [${save}] ${c.bold(s.title)}`);
    if (s.file) rows.push(c.dim(`   ${s.file}`));
    // Kept contiguous (no color mid-string) so the quote stays greppable in plain mode.
    if (s.quote) rows.push(c.amber(`   cut: "${s.quote}"`));
    for (const ln of wrap(s.action, BOX_WIDTH - 5)) rows.push(c.dim(`   ${ln}`));
    rows.push(c.dim(`   evidence: ${s.evidence}`));
    const pin = s.file ? pinByFile.get(s.file) : undefined;
    if (pin && pin.proposalFile !== '(skipped)') {
      rows.push(`   ${c.dim('review:')}  ${c.cyan(`git diff --no-index ${pin.realFile} ${pin.proposalFile}`)}`);
    }
    i += 1;
  }
  rows.push(c.dim('suggestions are candidates — apply by editing the named file; nothing was changed.'));
  return [
    '',
    ...panel('CONFIG CHANGE SUGGESTIONS  ·  generated locally — nothing sent, nothing applied', rows, c.gold),
    '',
  ].join('\n');
}
