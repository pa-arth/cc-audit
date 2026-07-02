// Build the minimal per-session FOOTPRINTS sent to the hosted right-sizing judge.
// PRIVACY: only the task gist (the prompt, already truncated to 700 chars by the
// adapter) + structural metadata leave the machine — never code, diffs, file
// contents, or paths (fileCount is a COUNT, tools are names+counts). We only judge
// premium-model, prompt-driven spans (that's where right-sizing savings live).

import type { Session } from './model.js';
import { isPremiumModel, turnCostUsd } from './pricing.js';

export interface SessionFootprint {
  taskGist: string;
  model: string;
  turns: number;
  fileCount: number;
  tools: Record<string, number>;
  costUsd: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A continuation span ("ok continue", "let's do only 2", "next") restates no task
// — the real task was set in an earlier prompt. Judging its gist in isolation is
// meaningless (the judge can only shrug → "sonnet, low confidence"), so these spans
// must not enter the right-sizing sample. Their cost still counts in full
// attribution; we only exclude them from the per-task JUDGMENT.
const CONTINUATION_RE =
  /^(ok|okay|yeah|yep|yes|sure|cool|nice|thanks|continue|go ahead|go on|keep going|proceed|next|do (it|that|this|the|only|both|all)|let'?s |lets |now |also |and |then |perfect|great)\b/i;

// Harness-injected pseudo-prompts that aren't the user's task text at all.
const HARNESS_PREFIXES = ['<command', '<task-notification', '<local-command', '<summary', '<system-reminder'];

export function isJudgeableTask(text: string): boolean {
  const raw = text.trim();
  if (HARNESS_PREFIXES.some((p) => raw.startsWith(p))) return false;
  // Strip leading prompt markers / decoration (❯, >, #, -, *, quotes) so a real
  // task hidden behind them isn't mistaken for a continuation.
  const t = raw.replace(/^[\s>❯#*\-–—"'`]+/, '').trim();
  if (t.length < 15) return false; // too thin to judge a model tier against
  if (CONTINUATION_RE.test(t)) return false;
  return true;
}

export function buildFootprints(sessions: Session[], maxN = 25): SessionFootprint[] {
  const candidates: SessionFootprint[] = [];
  for (const s of sessions) {
    for (const span of s.spans) {
      // PRIVACY: subagent (sidechain) spans carry a MACHINE-GENERATED task prompt
      // that can embed paths/code snippets the model pasted in — unlike a user's own
      // typed prompt. The privacy invariant (no paths/code off the machine) means we
      // must not ship those gists to the judge. Subagent premium spend is still
      // covered by the right-sizing HEADLINE (the premium base in byModel includes
      // sidechain turns); per-task judging of subagents waits on a gist-scrub pass.
      if (span.isSidechain) continue;
      // Real prompt-driven work only: skip slash-command spans (gist is just the
      // command), spans with no genuine task text, and continuation fragments.
      if (span.command) continue;
      if (!span.firstUserText || span.firstUserText.startsWith('<command')) continue;
      if (!isJudgeableTask(span.firstUserText)) continue;
      if (span.turns.length === 0) continue;

      const modelCounts = new Map<string, number>();
      const tools: Record<string, number> = {};
      let costUsd = 0;
      let fileCount = 0;
      for (const t of span.turns) {
        const m = t.model ?? 'unknown';
        modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
        costUsd += turnCostUsd(t.model, t.usage, t.ts).usd;
        for (const tool of t.tools) {
          tools[tool] = (tools[tool] ?? 0) + 1;
          if (EDIT_TOOLS.has(tool)) fileCount += 1;
        }
      }
      const model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      if (!isPremiumModel(model)) continue; // non-premium is already cheap — nothing to right-size

      candidates.push({ taskGist: span.firstUserText, model, turns: span.turns.length, fileCount, tools, costUsd });
    }
  }

  // Stratified sample across the cost distribution (representative, not just the
  // top spenders) so the over-modeled SHARE extrapolates honestly.
  candidates.sort((a, b) => b.costUsd - a.costUsd);
  if (candidates.length <= maxN) return candidates;
  const out: SessionFootprint[] = [];
  for (let i = 0; i < maxN; i++) {
    out.push(candidates[Math.round((i / (maxN - 1)) * (candidates.length - 1))]!);
  }
  return out;
}
