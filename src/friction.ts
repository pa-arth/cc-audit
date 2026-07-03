// Friction taxonomy — the struggle behind the bill, attributed per skill (feeds the
// Skill Regret stat in roiLedger). Three structurally-detectable kinds, deliberately
// NOT one blurry "regret %":
//   - tool-error:      a tool_result came back is_error (count only — payload never stored)
//   - self-correction: the model re-edits a path it just wrote (fixing its own mistake),
//                      a structural LOWER BOUND — we never scan prose for "oops" (privacy
//                      + unreliable), so purely-textual reconsiderations are invisible
//   - retry-loop:      a run of ≥2 consecutive errored turns on the same dominant tool
//
// "Not all friction is equal": a self-correction (model fixed itself) is cheaper signal
// than a retry-loop (genuinely stuck). We report the split, framed as a rate, never a
// verdict — an is_error can be an intended failure (grep no-match, a test meant to fail)
// and we can't tell without the payload we refuse to store.
//
// LOCAL-FIRST: skill keys are custom names — bySkill is hashed via safeName() before any
// upload (see aggregate.ts).

import type { Session, Span } from './model.js';
import { turnCostUsd } from './pricing.js';

export type FrictionKind = 'tool-error' | 'self-correction' | 'retry-loop';

export interface SkillFriction {
  /** Skill key, resolved with the same precedence attribute.ts uses, else '(none)'. */
  skill: string;
  turns: number;
  usd: number;
  toolErrors: number;
  selfCorrections: number;
  retryLoops: number;
  /** (toolErrors + selfCorrections + retryLoops) / turns — the Skill Regret number. */
  frictionRate: number;
}

export interface FrictionTaxonomy {
  bySkill: SkillFriction[]; // sorted by frictionRate desc
  totalToolErrors: number;
  totalSelfCorrections: number;
  totalRetryLoops: number;
}

// Re-edit of a path counts as a self-correction only if it lands within this many turns
// of the prior write — far-apart edits are legitimate iteration, not a walkback.
const SELF_CORRECTION_WINDOW = 2;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The skill a span's work belongs to. Mirrors attribute.ts: command, else (sidechain)
 *  attributionSkill, else the model-invoked skill, else unattributed. */
export function spanSkillKey(span: Span): string {
  return span.command ?? span.attributionSkill ?? span.invokedSkills[0] ?? '(none)';
}

interface Acc {
  turns: number;
  usd: number;
  toolErrors: number;
  selfCorrections: number;
  retryLoops: number;
}

export function computeFriction(sessions: Session[]): FrictionTaxonomy {
  const bySkill = new Map<string, Acc>();
  const get = (skill: string): Acc => {
    let a = bySkill.get(skill);
    if (!a) {
      a = { turns: 0, usd: 0, toolErrors: 0, selfCorrections: 0, retryLoops: 0 };
      bySkill.set(skill, a);
    }
    return a;
  };

  for (const session of sessions) {
    for (const span of session.spans) {
      const acc = get(spanSkillKey(span));
      // Index of the turn (within the span) that last wrote each path — for the walkback
      // window. A path re-edited within the window, immediately or with an intervening
      // errored turn, is a self-correction.
      const wroteAt = new Map<string, number>();
      let errorRun = 0; // consecutive errored turns
      let runTool: string | null = null; // dominant tool of the current error run

      span.turns.forEach((t, i) => {
        acc.turns += 1;
        acc.usd += turnCostUsd(t.model, t.usage, t.ts).usd;
        const errs = t.toolErrorCount ?? 0;
        if (errs > 0) acc.toolErrors += errs;

        // self-correction: a write to a path written ≤window turns ago, where either the
        // re-edit is immediate or an errored turn sits between (i.e. fixing a mistake).
        for (const op of t.fileOps ?? []) {
          if (!WRITE_TOOLS.has(op.tool)) continue;
          const prev = wroteAt.get(op.path);
          if (prev != null && i - prev <= SELF_CORRECTION_WINDOW) {
            const immediate = i - prev === 1;
            const errorBetween = span.turns.slice(prev, i).some((x) => (x.toolErrorCount ?? 0) > 0);
            if (immediate || errorBetween) acc.selfCorrections += 1;
          }
          wroteAt.set(op.path, i);
        }

        // retry-loop: a maximal run of ≥2 consecutive errored turns sharing a dominant
        // tool (Bash-heavy retries especially). Count ONE per run, on the turn it ends.
        const dominant = dominantTool(t);
        if (errs > 0 && (runTool == null || runTool === dominant)) {
          errorRun += 1;
          runTool = dominant ?? runTool;
        } else {
          if (errorRun >= 2) acc.retryLoops += 1;
          errorRun = errs > 0 ? 1 : 0;
          runTool = errs > 0 ? dominant : null;
        }
      });
      if (errorRun >= 2) acc.retryLoops += 1; // run that reached the end of the span
    }
  }

  const rows: SkillFriction[] = [...bySkill.entries()].map(([skill, a]) => ({
    skill,
    turns: a.turns,
    usd: a.usd,
    toolErrors: a.toolErrors,
    selfCorrections: a.selfCorrections,
    retryLoops: a.retryLoops,
    frictionRate: a.turns ? (a.toolErrors + a.selfCorrections + a.retryLoops) / a.turns : 0,
  }));
  rows.sort((x, y) => y.frictionRate - x.frictionRate);

  return {
    bySkill: rows,
    totalToolErrors: rows.reduce((n, r) => n + r.toolErrors, 0),
    totalSelfCorrections: rows.reduce((n, r) => n + r.selfCorrections, 0),
    totalRetryLoops: rows.reduce((n, r) => n + r.retryLoops, 0),
  };
}

/** The most-used tool name in a turn, or null if none — labels a retry run. */
function dominantTool(t: { tools: string[] }): string | null {
  if (t.tools.length === 0) return null;
  const counts = new Map<string, number>();
  for (const tool of t.tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
