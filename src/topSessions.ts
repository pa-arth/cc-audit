// "Top spenders" — the N most expensive sessions (of the ones we read), with enough
// structure to recognize each: task gist, model, turns, cost, plan-mode, and a compact
// trajectory. PRIVACY: taskGist + project are RAW (the user's prompt / repo label), so
// this is LOCAL-ONLY — it is rendered in the TUI but must NEVER enter the aggregate that
// `--open` uploads (the shared report carries shares/counts, never prompts or $).

import type { Session, Span } from './model.js';
import { turnCostUsd } from './pricing.js';

/** One unit of work inside a session, with what it actually cost. A "session" file is
 *  routinely split by compaction into several unrelated contexts, so per-prompt cost is
 *  what tells you where the money went — the file's first prompt does not. RAW gist →
 *  LOCAL ONLY, never uploaded. */
export interface PromptCost {
  /** Meaningful label: this prompt's own task text, or the nearest preceding task prompt
   *  in the SAME context segment (never inherited across a compaction reset). */
  gist: string;
  costUsd: number;
  /** Assistant turns rolled into this task (spans sharing the label are merged). */
  turns: number;
}

export interface TopSession {
  /** RAW label of the priciest TASK in the session (not the file's first prompt) — names
   *  the work that actually drove the cost. LOCAL ONLY, never uploaded. */
  taskGist: string;
  /** The session's costliest tasks, each labeled + priced — the per-prompt drill-down.
   *  RAW gists, LOCAL ONLY. Ordered by cost, descending. */
  topPrompts: PromptCost[];
  /** Most-used model across the session's turns. */
  topModel: string;
  turns: number;
  costUsd: number;
  /** Session ever entered plan mode (a fluency signal — cheap exploration up front). */
  planMode: boolean;
  /** Main-chain user prompts in the session (spans). */
  prompts: number;
  /** Compact turns-per-prompt sparkline — the shape of the back-and-forth. */
  trajectory: string;
  /** Top tools by call count, e.g. "Edit·Bash·Read". */
  topTools: string;
  /** Project label — RAW, LOCAL ONLY. */
  project: string;
}

const BARS = '▁▂▃▄▅▆▇█';
const MAX_BARS = 24; // keep the trajectory inside the report's column width

/** Turns-per-prompt sparkline, max-pooled into <= MAX_BARS buckets so a 60-prompt
 *  session doesn't overflow the line. Also renders the weekly-spend line in the report. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  let v = values;
  if (values.length > MAX_BARS) {
    v = [];
    const step = values.length / MAX_BARS;
    for (let i = 0; i < MAX_BARS; i++) {
      const slice = values.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
      v.push(Math.max(...slice));
    }
  }
  const max = Math.max(...v, 1);
  return v.map((x) => BARS[Math.min(BARS.length - 1, Math.round((x / max) * (BARS.length - 1)))]).join('');
}

function spanCost(span: Span): number {
  let usd = 0;
  for (const t of span.turns) usd += turnCostUsd(t.model, t.usage, t.ts).usd;
  return usd;
}

// A continuation ("ok continue", "yes do that") restates no task — a poor session
// label even if it's the priciest span. Prefer the prompt that STARTED the work.
const CONTINUATION = /^(ok|okay|yeah|yep|yes|sure|cool|nice|continue|go ahead|go on|keep going|proceed|next|also|and|then|now|do (it|that|this|the|both|all)|let'?s |lets |perfect|great|thanks)\b/i;

function isTaskPrompt(text: string): boolean {
  if (!text || text.startsWith('<')) return false;
  const t = text.replace(/^[\s>❯#*\-–—"'`]+/, '').trim();
  return t.length >= 15 && !CONTINUATION.test(t);
}

/** Label a span by the task it belongs to: its own text if substantive, else the nearest
 *  preceding task prompt in the SAME context segment. `lastTask` is reset by the caller at
 *  every compaction boundary so a continuation never inherits a label from before a reset. */
function spanLabel(span: Span, lastTask: string | null): string {
  const own = span.firstUserText?.trim();
  if (own && isTaskPrompt(own)) return own;
  if (lastTask) return lastTask;
  if (span.command) return `/${span.command}`;
  if (own && !own.startsWith('<')) return own;
  return '(continuation)';
}

