// Calibration harness for the FLUENCY score (sibling to label.ts's right-sizing one).
//
// Flow: `cc-audit label-fluency` writes a sheet — one row per substantive session,
// with that session's 7 signals + a redacted gist — and you set `trueFluency` 0-100
// on each (your expert judgment of how fluently AI was used). `cc-audit score-fluency
// <sheet>` then fits the SERVER's per-signal shapes to your labels and prints the
// fitted weights to transcribe into the gated server formula, plus fit quality.
//
// Local-only: no network. The sheet holds your own gists — keep it on your machine.

import { computeSessionFluencySignals, isSubstantiveSession, type SessionFluencySignals } from './fluency.js';
import type { Session } from './model.js';
import { turnCostUsd } from './pricing.js';

export interface FluencyLabelRow {
  id: number;
  taskGist: string; // first user prompt of the session, redacted to one short line
  topModel: string;
  totalTurns: number;
  costUsd: number;
  signals: SessionFluencySignals;
  /** YOU fill this: 0-100, how fluently AI was used in this session. null skips the row. */
  trueFluency: number | null;
  note?: string;
}

function redactGist(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
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
    for (const t of span.turns) usd += turnCostUsd(t.model, t.usage).usd;
  }
  return usd;
}

function sessionGist(session: Session): string {
  const span = session.spans.find((s) => !s.isSidechain && s.firstUserText.trim());
  return redactGist(span?.firstUserText ?? '(no prompt text)');
}

/** Build the labeling sheet: one fillable row per substantive session. */
export function buildFluencySheet(sessions: Session[], limit = 60): FluencyLabelRow[] {
  return sessions
    .filter(isSubstantiveSession)
    .slice(0, limit)
    .map((s, i) => ({
      id: i,
      taskGist: sessionGist(s),
      topModel: sessionTopModel(s),
      totalTurns: s.spans.reduce((n, sp) => n + (sp.isSidechain ? 0 : sp.turns.length), 0),
      costUsd: Number(sessionCostUsd(s).toFixed(4)),
      signals: computeSessionFluencySignals(s),
      trueFluency: null,
    }));
}

// ── Shape transforms — MUST MIRROR backend apps/api/src/lib/fluencyScore.ts ───────
// The fit learns WEIGHTS over these fixed sub-scores; the weights are only valid
// server-side if these shapes match. If you change one here, change it there too.
const PLAN_SATURATION = 0.5;
const PLAN_FLOOR = 0.15;
const TURN_PEAK_LO = 2;
const TURN_PEAK_HI = 5;
const TURN_GRIND = 20;
const P90_CEILING = 40;
const CTX_PEAK = 0.2;
const CTX_HALFWIDTH = 0.6;
const SUBAGENT_SATURATION = 0.2;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function medianTurnScore(median: number): number {
  if (median >= TURN_PEAK_LO && median <= TURN_PEAK_HI) return 1;
  if (median < TURN_PEAK_LO) return 0.5 + (0.5 * median) / TURN_PEAK_LO;
  return clamp01(1 - (median - TURN_PEAK_HI) / (TURN_GRIND - TURN_PEAK_HI));
}

/** The 4 server sub-scores for one session's signals: [plan, turn, context, leverage]. */
export function subScores(s: SessionFluencySignals): [number, number, number, number] {
  const plan = PLAN_FLOOR + (1 - PLAN_FLOOR) * clamp01(s.planModeRate / PLAN_SATURATION);
  const tail = clamp01(1 - Math.max(0, (s.p90TurnsPerTask - P90_CEILING) / P90_CEILING));
  const turn = 0.6 * medianTurnScore(s.medianTurnsPerTask) + 0.4 * tail;
  const context = clamp01(1 - Math.abs(s.contextBloatRate - CTX_PEAK) / CTX_HALFWIDTH);
  const leverage = clamp01(s.subagentUsageRate / SUBAGENT_SATURATION);
  return [plan, turn, context, leverage];
}

