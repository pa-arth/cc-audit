// Diagnostic labeling harness for FLUENCY (sibling to label.ts's right-sizing one).
//
// Flow: `cc-audit label-fluency` writes a sheet — one row per substantive session,
// showing the PROMPT TRAJECTORY (the ordered prompts YOU typed to drive the agent,
// redacted of pasted code) plus that session's signals. You read the trajectory and
// set `trueBand` (Poor | Developing | Strong | Elite) — your holistic judgment of how
// fluently the session was driven. `cc-audit score-fluency <sheet>` summarizes what
// you labeled. These bands are the GROUND TRUTH we validate a cheap classifier
// against (the cheap read can't be judged from aggregates — fluency lives in the
// trajectory, which is why the sheet shows it).
//
// Local-only: no network. The sheet holds your own prompt text — keep it on your machine.

import { computeSessionFluencySignals, isSubstantiveSession, type SessionFluencySignals } from './fluency.js';
import type { Session } from './model.js';
import { turnCostUsd } from './pricing.js';

export type FluencyBandLabel = 'Poor' | 'Developing' | 'Strong' | 'Elite';
export const FLUENCY_BANDS: FluencyBandLabel[] = ['Poor', 'Developing', 'Strong', 'Elite'];

export interface FluencyLabelRow {
  id: number;
  taskGist: string; // first prompt, one line — for a quick scan
  promptTrajectory: string[]; // the ordered prompts you typed (redacted) — judge from THIS
  topModel: string;
  totalTurns: number;
  costUsd: number;
  signals: SessionFluencySignals;
  /** YOU fill this: "Poor" | "Developing" | "Strong" | "Elite". null skips the row. */
  trueBand: FluencyBandLabel | null;
  note?: string;
}

// Strip fenced code blocks + hook/system-tag blocks (a hook can APPEND e.g. a
// <system-reminder>…</system-reminder> to a genuine prompt) + collapse + truncate.
// We keep the human's FRAMING/STEERING words (where fluency shows), not pasted
// code/output or injected system text.
function redactPrompt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(
      /<(task-notification|command-message|command-name|command-args|local-command-[a-z]*|system-reminder|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const TRAJECTORY_CAP = 30;

// The ordered prompts the human typed (one per non-sidechain span) — the trajectory
// of how they drove the agent. Capped; a trailing marker notes truncation.
function sessionPromptTrajectory(session: Session): string[] {
  const prompts = session.spans
    .filter((s) => !s.isSidechain && s.firstUserText.trim())
    .map((s) => redactPrompt(s.firstUserText))
    .filter((t) => t.length > 0);
  if (prompts.length <= TRAJECTORY_CAP) return prompts;
  return [...prompts.slice(0, TRAJECTORY_CAP), `… (+${prompts.length - TRAJECTORY_CAP} more prompts)`];
}

function sessionTopModel(session: Session): string {
  const counts = new Map<string, number>();
  for (const span of session.spans) {
    for (const t of span.turns) {
      if (t.model) counts.set(t.model, (counts.get(t.model) ?? 0) + 1);
    }
  }
  let top = '—';
  let max = 0;
  for (const [m, c] of counts) {
    if (c > max) {
      max = c;
      top = m;
    }
  }
  return top.replace(/^claude-/, '');
}

function sessionCostUsd(session: Session): number {
  let usd = 0;
  for (const span of session.spans) {
    for (const t of span.turns) usd += turnCostUsd(t.model, t.usage, t.ts).usd;
  }
  return usd;
}

/** Build the labeling sheet: one judge-able row per substantive session. */
export function buildFluencySheet(sessions: Session[], limit = 60): FluencyLabelRow[] {
  return sessions
    .filter(isSubstantiveSession)
    .slice(0, limit)
    .map((s, i) => {
      const trajectory = sessionPromptTrajectory(s);
      return {
        id: i,
        taskGist: trajectory[0] ?? '(no prompt text)',
        promptTrajectory: trajectory,
        topModel: sessionTopModel(s),
        totalTurns: s.spans.reduce((n, sp) => n + (sp.isSidechain ? 0 : sp.turns.length), 0),
        costUsd: Number(sessionCostUsd(s).toFixed(4)),
        signals: computeSessionFluencySignals(s),
        trueBand: null,
      };
    });
}

// ── Label summary (the diagnostic readout) ──────────────────────────────────────
export interface BandSummary {
  labeled: number;
  unlabeled: number;
  counts: Record<FluencyBandLabel, number>;
}

export function summarizeBands(rows: FluencyLabelRow[]): BandSummary {
  const counts: Record<FluencyBandLabel, number> = { Poor: 0, Developing: 0, Strong: 0, Elite: 0 };
  let labeled = 0;
  for (const r of rows) {
    if (r.trueBand && FLUENCY_BANDS.includes(r.trueBand)) {
      counts[r.trueBand] += 1;
      labeled += 1;
    }
  }
  return { labeled, unlabeled: rows.length - labeled, counts };
}

export function renderBandSummary(s: BandSummary): string {
  const out: string[] = [''];
  out.push('  FLUENCY LABELS  (your ground-truth bands)');
  out.push('═'.repeat(56));
  out.push(`  labeled: ${s.labeled}   (unlabeled rows skipped: ${s.unlabeled})`);
  if (s.labeled === 0) {
    out.push('  Nothing labeled yet — read each row\'s promptTrajectory and set');
    out.push('  "trueBand" to Poor | Developing | Strong | Elite, then re-run.');
    out.push('═'.repeat(56));
    return out.join('\n');
  }
  out.push('');
  for (const b of FLUENCY_BANDS) {
    const n = s.counts[b];
    out.push(`    ${b.padEnd(11)} ${String(n).padStart(3)}  ${'▇'.repeat(n)}`);
  }
  out.push('');
  if (s.labeled < 20) out.push('  Aim for ≥20 labels (spread across bands) for a usable diagnostic.');
  out.push('  Next: we run the cheap LLM-band judge on these same sessions and');
  out.push('  measure how often it agrees with your labels.');
  out.push('═'.repeat(56));
  return out.join('\n');
}
