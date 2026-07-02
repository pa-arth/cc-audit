// The config-knob bridge: turn each cost signal into ONE concrete next action —
// the exact file to edit (when one exists), the change to make, and the projected
// $/mo. A finding without an action is homework; this is the treatment layer.
//
// Honesty rules baked in:
//   - Savings are ESTIMATES (we extrapolate a tier swap at blended rates); labeled so.
//   - A target tier is a CANDIDATE, never a mandate — set your own policy (Fable for
//     UI is a fine policy). We only flag where the lever exists.
//   - When the file isn't user-editable (bundled/plugin skills like deep-research),
//     we say so and give the behavioral lever instead of a fake file path.
//   - Local file PATHS appear only in the terminal report, never in the aggregate.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAnthropicPricing } from './vendor/pricing.js';
import { isPremiumModel } from './pricing.js';
import { sessionRedundancy, topRedundantFiles } from './fluency.js';
import type { AlwaysOnTax } from './alwaysOn.js';
import type { SpendBreakdown } from './attribute.js';
import type { RoiLedger } from './roiLedger.js';
import type { Session } from './model.js';

export interface Recommendation {
  /** Action class — drives how the report renders it. */
  kind: 'model-pin' | 'restructure' | 'trim-config' | 'subagent-policy';
  title: string;
  /** Projected monthly saving (estimate). 0 when the saving isn't quantifiable. */
  monthlyUsdSaved: number;
  /** Exact local file to edit, or null when there's no single editable file. */
  file: string | null;
  /** The concrete change to make. */
  action: string;
}

// A one-tier-down default and the blended rate ratio used to estimate the saving of
// swapping a premium model to it. Sonnet is ~0.6× Opus across input/output/cache, so
// the estimate is honest for the common Opus→Sonnet case; for other tiers we compute
// the ratio from the real pricing tables.
const DEFAULT_TARGET = 'claude-sonnet-4-6';

/** Blended $/token ratio of `target` vs `current` (input+output+cacheRead averaged).
 *  Returns 1 (no saving) if either is unknown or target isn't cheaper. */
function tierRatio(currentModel: string, target = DEFAULT_TARGET): number {
  const c = getAnthropicPricing(currentModel);
  const t = getAnthropicPricing(target);
  if (!c || !t) return 1;
  const blend = (p: { input: number; output: number; cacheRead: number }) =>
    (p.input + p.output + p.cacheRead) / 3;
  const r = blend(t) / blend(c);
  return r < 1 ? r : 1;
}

