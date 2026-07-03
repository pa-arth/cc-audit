// Cost attribution — the trust-critical core. Cost is summed PER promptId-SPAN
// (one user prompt + the turns it triggered), then rolled up by model, project,
// and slash-command. Attributing "invocation to end of session" instead was 4x
// wrong during exploration; spans are the correct, regression-locked unit.

import type { Session } from './model.js';
import { isPremiumModel, turnCostUsd, turnTokens } from './pricing.js';

export interface ModelSpend {
  model: string;
  costUsd: number;
  turns: number;
  tokens: number;
  share: number; // fraction of total
}

export interface CommandSpend {
  command: string;
  costUsd: number;
  invocations: number;
  costPerInvocation: number;
  turnsPerInvocation: number;
  topModel: string;
  /** Input-side context tokens per output token (input+cacheRead+cacheWrite ÷ output).
   *  High ⇒ the command's cost is re-passing a big context, not producing work. */
  contextTaxRatio: number;
  /** Heuristic flags for the fix recommendations (not advice itself). */
  forkCandidate: boolean; // heavy + context-coupled → isolate
  modelPinCandidate: boolean; // runs premium AND model is user-pinnable → consider a pin
  /** Cost dominated by re-passed context (high contextTaxRatio) → restructure, not pin. */
  contextHeavy: boolean;
  /** Server-controlled command (compact/clear) — model is NOT user-pinnable. */
  isSystemCommand: boolean;
}

/** A skill the MODEL invoked (via the `Skill` tool / natural language like "ship
 *  this"), not a typed `/command`. Its turns run under the spawning prompt's span,
 *  so the leak board (which keys on the slash marker) never sees them. We surface
 *  the count + an UPPER-BOUND cost (the whole prompt, shared with other work) so the
 *  undercount is visible without falsely reattributing mixed spans to the skill. */
export interface ModelInvokedSkill {
  name: string;
  /** Spans in which the model invoked this skill (no slash command present). */
  invocations: number;
  /** Total cost of those spans — an upper bound (shared with the rest of the prompt). */
  spanUsdUpperBound: number;
}

/** Delegated/subagent spend, rolled up by the skill (or subagent type) that ran it.
 *  This cost lives in sidechains with no promptId — invisible on the command leak
 *  board — so a skill like deep-research that does ALL its work in subagents would
 *  otherwise show $0. Keyed by attributionSkill, else attributionAgent. */
export interface SubagentSpend {
  name: string;
  /** True when attributed to a named skill (vs a bare subagent type / direct Task). */
  isSkill: boolean;
  costUsd: number;
  turns: number;
  topModel: string;
  /** Runs premium → the subagent model is a right-sizing lever. */
  modelPinCandidate: boolean;
}

export interface SpendBreakdown {
  totalUsd: number;
  windowDays: number;
  perMonthUsd: number;
  /** Fraction of total $ that hit the unknown-model fallback price (data-quality flag). */
  unpricedShare: number;
  byModel: ModelSpend[];
  byProject: Array<{ project: string; costUsd: number }>;
  commandLeakBoard: CommandSpend[];
  commandTotalUsd: number;
  /** Delegated subagent spend, by skill/subagent type (was hidden in nonCommand). */
  subagentLeakBoard: SubagentSpend[];
  subagentTotalUsd: number;
  /** Skills the model invoked via natural language — undercounted by the leak board. */
  modelInvokedSkills: ModelInvokedSkill[];
  /** Main-chain prompt spend that isn't a slash-command or a subagent. */
  nonCommandUsd: number;
}

const FORK_TURNS_THRESHOLD = 10; // ≥10 turns/invocation = heavy enough to isolate
// Input-side context tokens ÷ output tokens, above which a command's cost is
// dominated by re-passing context rather than producing work. Tuned on real data:
// commit-push-pr 265× / cli-release 247× / compact 166× trip it; foo 83× and
// ordinary commands stay below. The fix for these is restructuring (run earlier /
// leaner context), NOT a cheaper model — the tokens, not the tier, are the cost.
const CONTEXT_TAX_RATIO_THRESHOLD = 120;
// Server-controlled commands: the model that runs them is chosen by Claude Code,
// not the user, so "pin a cheaper model" is non-actionable advice for them.
const SYSTEM_COMMANDS = new Set(['compact', 'clear']);