// ── Fit ──────────────────────────────────────────────────────────────────────────
export interface FitResult {
  n: number;
  weights: { plan: number; turn: number; context: number; leverage: number };
  rmse: number; // on the 0-100 scale
  r2: number;
  spearman: number;
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = Array.from<number>({ length: xs.length });
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j < idx.length && idx[j]![0] === idx[i]![0]) j += 1;
      const avg = (i + j - 1) / 2 + 1; // average rank for ties (1-based)
      for (let k = i; k < j; k += 1) r[idx[k]![1]] = avg;
      i = j;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / n;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (ra[i]! - ma) * (rb[i]! - mb);
    va += (ra[i]! - ma) ** 2;
    vb += (rb[i]! - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/**
 * Fit non-negative weights (summing to 1) over the 4 sub-scores to predict
 * trueFluency, by grid search over the simplex at 0.05 resolution. Dependency-free,
 * deterministic, and robust for the ~50-point single-rater regime — we deliberately
 * do NOT free-fit a richer model that would overfit. Unlabeled rows are ignored.
 */
export function fitFluencyWeights(rows: FluencyLabelRow[]): FitResult | null {
  const labeled = rows.filter(
    (r) => typeof r.trueFluency === 'number' && r.trueFluency >= 0 && r.trueFluency <= 100,
  );
  if (labeled.length < 5) return null;
  const X = labeled.map((r) => subScores(r.signals));
  const y = labeled.map((r) => r.trueFluency as number);
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0) || 1;

  const STEP = 20; // 0.05 resolution → integer weights summing to 20
  let best = { rmse: Infinity, w: [0.25, 0.25, 0.25, 0.25], pred: [] as number[] };
  for (let i = 0; i <= STEP; i += 1) {
    for (let j = 0; i + j <= STEP; j += 1) {
      for (let k = 0; i + j + k <= STEP; k += 1) {
        const l = STEP - i - j - k;
        const w = [i / STEP, j / STEP, k / STEP, l / STEP];
        let ssRes = 0;
        const pred: number[] = [];
        for (let r = 0; r < X.length; r += 1) {
          const p = 100 * (w[0]! * X[r]![0] + w[1]! * X[r]![1] + w[2]! * X[r]![2] + w[3]! * X[r]![3]);
          pred.push(p);
          ssRes += (p - y[r]!) ** 2;
        }
        const rmse = Math.sqrt(ssRes / X.length);
        if (rmse < best.rmse) best = { rmse, w, pred };
      }
    }
  }
  const ssRes = best.rmse * best.rmse * X.length;
  return {
    n: labeled.length,
    weights: { plan: best.w[0]!, turn: best.w[1]!, context: best.w[2]!, leverage: best.w[3]! },
    rmse: best.rmse,
    r2: 1 - ssRes / ssTot,
    spearman: spearman(best.pred, y),
  };
}

export function renderFluencyFit(fit: FitResult | null): string {
  const out: string[] = [''];
  out.push('  FLUENCY CALIBRATION  (server shapes fit to your labels)');
  out.push('═'.repeat(64));
  if (!fit) {
    out.push('  Need ≥5 labeled rows (set "trueFluency" 0-100), then re-run.');
    out.push('═'.repeat(64));
    return out.join('\n');
  }
  const w = fit.weights;
  out.push(`  labeled rows: ${fit.n}`);
  out.push(`  fit:  RMSE ${fit.rmse.toFixed(1)}/100 · R² ${fit.r2.toFixed(2)} · Spearman ${fit.spearman.toFixed(2)}`);
  out.push('');
  out.push('  fitted weights (transcribe into backend fluencyScore.ts WEIGHTS):');
  out.push(`    plan: ${w.plan.toFixed(2)}  turn: ${w.turn.toFixed(2)}  context: ${w.context.toFixed(2)}  leverage: ${w.leverage.toFixed(2)}`);
  out.push('');
  if (fit.n < 30) out.push('  ⚠ single-rater, small sample — treat as DIRECTIONAL, not validated.');
  if (fit.spearman < 0.5) out.push('  ⚠ low rank-correlation — the 7 signals may not capture what you label as fluent.');
  out.push('═'.repeat(64));
  return out.join('\n');
}