/** First on-disk SKILL.md for a skill name: user dir, then any session project dir. */
export function locateSkillFile(name: string, cwds: string[]): string | null {
  const base = name.includes(':') ? name.split(':').pop()! : name;
  const candidates = [
    join(homedir(), '.claude', 'skills', base, 'SKILL.md'),
    ...cwds.map((c) => join(c, '.claude', 'skills', base, 'SKILL.md')),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function hasModelPin(file: string): boolean {
  try {
    return /^model:\s*\S+/m.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

export function buildRecommendations(
  spend: SpendBreakdown,
  alwaysOn: AlwaysOnTax,
  sessions: Session[],
  roi: RoiLedger,
): Recommendation[] {
  const recs: Recommendation[] = [];
  const perMo = (windowUsd: number) => (windowUsd / spend.windowDays) * 30.44;
  const cwds = [...new Set(sessions.map((s) => s.cwd).filter((c): c is string => !!c))];

  // 1) Context-heavy commands → restructure (the cost is re-passed context, not tier).
  for (const c of spend.commandLeakBoard) {
    if (!c.contextHeavy) continue;
    recs.push({
      kind: 'restructure',
      title: `\`${c.command}\` re-passes a large context (${Math.round(c.contextTaxRatio)}× in:out)`,
      monthlyUsdSaved: 0, // depends how lean the context gets — not a clean number
      file: null,
      action: c.isSystemCommand
        ? `${perMo(c.costUsd).toFixed(0)}/mo. Server-controlled model — can't pin. Run it less / in a leaner session.`
        : `${perMo(c.costUsd).toFixed(0)}/mo. Run it earlier or in a leaner session (commit before the context balloons).`,
    });
  }

  // 2) Premium SLASH-COMMAND skills with no model pin → pin a cheaper tier at the file.
  for (const c of spend.commandLeakBoard) {
    if (c.contextHeavy || c.isSystemCommand || !isPremiumModel(c.topModel)) continue;
    const file = locateSkillFile(c.command, cwds);
    const saved = perMo(c.costUsd) * (1 - tierRatio(c.topModel));
    if (saved < 0.5) continue;
    if (file && !hasModelPin(file)) {
      recs.push({
        kind: 'model-pin',
        title: `\`${c.command}\` runs ${c.topModel.replace('claude-', '')} with no model pin`,
        monthlyUsdSaved: saved,
        file,
        action: `Add \`model: sonnet\` to the frontmatter (candidate — set your own tier).`,
      });
    } else if (!file) {
      recs.push({
        kind: 'model-pin',
        title: `\`${c.command}\` runs ${c.topModel.replace('claude-', '')} (bundled/plugin skill)`,
        monthlyUsdSaved: saved,
        file: null,
        action: `No editable SKILL.md found — pin via the plugin's config, or invoke a lighter model.`,
      });
    }
  }

  // 3) Subagent/delegated spend on premium → pin the SUBAGENT's model where editable.
  for (const sg of spend.subagentLeakBoard) {
    if (!isPremiumModel(sg.topModel)) continue;
    const saved = perMo(sg.costUsd) * (1 - tierRatio(sg.topModel));
    if (saved < 1) continue;
    const file = sg.isSkill ? locateSkillFile(sg.name, cwds) : null;
    if (file && !hasModelPin(file)) {
      recs.push({
        kind: 'model-pin',
        title: `\`${sg.name}\` runs its subagents on ${sg.topModel.replace('claude-', '')}`,
        monthlyUsdSaved: saved,
        file,
        action: `Add a model pin (e.g. \`model: sonnet\`) so its subagents don't all run premium.`,
      });
    } else {
      // Bundled skill (deep-research) or a bare subagent type (general-purpose): no
      // single user file. The lever is the spawning skill/workflow or invoking less.
      recs.push({
        kind: 'subagent-policy',
        title: `\`${sg.name}\` subagents cost ${perMo(sg.costUsd).toFixed(0)}/mo on ${sg.topModel.replace('claude-', '')}`,
        monthlyUsdSaved: saved,
        file: null,
        action: sg.isSkill
          ? `Bundled skill — not user-pinnable. Lever: invoke it less / scope it tighter, or run \`--judge\`.`
          : `Spawned by the Workflow/Task caller — set a model override there, or run \`--judge\` to confirm a cheaper tier fits.`,
      });
    }
  }

  // 4) Always-on: trim the heaviest project CLAUDE.md actually carried by your turns.
  if (alwaysOn.projectClaudeMdUsd >= 2 || alwaysOn.globalClaudeMdUsd >= 2) {
    // Find the single heaviest project CLAUDE.md across sessions' cwds (turn-weighted
    // matters for the $, but the trim TARGET is just the biggest file).
    let heaviest: { file: string; tokens: number } | null = null;
    for (const cwd of cwds) {
      const f = join(cwd, 'CLAUDE.md');
      if (!existsSync(f)) continue;
      let tokens = 0;
      try {
        tokens = readFileSync(f, 'utf8').length / 4;
      } catch {
        continue;
      }
      if (!heaviest || tokens > heaviest.tokens) heaviest = { file: f, tokens };
    }
    if (heaviest) {
      recs.push({
        kind: 'trim-config',
        title: `Project CLAUDE.md is read into every turn (~${alwaysOn.projectClaudeMdUsd.toFixed(0)}/mo)`,
        monthlyUsdSaved: alwaysOn.projectClaudeMdUsd * 0.4, // assume ~40% is trimmable
        file: heaviest.file,
        action: `Trim the heaviest one (~${Math.round(heaviest.tokens).toLocaleString()} tok) — cut stale/duplicated guidance.`,
      });
    }
  }

  // 5) Redundant reads: re-reading files already in context re-injects the same bytes
  //    and inflates carry. The ungameable bloat lever. Behavioral fix (/clear between
  //    tasks; don't re-open what you have), not a file edit — and we DON'T fabricate a
  //    precise $ saved (carry is mostly cheap cached reads; the honest number is the
  //    rate, not a dollar figure). So monthlyUsdSaved=0 → renders as a 'restructure'.
  let reads = 0;
  let redundant = 0;
  for (const s of sessions) {
    const r = sessionRedundancy(s);
    reads += r.reads;
    redundant += r.redundantReads;
  }
  const redundantRate = reads ? redundant / reads : 0;
  if (reads >= 50 && redundantRate >= 0.3) {
    const top = topRedundantFiles(sessions, 2)
      .map((f) => `${f.name} ×${f.rereads}`)
      .join(', ');
    recs.push({
      kind: 'restructure',
      title: `${Math.round(redundantRate * 100)}% of file reads re-read a file already in context`,
      monthlyUsdSaved: 0, // honest: the lever is the rate, not a fabricated $ saved
      file: null,
      action: `${redundant} redundant reads${top ? ` (e.g. ${top})` : ''}. Each re-injects the file you already have — \`/clear\` between unrelated tasks and avoid re-opening files in-context.`,
    });
  }

  // 6) Enabled plugins whose bundled skills/commands loaded every turn but were never
  //    invoked in the window. Unlike CLAUDE.md (a value judgment we don't make), an
  //    unused plugin's per-turn listing cost is genuinely recoverable by disabling it —
  //    so we quote a real $/mo. Still a CANDIDATE, not a mandate: unused-in-window isn't
  //    never-useful, and a near-zero-token plugin isn't worth flagging.
  const sessionN = sessions.length;
  for (const p of alwaysOn.plugins) {
    if (p.invoked || p.listingTokens < 50) continue;
    // pluginListingUsd is already a monthly figure; take this plugin's token share of it.
    const saved = alwaysOn.pluginListingUsd * (p.listingTokens / Math.max(1, alwaysOn.pluginListingTokens));
    recs.push({
      kind: 'trim-config',
      title: `\`${p.name}\` plugin loads every turn but was never invoked`,
      monthlyUsdSaved: saved,
      file: null,
      action: `0 invocations across ${sessionN} sessions; ~${Math.round(p.listingTokens).toLocaleString()} tok/turn of listings load regardless. Disable via \`/plugin\` (candidate — keep it if you use it occasionally).`,
    });
  }

  // 7) Dead-weight skills: enumerated on disk, ~0 invocations corpus-wide → standing
  //    carry for nothing. The verdict is two-sided — either genuinely unused (delete) OR
  //    its `description:` trigger keywords don't match your prompts so it never fires
  //    (rewrite). We can't tell which from transcripts; surface both and point at the file.
  for (const sk of roi.skills) {
    if (sk.verdict !== 'dead-weight') continue;
    recs.push({
      kind: 'trim-config',
      title: `\`${sk.name}\` loads every turn but was never invoked (~${sk.carryUsdPerMonth.toFixed(2)}/mo)`,
      monthlyUsdSaved: sk.carryUsdPerMonth, // full standing carry — ranks by $/mo
      file: locateSkillFile(sk.slug, cwds),
      action:
        `Delete it, or its \`description:\` trigger keywords aren't matching your prompts — ` +
        `rewrite them so it actually fires. Transcripts can't tell which; open the file and decide.`,
    });
  }

  // 8) Dead-weight MCP servers that ALSO cost standing tokens (only when !deferred —
  //    deferred servers cost ~0, so a rec there is noise).
  for (const m of roi.mcp) {
    if (!m.deadWeight || m.deferred) continue;
    recs.push({
      kind: 'trim-config',
      title: `MCP server \`${m.server}\` is configured but never invoked`,
      monthlyUsdSaved: 0, // standing token $ not separately costed here — honest 0
      file: null, // a ~/.claude.json edit is multi-server; treat as behavioral
      action: `Remove it from ~/.claude.json — its tool schemas load standing (ENABLE_TOOL_SEARCH=false) for tools you never call.`,
    });
  }

  return recs.sort((a, b) => b.monthlyUsdSaved - a.monthlyUsdSaved);
}
