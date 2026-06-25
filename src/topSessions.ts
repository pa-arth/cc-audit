// "Top spenders" — the N most expensive sessions (of the ones we read), with enough
// structure to recognize each: task gist, model, turns, cost, plan-mode, and a compact
// trajectory. PRIVACY: taskGist + project are RAW (the user's prompt / repo label), so
// this is LOCAL-ONLY — it is rendered in the TUI but must NEVER enter the aggregate that
// `--open` uploads (the shared report carries shares/counts, never prompts or $).

import type { Session, Span } from './model.js';
import { turnCostUsd } from './pricing.js';

export interface TopSession {
  /** RAW first user prompt of the priciest span — LOCAL ONLY, never uploaded. */
  taskGist: string;
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
 *  session doesn't overflow the line. */
function sparkline(values: number[]): string {
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
  for (const t of span.turns) usd += turnCostUsd(t.model, t.usage).usd;
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

/** Pick the gist that best NAMES the session: the first substantive task prompt (the
 *  one that kicked off the work), falling back to the priciest span's text, its
 *  slash-command, then anything non-empty. */
function pickGist(mainSpans: Span[]): string {
  for (const s of mainSpans) {
    const t = s.firstUserText?.trim();
    if (t && isTaskPrompt(t)) return t;
  }
  const ranked = [...mainSpans].sort((a, b) => spanCost(b) - spanCost(a));
  for (const s of ranked) {
    const t = s.firstUserText?.trim();
    if (t && !t.startsWith('<')) return t;
    if (s.command) return `/${s.command}`;
  }
  return ranked[0]?.firstUserText?.trim() || '(no prompt text)';
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
        costUsd += turnCostUsd(t.model, t.usage).usd;
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
    rows.push({
      taskGist: pickGist(mainSpans.length ? mainSpans : s.spans),
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