/** Break a session into its costly TASKS. We walk the main chain in order, label each span
 *  by its task (carrying the last task forward but RESETTING at every compaction boundary —
 *  past that point the work is unrelated), then merge spans that share a label so one task
 *  spread over many prompts shows as a single priced line. Returns tasks sorted by cost. */
function taskBreakdown(mainSpans: Span[]): PromptCost[] {
  const byLabel = new Map<string, PromptCost>();
  const order: string[] = [];
  let lastTask: string | null = null;
  for (const span of mainSpans) {
    // A compacted span opens a fresh context — drop the carried task so nothing leaks across.
    if (span.autoCompacted) lastTask = null;
    const label = spanLabel(span, lastTask);
    if (span.firstUserText?.trim() && isTaskPrompt(span.firstUserText.trim())) lastTask = label;
    const cost = spanCost(span);
    let row = byLabel.get(label);
    if (!row) {
      row = { gist: label, costUsd: 0, turns: 0 };
      byLabel.set(label, row);
      order.push(label);
    }
    row.costUsd += cost;
    row.turns += span.turns.length;
    // A manual `/compact` is a context reset too (auto-compaction is caught above via
    // `autoCompacted`). After it, the carried task is gone — don't bleed it forward.
    if (span.command === 'compact' || span.command === 'clear') lastTask = null;
  }
  // Stable sort: cost desc, ties keep first-seen order (so a single-task session keeps its
  // opening prompt as the headline rather than an arbitrary equal-cost later prompt).
  return order
    .map((l) => byLabel.get(l)!)
    .sort((a, b) => b.costUsd - a.costUsd || order.indexOf(a.gist) - order.indexOf(b.gist));
}

export function topSessions(sessions: Session[], n = 5): TopSession[] {
  const rows: TopSession[] = [];
  for (const s of sessions) {
    const mainSpans = s.spans.filter((sp) => !sp.isSidechain);
    let costUsd = 0;
    let turns = 0;
    const modelTurns = new Map<string, number>();
    const toolCounts = new Map<string, number>();
    for (const span of s.spans) {
      for (const t of span.turns) {
        // Cost counts ALL turns (incl. subagents); structure summarizes the main chain.
        costUsd += turnCostUsd(t.model, t.usage, t.ts).usd;
        turns += 1;
        const m = t.model ?? 'unknown';
        modelTurns.set(m, (modelTurns.get(m) ?? 0) + 1);
        for (const tool of t.tools) toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
    }
    if (turns === 0) continue;
    const topModel = [...modelTurns.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const topTools =
      [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t)
        .join('·') || '—';
    const tasks = taskBreakdown(mainSpans.length ? mainSpans : s.spans);
    rows.push({
      // Headline names the priciest TASK, not the file's first prompt (which, after a
      // compaction or two, may be unrelated to where the money actually went).
      taskGist: tasks[0]?.gist || '(no prompt text)',
      topPrompts: tasks.filter((t) => t.costUsd > 0).slice(0, 3),
      topModel,
      turns,
      costUsd,
      planMode: s.modes.includes('plan'),
      prompts: mainSpans.length,
      trajectory: sparkline(mainSpans.map((sp) => sp.turns.length)),
      topTools,
      project: s.project,
    });
  }
  return rows.sort((a, b) => b.costUsd - a.costUsd).slice(0, n);
}

/** The leaderboard stripped to what may leave the machine for the shared web report:
 *  cost SHARE (never raw $), structure, and shape — NO gist, NO project, NO dollars.
 *  Only included in the aggregate when the user opts in via --share-sessions. */
export interface AnonTopSession {
  /** Session cost as a share of total spend (0..1) — a share, never a raw amount. */
  costShare: number;
  turns: number;
  prompts: number;
  /** Claude model id (e.g. claude-opus-4-8) — not user data; already shipped elsewhere. */
  topModel: string;
  planMode: boolean;
  /** Sparkline shape only — no content. */
  trajectory: string;
}

export function anonymizeTopSessions(rows: TopSession[], totalUsd: number): AnonTopSession[] {
  const denom = totalUsd || 1;
  return rows.map((r) => ({
    costShare: r.costUsd / denom,
    turns: r.turns,
    prompts: r.prompts,
    topModel: r.topModel,
    planMode: r.planMode,
    trajectory: r.trajectory,
  }));
}
