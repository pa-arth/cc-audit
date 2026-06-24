// Human-readable terminal report. Plain text (no deps), scannable, one screen of
// signal. The shareable summary card is a Slice-3 refinement; this is the full
// report. Right-sizing $ requires the hosted judge (Slice 2) — until then we
// surface premium-model share as the lever indicator.

import type { AuditResult } from './audit.js';
import type { SessionFootprint } from './footprint.js';
import type { RightSizingResult } from './judgeClient.js';

const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const pad = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

export function renderReport(r: AuditResult, opts: { rows?: number } = {}): string {
  const rows = opts.rows ?? 8;
  const s = r.spend;
  const out: string[] = [];
  const line = (c = '─') => out.push(c.repeat(64));

  out.push('');
  out.push('  CLAUDE CODE SPEND & FLUENCY AUDIT');
  out.push(
    `  ${r.sessionCount} sessions · ${Math.round(s.windowDays)}d window · ` +
      `judge model layer: run with --judge (hosted)`,
  );
  line('═');
  out.push(`  ESTIMATED SPEND:  ${usd(s.perMonthUsd)}/mo   (${usd(s.totalUsd)} over window)`);
  if (s.unpricedShare > 0.02) out.push(`  ⚠ ${pct(s.unpricedShare)} of spend used a fallback price (unknown model id)`);
  line();

  out.push('  BY MODEL');
  for (const m of s.byModel.slice(0, 6)) {
    out.push(`    ${pad(m.model.replace('claude-', ''), 22)} ${padL(usd((m.costUsd / s.windowDays) * 30.44) + '/mo', 12)}  ${padL(pct(m.share), 5)}`);
  }
  line();

  // Lead with the cuts that have NO quality tradeoff. Model right-sizing
  // (policy-dependent, often the smallest clean lever) comes last, via --judge.
  out.push('  FIXABLE WASTE  —  no-tradeoff cuts first');
  line();

  out.push('  1. ALWAYS-ON CONTEXT TAX  (no quality tradeoff — the cleanest cut)');
  const a = r.alwaysOn;
  out.push(`    recoverable config (read every turn) — what you can actually trim:`);
  out.push(
    `      project CLAUDE.md   ${padL(Math.round(a.projectClaudeMdTokens).toLocaleString() + ' tok', 9)}  ${padL(usd(a.projectClaudeMdUsd) + '/mo', 9)}  ← trim the repo's CLAUDE.md`,
  );
  out.push(
    `      global CLAUDE.md    ${padL(a.globalClaudeMdTokens.toLocaleString() + ' tok', 9)}  ${padL(usd(a.globalClaudeMdUsd) + '/mo', 9)}  → ~/.claude/CLAUDE.md`,
  );
  out.push(
    `      skill listings     ≥${padL(a.skillDescriptionTokens.toLocaleString() + ' tok', 8)}  ${padL(usd(a.skillDescriptionUsd) + '/mo', 9)}  ${a.skillCount} user skills load every turn`,
  );
  out.push(`      ${'─'.repeat(46)}`);
  out.push(`      recoverable ≈ ${usd(a.recoverableMonthlyUsd)}/mo`);
  out.push(
    `    observed standing context: ${a.standingContextTokens.toLocaleString()} tok/turn (~${usd(a.observedMonthlyUsd)}/mo of spend)`,
  );
  out.push(`      — the rest is FIXED system prompt + tool schemas you can't trim; see /context`);
  const mcpDesc = a.mcpDeferred ? 'deferred by default (~$0 standing)' : 'eagerly loaded';
  out.push(`    MCP: ${a.mcpServerCount} servers · ${mcpDesc} · invoked in ${pct(a.mcpInvokedRate)} of sessions`);
  line();

  out.push('  2. SLASH-COMMAND / SKILL LEAK  (low tradeoff — restructure, fork/split, or pin)');
  out.push(`    ${pad('command', 22)} ${padL('$/mo', 9)} ${padL('inv/mo', 7)} ${padL('turns', 5)} ${padL('ctx×', 5)}  fix`);
  for (const c of s.commandLeakBoard.slice(0, rows)) {
    // Context-heavy commands cost because they RE-PASS a big context, not because of
    // the model tier — the fix is restructuring, and it overrides pin/fork advice.
    const fix = c.contextHeavy
      ? 'restructure: run earlier / leaner ctx'
      : [c.forkCandidate ? 'fork/split' : '', c.modelPinCandidate ? 'model-pin' : ''].filter(Boolean).join('+') || '—';
    out.push(
      `    ${pad(c.command, 22)} ${padL(usd((c.costUsd / s.windowDays) * 30.44), 9)} ` +
        `${padL(((c.invocations / s.windowDays) * 30.44).toFixed(1), 7)} ${padL(c.turnsPerInvocation.toFixed(0), 5)} ` +
        `${padL(Math.round(c.contextTaxRatio) + '×', 5)}  ${fix}`,
    );
  }
  // Surface the leak board's blind spot: skills the model invoked by natural language
  // (no slash marker) — their cost is in the prompt span, not on a command line above.
  if (s.modelInvokedSkills.length > 0) {
    const top = s.modelInvokedSkills
      .slice(0, 4)
      .map((m) => `${m.name} ×${m.invocations}`)
      .join(', ');
    out.push(`    + model-invoked (natural language, not /command): ${top}`);
    out.push(`      → counted in regular sessions, not above (cost shared with the prompt)`);
  }
  const tot = s.totalUsd || 1;
  const regularShare = Math.max(0, s.nonCommandUsd / tot);
  out.push(
    `    (commands ${pct(s.commandTotalUsd / tot)} · subagents ${pct(s.subagentTotalUsd / tot)} · ` +
      `regular sessions ${pct(regularShare)})`,
  );
  line();

  // Subagent/delegated spend lives in sidechains with no promptId — so a skill that
  // does all its work via subagents (deep-research, ultra-reviews, Workflow) shows
  // $0 on the leak board above. This board recovers it from the transcript's own
  // attribution fields. Only printed when there's delegated spend to show.
  if (s.subagentLeakBoard.length > 0) {
    out.push('  2b. SUBAGENT / DELEGATED SPEND  (sidechain work — invisible per-skill before)');
    out.push(`    ${pad('skill / subagent', 24)} ${padL('$/mo', 9)} ${padL('turns', 7)}  fix`);
    for (const c of s.subagentLeakBoard.slice(0, rows)) {
      const fix = c.modelPinCandidate ? 'cheaper-subagent-model' : '—';
      const tag = c.isSkill ? '' : ' ·';
      out.push(
        `    ${pad(c.name + tag, 24)} ${padL(usd((c.costUsd / s.windowDays) * 30.44), 9)} ` +
          `${padL(c.turns.toFixed(0), 7)}  ${fix}`,
      );
    }
    out.push(`    (· = direct subagent type, not a named skill · right-size the subagent's model)`);
    line();
  }

  out.push('  FLUENCY  (the habits behind the bill)');
  const f = r.fluency;
  out.push(`    score: ${f.score}/100   ·   premium-model share: ${pct(f.premiumTurnShare)}  ← the right-sizing lever`);
  out.push(`    plan-mode: ${pct(f.planModeRate)} of sessions · subagent spend: ${pct(f.subagentUsageRate)} · /compact: ${pct(f.contextBloatRate)}`);
  out.push(`    turns/task: median ${f.medianTurnsPerTask}, p90 ${f.p90TurnsPerTask} · models used: ${f.modelDiversity}`);
  line('═');
  out.push(`  3. MODEL RIGHT-SIZING  (policy-dependent — often the SMALLEST clean lever)`);
  out.push(`     ${pct(f.premiumTurnShare)} of turns run premium models. Run \`cc-audit --judge\` to see which`);
  out.push('     tasks a cheaper model could do — frontier choice stays your policy.');

  // The treatment layer: synthesize everything above into ranked, file-anchored
  // actions. Estimates — a candidate tier is never a mandate.
  if (r.recommendations.length > 0) {
    out.push('');
    line('═');
    out.push('  NEXT ACTIONS  (ranked by est. $/mo saved — set your own model policy)');
    line();
    let i = 1;
    for (const rec of r.recommendations.slice(0, rows)) {
      const tag = rec.monthlyUsdSaved >= 0.5 ? `~${usd(rec.monthlyUsdSaved)}/mo` : 'restructure';
      out.push(`  ${i}. [${tag}] ${rec.title}`);
      if (rec.file) out.push(`       ${rec.file}`);
      out.push(`       ${rec.action}`);
      i += 1;
    }
  }
  out.push('');
  return out.join('\n');
}

