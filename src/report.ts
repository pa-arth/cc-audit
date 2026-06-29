// Human-readable terminal report. Plain text (no deps), scannable, one screen of
// signal. The shareable summary card is a Slice-3 refinement; this is the full
// report. Right-sizing $ requires the hosted judge (Slice 2) — until then we
// surface premium-model share as the lever indicator.

import type { AuditResult } from './audit.js';
import type { SessionFootprint } from './footprint.js';
import type { RefinedHygiene } from './hygieneFootprint.js';
import type { RightSizingResult } from './judgeClient.js';
import { BOX_WIDTH, c, card, panel, rule, wrap } from './theme.js';
import { localBand } from './fluency.js';

const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const pad = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
// Money is the number that matters — always gold; percentages read as cyan levers.
const money = (s: string) => c.gold(s);
const lever = (s: string) => c.cyan(s);

/**
 * The judge's verdict on the avoidable-carry headline (printed after right-sizing when
 * the backend scored the ride-along hygiene items). Sharpens the deterministic estimate
 * into "of $X flagged, the judge confirms ~$Y was genuinely stale context".
 */
export function renderHygieneRefinement(refined: RefinedHygiene, windowDays: number): string {
  const perMo = (x: number) => (x / windowDays) * 30.44;
  const det = perMo(refined.deterministicUsd);
  const ref = perMo(refined.refinedUsd);
  const rows = [
    `${c.bold(`${Math.round(refined.avgStaleShare * 100)}%`)} of the flagged carry was genuinely stale ` +
      `${c.dim(`(judge scored ${refined.judgedCount} episode${refined.judgedCount === 1 ? '' : 's'})`)}`,
    `${c.emerald('→')} avoidable carry refined: ${money(usd(det) + '/mo')} ${c.dim('→')} ${c.bold(money(usd(ref) + '/mo'))} ` +
      `${c.dim('— the rest was context the task genuinely needed')}`,
  ];
  return ['', ...card('CONTEXT HYGIENE  ·  judged (stale vs. genuinely-needed context)', rows, c.gold), ''].join('\n');
}