export function attributeSpend(sessions: Session[]): SpendBreakdown {
  const byModel = new Map<string, { cost: number; turns: number; tokens: number }>();
  const byProject = new Map<string, number>();
  const byCommand = new Map<
    string,
    {
      cost: number;
      invocations: number;
      turns: number;
      models: Map<string, number>;
      inCtxTokens: number;
      outTokens: number;
    }
  >();
  const bySubagent = new Map<
    string,
    { cost: number; turns: number; models: Map<string, number>; isSkill: boolean }
  >();
  // Skills the model invoked via the Skill tool (no slash marker) → spanUsd upper bound.
  const modelInvoked = new Map<string, { invocations: number; usd: number }>();
  let total = 0;
  let unpriced = 0;
  let commandTotal = 0;
  let subagentTotal = 0;
  let nonCommand = 0;
  let minMtime = Infinity;
  let maxMtime = 0;

  for (const session of sessions) {
    if (session.mtime) {
      minMtime = Math.min(minMtime, session.mtime);
      maxMtime = Math.max(maxMtime, session.mtime);
    }
    for (const span of session.spans) {
      let spanCost = 0;
      for (const turn of span.turns) {
        const { usd, priced } = turnCostUsd(turn.model, turn.usage, turn.ts);
        spanCost += usd;
        total += usd;
        if (!priced) unpriced += usd;
        const m = turn.model ?? 'unknown';
        const mm = byModel.get(m) ?? { cost: 0, turns: 0, tokens: 0 };
        mm.cost += usd;
        mm.turns += 1;
        mm.tokens += turnTokens(turn.usage);
        byModel.set(m, mm);
      }
      byProject.set(session.project, (byProject.get(session.project) ?? 0) + spanCost);
      if (span.isSidechain) {
        // Delegated subagent work — roll up by what spawned it (skill, else type).
        subagentTotal += spanCost;
        const name = span.attributionSkill ?? span.attributionAgent ?? 'subagent';
        const sg = bySubagent.get(name) ?? {
          cost: 0,
          turns: 0,
          models: new Map(),
          isSkill: span.attributionSkill != null,
        };
        sg.cost += spanCost;
        sg.turns += span.turns.length;
        for (const t of span.turns) {
          const m = t.model ?? 'unknown';
          sg.models.set(m, (sg.models.get(m) ?? 0) + 1);
        }
        bySubagent.set(name, sg);
      } else if (span.command) {
        commandTotal += spanCost;
        const c = byCommand.get(span.command) ?? {
          cost: 0,
          invocations: 0,
          turns: 0,
          models: new Map(),
          inCtxTokens: 0,
          outTokens: 0,
        };
        c.cost += spanCost;
        c.invocations += 1;
        c.turns += span.turns.length;
        for (const t of span.turns) {
          const m = t.model ?? 'unknown';
          c.models.set(m, (c.models.get(m) ?? 0) + 1);
          c.inCtxTokens += t.usage.input + t.usage.cacheRead + t.usage.cacheWrite5m + t.usage.cacheWrite1h;
          c.outTokens += t.usage.output;
        }
        byCommand.set(span.command, c);
      } else {
        nonCommand += spanCost;
        // A skill the model invoked by natural language lands here (no slash marker).
        // Surface it so the leak board's slash-only view doesn't hide it. Dedupe per
        // span so a skill invoked twice in one prompt isn't billed the span twice.
        for (const skill of new Set(span.invokedSkills)) {
          const e = modelInvoked.get(skill) ?? { invocations: 0, usd: 0 };
          e.invocations += 1;
          e.usd += spanCost;
          modelInvoked.set(skill, e);
        }
      }
    }
  }

  const windowDays = maxMtime > minMtime ? Math.max(1, (maxMtime - minMtime) / 86_400_000) : 1;
  const safeTotal = total || 1;

  return {
    totalUsd: total,
    windowDays,
    perMonthUsd: (total / windowDays) * 30.44,
    unpricedShare: unpriced / safeTotal,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, costUsd: v.cost, turns: v.turns, tokens: v.tokens, share: v.cost / safeTotal }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byProject: [...byProject.entries()]
      .map(([project, costUsd]) => ({ project, costUsd }))
      .sort((a, b) => b.costUsd - a.costUsd),
    commandLeakBoard: [...byCommand.entries()]
      .map(([command, v]) => {
        const topModel = [...v.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
        const turnsPerInvocation = v.turns / Math.max(1, v.invocations);
        const contextTaxRatio = v.inCtxTokens / Math.max(1, v.outTokens);
        const contextHeavy = contextTaxRatio >= CONTEXT_TAX_RATIO_THRESHOLD;
        const isSystemCommand = SYSTEM_COMMANDS.has(command);
        return {
          command,
          costUsd: v.cost,
          invocations: v.invocations,
          costPerInvocation: v.cost / Math.max(1, v.invocations),
          turnsPerInvocation,
          topModel,
          contextTaxRatio,
          forkCandidate: turnsPerInvocation >= FORK_TURNS_THRESHOLD,
          // Pin only when premium AND the model is the user's to choose. compact/clear
          // run on a server-controlled model, so a pin is non-actionable for them.
          modelPinCandidate: isPremiumModel(topModel) && !isSystemCommand,
          contextHeavy,
          isSystemCommand,
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd),
    commandTotalUsd: commandTotal,
    subagentLeakBoard: [...bySubagent.entries()]
      .map(([name, v]) => {
        const topModel = [...v.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
        return {
          name,
          isSkill: v.isSkill,
          costUsd: v.cost,
          turns: v.turns,
          topModel,
          modelPinCandidate: isPremiumModel(topModel),
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd),
    subagentTotalUsd: subagentTotal,
    modelInvokedSkills: [...modelInvoked.entries()]
      .map(([name, v]) => ({ name, invocations: v.invocations, spanUsdUpperBound: v.usd }))
      .sort((a, b) => b.spanUsdUpperBound - a.spanUsdUpperBound),
    nonCommandUsd: nonCommand,
  };
}