/**
 * Aggressiveness knob: which over-modeled candidates get RECOMMENDED as cuts.
 * The judge always returns its best capability estimate + confidence; this gate
 * decides how many of those surface as recommendations. conservative = only
 * high-confidence (the product default — teams pay up for best results, so we
 * flag only the obvious waste); aggressive = every candidate.
 */
export type Aggressiveness = 'conservative' | 'balanced' | 'aggressive';
const MIN_CONF: Record<Aggressiveness, number> = { conservative: 3, balanced: 2, aggressive: 1 };
const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** A verdict counts as a recommended cut only if it clears the confidence gate. */
function isRecommendedCut(v: { overModeled: boolean; confidence: string } | undefined, level: Aggressiveness): boolean {
  return !!v && v.overModeled && (CONF_RANK[v.confidence] ?? 0) >= MIN_CONF[level];
}

/**
 * The right-sizing section (printed when `--judge` ran). Pairs each footprint with
 * its verdict by index, gates by aggressiveness, extrapolates the gated over-modeled
 * share to premium spend, and lists the biggest recommended cuts.
 */
export function renderRightSizing(
  footprints: SessionFootprint[],
  result: RightSizingResult,
  windowDays: number,
  premiumMonthlyUsd: number,
  aggressiveness: Aggressiveness = 'balanced',
): string {
  const { verdicts } = result;
  // Recompute the headline from the gated set (not the server's ungated summary).
  const judged = verdicts.filter((v) => !v.unassessed).length;
  const cuts = verdicts.filter((v) => isRecommendedCut(v, aggressiveness));
  const totalCostUsd = footprints.reduce((n, f) => n + f.costUsd, 0);
  const gatedSavings = cuts.reduce((n, v) => n + v.savingsUsd, 0);
  const gatedSavingsShare = totalCostUsd ? gatedSavings / totalCostUsd : 0;
  const overModeledShare = judged ? cuts.length / judged : 0;
  const estMonthlyOverModeled = premiumMonthlyUsd * gatedSavingsShare;
  const out: string[] = [];
  out.push('');
  out.push(`  MODEL RIGHT-SIZING  (gpt-5.5, aggressiveness: ${aggressiveness})`);
  out.push('═'.repeat(64));
  out.push(
    `  ${Math.round(overModeledShare * 100)}% of ${judged} judged sessions are over-modeled at this setting`,
  );
  out.push(
    `  → ~${usd(estMonthlyOverModeled)}/mo right-sizable — policy-dependent, often < the no-tradeoff cuts`,
  );
  out.push('');
  out.push('  biggest recommended cuts:');
  const paired = footprints
    .map((f, i) => ({ f, v: verdicts[i] }))
    .filter((p) => isRecommendedCut(p.v, aggressiveness))
    .sort((a, b) => (b.v!.savingsUsd - a.v!.savingsUsd))
    .slice(0, 6);
  if (paired.length === 0) {
    out.push('    (none flagged in the sample)');
  } else {
    for (const { f, v } of paired) {
      const perMo = (v!.savingsUsd / windowDays) * 30.44;
      const task = f.taskGist.replace(/\s+/g, ' ').slice(0, 46);
      out.push(`    ${f.model.replace('claude-', '')} → ${v!.minTier} (${padL(usd(perMo) + '/mo', 9)})  ${task}`);
    }
  }
  out.push('═'.repeat(64));
  out.push('  Note: "min tier" is a candidate, not a mandate — set your own policy');
  out.push('  (e.g. Fable for design). A deliberate policy IS the fluency win.');
  out.push('');
  return out.join('\n');
}