export function renderReport(r: AuditResult, opts: { rows?: number } = {}): string {
  const rows = opts.rows ?? 8;
  const s = r.spend;
  const out: string[] = [];
  const blank = () => out.push('');

  // ── Header ───────────────────────────────────────────────────────────────
  blank();
  out.push(
    ...card(
      'CLAUDE CODE · SPEND & FLUENCY AUDIT',
      [
        c.dim(
          `${r.sessionCount} sessions · ${Math.round(s.windowDays)}d window · ` +
            `judge layer: run with ${c.cyan('--judge')}${c.dim(' (hosted)')}`,
        ),
      ],
      c.orange,
    ),
  );

  // ── Estimated spend (the headline number, in gold) ─────────────────────────
  const spendRows = [
    `${c.dim('estimated')}  ${c.bold(money(usd(s.perMonthUsd) + '/mo'))}   ${c.dim(`(${usd(s.totalUsd)} over window)`)}`,
  ];
  if (s.unpricedShare > 0.02) {
    spendRows.push(c.amber(`⚠ ${pct(s.unpricedShare)} of spend used a fallback price (unknown model id)`));
  }
  blank();
  out.push(...card('ESTIMATED SPEND', spendRows, c.gold));

  // ── By model ───────────────────────────────────────────────────────────────
  const modelRows = s.byModel.slice(0, 6).map(
    (m) =>
      `${pad(m.model.replace('claude-', ''), 22)} ` +
      `${money(padL(usd((m.costUsd / s.windowDays) * 30.44) + '/mo', 12))}  ${lever(padL(pct(m.share), 5))}`,
  );
  blank();
  out.push(...card('BY MODEL', modelRows));

  if (r.topSessions.length > 0) {
    const topRows: string[] = [];
    let i = 1;
    for (const t of r.topSessions.slice(0, Math.min(rows, 5))) {
      // Keep each row within BOX_WIDTH (card pads but won't truncate): fixed-width
      // fields + a clipped sparkline so a 60-prompt session can't blow out the frame.
      topRows.push(
        `${c.bold(`#${i}`)} ${money(padL(usd(t.costUsd), 7))}  ${pad(t.topModel.replace('claude-', ''), 11)} ` +
          `${pad(`${t.turns}t·${t.prompts}p`, 11)} plan:${t.planMode ? 'on ' : 'off'} ` +
          `${c.dim(pad(t.topTools, 17))} ${c.dim(t.trajectory.slice(0, 12))}`,
      );
      const gist = t.taskGist.replace(/\s+/g, ' ').trim();
      topRows.push(c.dim(`   “${gist.length > 69 ? gist.slice(0, 68) + '…' : gist}”`));
      i += 1;
    }
    blank();
    out.push(...card('TOP SPENDERS  ·  most expensive sessions', topRows, c.gold));
  }

  // Lead with the cuts that have NO quality tradeoff. Model right-sizing
  // (policy-dependent, often the smallest clean lever) comes last, via --judge.
  blank();
  out.push(`  ${c.bold(c.orange('FIXABLE WASTE'))}  ${c.dim('— no-tradeoff cuts first')}`);

  // ── ⓪ Context hygiene (gold: the avoidable carry — the headline lever) ──────
  // Carrying the transcript each turn is mostly structural, but a measured slice is
  // AVOIDABLE: context grown past the /compact point, or dragged across a task switch
  // a /clear would have shed. We locate each one and bill ONLY the carry above a
  // conservative line — no fabricated "all carry is waste" number.
  const ch = r.contextHygiene;
  const tok = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`);
  const chPerMo = (x: number) => (x / s.windowDays) * 30.44;
  if (ch.autoCompactions > 0 || ch.overdueEpisodes.length > 0 || ch.staleCarrySwitches.length > 0) {
    const clearMo = chPerMo(ch.avoidableClearUsd);
    const chRows: string[] = [
      `${c.dim('avoidable carry')}  ${c.bold(money(usd(chPerMo(ch.avoidableTotalUsd)) + '/mo'))}  ` +
        `${c.dim('— context you paid to carry that a /compact or /clear would have shed')}`,
    ];
    if (ch.autoCompactions > 0) {
      chRows.push(
        `${c.amber('⚠')} ran to the context wall ${c.bold(`${ch.autoCompactions}×`)} ` +
          `across ${ch.sessionsRunToWall} session${ch.sessionsRunToWall === 1 ? '' : 's'} ` +
          `${c.dim('(auto-compacted — a proactive /compact earlier was cheaper)')}`,
      );
    }
    if (ch.overdueEpisodes.length > 0) {
      chRows.push(rule());
      chRows.push(c.dim(`missed /compact — context held past ~${tok(160000)} for a sustained run:`));
      for (const e of ch.overdueEpisodes.slice(0, 3)) {
        chRows.push(
          `  ${pad(e.project, 22)} ${c.dim(`turn ${e.atTurn}, ${e.overdueTurns} turns overdue, peak ${tok(e.peakTokens)}`)}  ` +
            `${money(padL(usd(chPerMo(e.avoidableUsd)) + '/mo', 9))}`,
        );
      }
    }
    if (ch.staleCarrySwitches.length > 0) {
      chRows.push(rule());
      chRows.push(
        `likely task switch without /clear: ${lever(`${ch.staleCarrySwitches.length}×`)} ` +
          `${money(usd(clearMo) + '/mo')}  ${c.dim('(heuristic: file working-set fully rotated, no reset)')}`,
      );
    }
    chRows.push(rule());
    chRows.push(c.dim('→ /compact when context crosses ~160K and the task continues; /clear at the end of an idea'));
    chRows.push(c.dim('estimate based on generally-accepted context-window guidelines (~160K line);'));
    chRows.push(`${c.dim('run')} ${c.cyan('--judge')} ${c.dim('for a result calibrated to your stale-vs-genuinely-needed context')}`);
    blank();
    out.push(...panel('⓪ CONTEXT HYGIENE  ·  the avoidable carry (missed /compact + /clear)', chRows, c.gold));
  }

  // ── 1. Always-on context tax (emerald: the standing config cost) ───────────
  // Reframed: this is what your CHOSEN context costs every turn, not "savings" to cut.
  const a = r.alwaysOn;
  const mcpDesc = a.mcpDeferred ? 'deferred by default (~$0 standing)' : 'eagerly loaded';
  const taxRows = [
    c.dim('always-on config — context you chose, re-paid every turn (useful ≠ free):'),
    `  project memory     ${padL(Math.round(a.projectClaudeMdTokens).toLocaleString() + ' tok', 9)}  ` +
      `${money(padL(usd(a.projectClaudeMdUsd) + '/mo', 9))}  ${c.dim('← CLAUDE.md/.local/rules + auto-memory, cwd→root')}`,
    `  global memory      ${padL(a.globalClaudeMdTokens.toLocaleString() + ' tok', 9)}  ` +
      `${money(padL(usd(a.globalClaudeMdUsd) + '/mo', 9))}  ${c.dim('→ ~/.claude/CLAUDE.md (+ .local, managed policy)')}`,
    `  skill listings     ≥${padL(a.skillDescriptionTokens.toLocaleString() + ' tok', 8)}  ` +
      `${money(padL(usd(a.skillDescriptionUsd) + '/mo', 9))}  ${c.dim(`${a.skillCount} user skills load every turn`)}`,
    ...(a.pluginCount > 0
      ? [
          `  plugin skills      ≥${padL(Math.round(a.pluginSkillTokens).toLocaleString() + ' tok', 8)}  ` +
            `${money(padL(usd(a.pluginSkillUsd) + '/mo', 9))}  ${c.dim(`${a.pluginCount} enabled plugins load every turn`)}`,
          ...(a.pluginCommandTokens > 0
            ? [
                `  plugin commands    ≥${padL(Math.round(a.pluginCommandTokens).toLocaleString() + ' tok', 8)}  ` +
                  `${money(padL(usd(a.pluginCommandUsd) + '/mo', 9))}  ${c.dim('bundled slash commands')}`,
              ]
            : []),
          ...(a.pluginAgentTokens > 0
            ? [
                `  plugin agents      ≥${padL(Math.round(a.pluginAgentTokens).toLocaleString() + ' tok', 8)}  ` +
                  `${money(padL(usd(a.pluginAgentUsd) + '/mo', 9))}  ${c.dim('bundled subagents')}`,
              ]
            : []),
        ]
      : []),
    rule(),
    `  ${c.emerald(`your config adds ≈ ${c.bold(usd(a.alwaysOnConfigMonthlyUsd) + '/mo')} of standing context`)}`,
    c.dim(
      `observed standing context: ${a.standingContextTokens.toLocaleString()} tok/turn ` +
        `(~${usd(a.observedMonthlyUsd)}/mo of spend)`,
    ),
    c.dim("  — the rest is FIXED system prompt + tool schemas you can't trim; see /context"),
    c.dim(`MCP: ${a.mcpServerCount} servers · ${mcpDesc} · invoked in ${pct(a.mcpInvokedRate)} of sessions`),
  ];
  // Conditional context — instructed reads that load only when Claude obeys, so they're
  // NOT in the total above. Shown with the MEASURED read-rate where we have the sessions.
  if (a.conditionalContext.length > 0) {
    taxRows.push(c.dim('conditional context — instructed reads, loaded only when obeyed (not in the total above):'));
    for (const cc of a.conditionalContext.slice(0, rows)) {
      const where =
        cc.source === 'skill'
          ? `skill: ${cc.skill}`
          : cc.source === 'global-claude-md'
            ? 'global CLAUDE.md'
            : 'project CLAUDE.md';
      const evidence =
        cc.observedReadRate === null
          ? 'detected; too few sessions to confirm'
          : `read in ${pct(cc.observedReadRate)} of sessions` +
            (cc.observedMedianFirstTurn !== null ? ` (median turn ${cc.observedMedianFirstTurn})` : '');
      taxRows.push(c.dim(`  ${pad(cc.file, 22)} ${padL(cc.tokens.toLocaleString() + ' tok', 9)}  ${evidence}  ← ${where}`));
    }
  }
  // Trim advice, kept STRICTLY evidence-based: a "read X" we MEASURED firing in a minority
  // of sessions is worth moving to a skill. We never tell anyone to delete CLAUDE.md/memory
  // they find useful — that value call isn't ours to make.
  const trimCandidates = a.conditionalContext.filter((cc) => cc.observedReadRate !== null && cc.observedReadRate < 0.5);
  if (trimCandidates.length > 0) {
    taxRows.push(c.amber('trim candidates (measured, low-value standing reads):'));
    for (const cc of trimCandidates.slice(0, rows)) {
      taxRows.push(c.dim(`  "${cc.file}" fires in ${pct(cc.observedReadRate!)} of sessions — move to a skill so it loads on demand`));
    }
  }
  // Unused plugins — enabled, listing-tax paid every turn, but invoked 0× in the window.
  if (a.unusedPluginCount > 0) {
    const unused = a.plugins.filter((p) => !p.invoked);
    const unusedTokens = unused.reduce((n, p) => n + p.listingTokens, 0);
    const reclaim = a.pluginListingTokens > 0 ? a.pluginListingUsd * (unusedTokens / a.pluginListingTokens) : 0;
    const names = unused.map((p) => p.name).join(', ');
    taxRows.push(
      c.amber(
        `plugins: ${a.pluginCount} enabled · ${a.unusedPluginCount} never invoked (${names}) — ` +
          `review with /plugin; disabling reclaims ≈${usd(reclaim)}/mo of standing context`,
      ),
    );
  }
  blank();
  out.push(...panel('① ALWAYS-ON CONTEXT TAX  ·  what your standing context costs', taxRows, c.emerald));

  // ── 2. Slash-command / skill leak (amber: low-tradeoff restructuring) ──────
  const leakRows = [
    c.dim(`${pad('command', 22)} ${padL('$/mo', 9)} ${padL('inv/mo', 7)} ${padL('turns', 5)} ${padL('ctx×', 5)}  fix`),
  ];
  for (const cmd of s.commandLeakBoard.slice(0, rows)) {
    // Context-heavy commands cost because they RE-PASS a big context, not because of
    // the model tier — the fix is restructuring, and it overrides pin/fork advice.
    const fix = cmd.contextHeavy
      ? 'restructure: run earlier / leaner ctx'
      : [cmd.forkCandidate ? 'fork/split' : '', cmd.modelPinCandidate ? 'model-pin' : ''].filter(Boolean).join('+') || '—';
    leakRows.push(
      `${pad(cmd.command, 22)} ${money(padL(usd((cmd.costUsd / s.windowDays) * 30.44), 9))} ` +
        `${padL(((cmd.invocations / s.windowDays) * 30.44).toFixed(1), 7)} ${padL(cmd.turnsPerInvocation.toFixed(0), 5)} ` +
        `${padL(Math.round(cmd.contextTaxRatio) + '×', 5)}  ${fix === '—' ? c.dim(fix) : lever(fix)}`,
    );
  }
  // Surface the leak board's blind spot: skills the model invoked by natural language
  // (no slash marker) — their cost is in the prompt span, not on a command line above.
  if (s.modelInvokedSkills.length > 0) {
    const top = s.modelInvokedSkills
      .slice(0, 4)
      .map((m) => `${m.name} ×${m.invocations}`)
      .join(', ');
    leakRows.push(c.dim(`+ model-invoked (natural language, not /command): ${top}`));
    leakRows.push(c.dim('  → counted in regular sessions, not above (cost shared with the prompt)'));
  }
  const tot = s.totalUsd || 1;
  const regularShare = Math.max(0, s.nonCommandUsd / tot);
  leakRows.push(
    c.dim(
      `(commands ${pct(s.commandTotalUsd / tot)} · subagents ${pct(s.subagentTotalUsd / tot)} · ` +
        `regular sessions ${pct(regularShare)})`,
    ),
  );
  blank();
  out.push(...panel('② COMMAND / SKILL LEAK  ·  restructure, fork/split, or pin', leakRows, c.amber));

  // Subagent/delegated spend lives in sidechains with no promptId — so a skill that
  // does all its work via subagents (deep-research, ultra-reviews, Workflow) shows
  // $0 on the leak board above. This board recovers it from the transcript's own
  // attribution fields. Only printed when there's delegated spend to show.
  if (s.subagentLeakBoard.length > 0) {
    const subRows = [c.dim(`${pad('skill / subagent', 24)} ${padL('$/mo', 9)} ${padL('turns', 7)}  fix`)];
    for (const sub of s.subagentLeakBoard.slice(0, rows)) {
      const fix = sub.modelPinCandidate ? 'cheaper-subagent-model' : '—';
      const tag = sub.isSkill ? '' : ' ·';
      subRows.push(
        `${pad(sub.name + tag, 24)} ${money(padL(usd((sub.costUsd / s.windowDays) * 30.44), 9))} ` +
          `${padL(sub.turns.toFixed(0), 7)}  ${fix === '—' ? c.dim(fix) : lever(fix)}`,
      );
    }
    subRows.push(c.dim("(· = direct subagent type, not a named skill · right-size the subagent's model)"));
    blank();
    out.push(...panel('②ᵇ SUBAGENT / DELEGATED SPEND  ·  sidechain work', subRows, c.amber));
  }

  // ── Fluency (cyan: the habits behind the bill) ─────────────────────────────
  const f = r.fluency;
  // No false-precise integer: a coarse self-band (calibrated cohort band is gated
  // behind --open). The raw habits below are the user's own facts.
  const carryPerMo = (f.carryUsd / s.windowDays) * 30.44;
  const fluencyRows = [
    `self-band: ${c.bold(c.cyan(localBand(f)))}  ${c.dim('·')}  ${c.cyan('cc-audit --open')} ${c.dim('for your calibrated band + percentile')}`,
    c.dim(`plan-mode: ${pct(f.planModeRate)} of substantive sessions · subagent: ${pct(f.subagentUsageRate)} · models: ${f.modelDiversity}`),
    c.dim(`turns/task: median ${f.medianTurnsPerTask}, p90 ${f.p90TurnsPerTask}`),
    // Honest carry headline: carry is most of an agentic bill and mostly structural —
    // but NOT all unavoidable. We name the measured avoidable slice instead of either
    // calling all of it waste or hand-waving it away as "legitimate".
    `context carry: ${money(usd(carryPerMo) + '/mo')}  ${c.dim(`(${pct(f.carryShare)} of bill — re-reading transcript each turn)`)}`,
    c.dim(
      `  of which ~${money(usd(chPerMo(ch.avoidableTotalUsd)) + '/mo')} is avoidable ` +
        `(missed /compact + /clear — see context hygiene above)`,
    ),
  ];
  // The avoidable lever: redundant reads (re-injecting files already in context).
  if (f.redundantReadRate >= 0.15) {
    fluencyRows.push(`redundant reads: ${lever(pct(f.redundantReadRate))} ${c.dim('of reads re-open a file already in context')}`);
    if (r.topRedundantFiles.length) {
      const egText = `e.g. ${r.topRedundantFiles.map((t) => `${t.name} ×${t.rereads}`).join(', ')}`;
      for (const ln of wrap(egText, BOX_WIDTH - 4)) fluencyRows.push(c.dim(`    ${ln}`));
    }
    fluencyRows.push(c.dim("  → /clear between tasks; don't re-read what you already have"));
  }
  fluencyRows.push(`premium-model share: ${lever(pct(f.premiumTurnShare))}  ${c.dim('← right-sizing lever, not a grade')}`);
  blank();
  out.push(...card('FLUENCY  ·  the habits behind the bill', fluencyRows, c.cyan));

  // ── 3. Model right-sizing teaser (the --judge upsell) ──────────────────────
  const rsRows = [
    `${lever(pct(f.premiumTurnShare))} of turns run premium models. Run ${c.cyan('cc-audit --judge')} to see which`,
    c.dim('tasks a cheaper model could do — frontier choice stays your policy.'),
  ];
  blank();
  out.push(...card('③ MODEL RIGHT-SIZING  ·  policy-dependent, often the smallest clean lever', rsRows));

  // The treatment layer: synthesize everything above into ranked, file-anchored
  // actions. Estimates — a candidate tier is never a mandate.
  if (r.recommendations.length > 0) {
    const actionRows: string[] = [];
    let i = 1;
    for (const rec of r.recommendations.slice(0, rows)) {
      const recoups = rec.monthlyUsdSaved >= 0.5;
      const tag = recoups ? c.gold(`~${usd(rec.monthlyUsdSaved)}/mo`) : c.amber('restructure');
      actionRows.push(`${c.bold(`${i}.`)} [${tag}] ${c.bold(pad(rec.title, 54))}`);
      if (rec.file) actionRows.push(c.dim(`   ${rec.file}`));
      for (const ln of wrap(rec.action, BOX_WIDTH - 3)) actionRows.push(c.dim(`   ${ln}`));
      i += 1;
    }
    blank();
    out.push(...card('NEXT ACTIONS  ·  ranked by est. $/mo saved', actionRows, c.gold));
  }
  blank();
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

  const rows: string[] = [
    // Kept contiguous (no color mid-string) so substring assertions still match.
    `${c.bold(`${Math.round(overModeledShare * 100)}% of ${judged} judged sessions`)} are over-modeled at this setting`,
    `${c.emerald('→')} ~${money(usd(estMonthlyOverModeled) + '/mo right-sizable')} ${c.dim('— policy-dependent, often < the no-tradeoff cuts')}`,
    rule(),
    c.dim('biggest recommended cuts:'),
  ];
  const paired = footprints
    .map((f, i) => ({ f, v: verdicts[i] }))
    .filter((p) => isRecommendedCut(p.v, aggressiveness))
    .sort((a, b) => (b.v!.savingsUsd - a.v!.savingsUsd))
    .slice(0, 6);
  if (paired.length === 0) {
    rows.push(c.dim('  (none flagged in the sample)'));
  } else {
    for (const { f, v } of paired) {
      const perMo = (v!.savingsUsd / windowDays) * 30.44;
      const task = f.taskGist.replace(/\s+/g, ' ').slice(0, 42);
      rows.push(
        `  ${f.model.replace('claude-', '')} ${c.cyan('→')} ${lever(v!.minTier)} ` +
          `(${money(padL(usd(perMo) + '/mo', 9))})  ${c.dim(task)}`,
      );
    }
  }
  rows.push(rule());
  rows.push(c.dim('Note: "min tier" is a candidate, not a mandate — set your own policy'));
  rows.push(c.dim('(e.g. Fable for design). A deliberate policy IS the fluency win.'));

  return ['', ...card(`MODEL RIGHT-SIZING  ·  gpt-5.5, aggressiveness: ${aggressiveness}`, rows, c.cyan), ''].join('\n');
}
