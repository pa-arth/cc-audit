// Calibration harness for the right-sizing judge (the USEFUL gate).
//
// Flow: `cc-audit label` judges your real premium sessions and writes a sheet you
// fill in by hand (set `trueMinTier` on each row). `cc-audit score <sheet>` then
// compares the judge to your labels. The headline metric is PRECISION of the
// over-modeled calls — a false "downgrade this" is the screenshot-able failure, so
// we optimize precision over recall. Ship gate: precision ≥ 0.90.

import type { SessionFootprint } from './footprint.js';
import { judgeFootprints, type Verdict } from './judgeClient.js';

// Three tiers — opus & fable collapse to "frontier" (model choice within frontier
// is policy, not waste; we don't grade Fable-vs-Opus). Labels accept the legacy
// 'opus'/'fable' too and fold them to frontier, so old sheets still score.
export type Tier = 'haiku' | 'sonnet' | 'frontier';
export const TIER_ORDER: Record<Tier, number> = { haiku: 0, sonnet: 1, frontier: 2 };
const ALL_LABELS = new Set(['haiku', 'sonnet', 'frontier', 'opus', 'fable']);

/** Fold any tier/model label (incl. legacy opus/fable) to the 3-tier scheme. */
export function toTier(label: string): Tier {
  const m = label.toLowerCase();
  if (m.includes('haiku') || m.includes('mini')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return 'frontier'; // opus, fable, mythos, gpt-5.x, "frontier", unknowns
}

/** Map an actual model id to its tier. Mirrors the server's modelTier. */
export function modelTier(model: string): Tier {
  return toTier(model);
}

/** A tier label as it may appear in a sheet: canonical, or legacy opus/fable. */
type TierLabel = Tier | 'opus' | 'fable';

/** One labeling row: the footprint, the judge's call, and your ground truth. */
export interface LabelRow {
  id: number;
  taskGist: string;
  model: string;
  actualTier: Tier;
  turns: number;
  fileCount: number;
  costUsd: number;
  judge: { minTier: TierLabel; confidence: Verdict['confidence']; reason: string; overModeled: boolean };
  /** YOU fill this in: the minimum tier you'd actually trust for this task.
   *  Leave null to skip a row. One of: "haiku" | "sonnet" | "frontier"
   *  (legacy "opus"/"fable" are folded to "frontier"). */
  trueMinTier: TierLabel | null;
  /** Optional free-text note on why (kept local — never sent anywhere). */
  note?: string;
}

const ENDPOINT_CAP = 25; // /v1/public/cost-audit caps sessions per request

/** Judge footprints in ≤25-session batches (the endpoint's per-request cap). */
async function judgeBatched(footprints: SessionFootprint[], apiBase?: string): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (let i = 0; i < footprints.length; i += ENDPOINT_CAP) {
    const chunk = footprints.slice(i, i + ENDPOINT_CAP);
    const res = apiBase ? await judgeFootprints(chunk, apiBase) : await judgeFootprints(chunk);
    verdicts.push(...res.verdicts);
  }
  return verdicts;
}

/** Build the labeling sheet: judge each footprint, pair into a fillable row. */
export async function buildLabelSheet(
  footprints: SessionFootprint[],
  apiBase?: string,
): Promise<LabelRow[]> {
  const verdicts = await judgeBatched(footprints, apiBase);
  return footprints.map((f, i) => {
    const v = verdicts[i];
    return {
      id: i,
      taskGist: f.taskGist,
      model: f.model,
      actualTier: modelTier(f.model),
      turns: f.turns,
      fileCount: f.fileCount,
      costUsd: Number(f.costUsd.toFixed(4)),
      judge: {
        minTier: v?.minTier ?? modelTier(f.model),
        confidence: v?.confidence ?? 'low',
        reason: v?.reason ?? '(no verdict)',
        overModeled: v?.overModeled ?? false,
      },
      trueMinTier: null,
    };
  });
}

export interface ScoreResult {
  labeled: number;
  unlabeled: number;
  /** Of the rows the JUDGE flagged over-modeled, share you AGREE were over-modeled. */
  precision: number;
  /** Of the rows YOU flagged over-modeled, share the judge caught. */
  recall: number;
  /** Share of labeled rows where judge.minTier === trueMinTier. */
  exactTierAccuracy: number;
  /** Share where judge.minTier is within one tier of yours. */
  withinOneTierAccuracy: number;
  /** Direction agreement: judge & you agree on over / right / under-modeled. */
  directionAccuracy: number;
  counts: { tp: number; fp: number; fn: number; tn: number };
  /** The dangerous failures: judge said "downgrade" but you disagreed. */
  falseDowngrades: Array<{ id: number; taskGist: string; model: string; judgeTier: Tier; trueTier: Tier; reason: string }>;
  /** judge tier (row) × true tier (col) confusion matrix. */
  confusion: Record<Tier, Record<Tier, number>>;
  passesGate: boolean;
}

const GATE_PRECISION = 0.9;

function emptyConfusion(): Record<Tier, Record<Tier, number>> {
  const all: Tier[] = ['haiku', 'sonnet', 'frontier'];
  const m = {} as Record<Tier, Record<Tier, number>>;
  for (const r of all) {
    m[r] = { haiku: 0, sonnet: 0, frontier: 0 };
  }
  return m;
}

/** Score a (partially) labeled sheet against the judge. Unlabeled rows are ignored. */
export function scoreLabels(rows: LabelRow[]): ScoreResult {
  const labeled = rows.filter((r) => r.trueMinTier != null && ALL_LABELS.has(r.trueMinTier.toLowerCase()));
  const unlabeled = rows.length - labeled.length;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let exact = 0;
  let withinOne = 0;
  let directionAgree = 0;
  const falseDowngrades: ScoreResult['falseDowngrades'] = [];
  const confusion = emptyConfusion();

  for (const r of labeled) {
    // Fold every label (incl. legacy opus/fable) to the 3-tier scheme.
    const trueTier = toTier(r.trueMinTier!);
    const judgeTier = toTier(r.judge.minTier);
    const actual = TIER_ORDER[toTier(r.actualTier)];
    // "Over-modeled" = a tier strictly below the model that actually ran.
    const judgeOver = TIER_ORDER[judgeTier] < actual;
    const trueOver = TIER_ORDER[trueTier] < actual;

    if (judgeOver && trueOver) tp += 1;
    else if (judgeOver && !trueOver) {
      fp += 1;
      falseDowngrades.push({
        id: r.id,
        taskGist: r.taskGist,
        model: r.model,
        judgeTier,
        trueTier,
        reason: r.judge.reason,
      });
    } else if (!judgeOver && trueOver) fn += 1;
    else tn += 1;

    if (judgeTier === trueTier) exact += 1;
    if (Math.abs(TIER_ORDER[judgeTier] - TIER_ORDER[trueTier]) <= 1) withinOne += 1;

    const dir = (t: number) => (t < actual ? -1 : t > actual ? 1 : 0);
    if (dir(TIER_ORDER[judgeTier]) === dir(TIER_ORDER[trueTier])) directionAgree += 1;

    confusion[judgeTier][trueTier] += 1;
  }

  const n = labeled.length || 1;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1; // no positives → vacuously precise
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;

  return {
    labeled: labeled.length,
    unlabeled,
    precision,
    recall,
    exactTierAccuracy: exact / n,
    withinOneTierAccuracy: withinOne / n,
    directionAccuracy: directionAgree / n,
    counts: { tp, fp, fn, tn },
    falseDowngrades,
    confusion,
    passesGate: tp + fp >= 5 && precision >= GATE_PRECISION,
  };
}

const tiers: Tier[] = ['haiku', 'sonnet', 'frontier'];
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Human-readable scorecard. */
export function renderScore(s: ScoreResult): string {
  const out: string[] = [];
  out.push('');
  out.push('  RIGHT-SIZING CALIBRATION  (judge vs your labels)');
  out.push('═'.repeat(64));
  out.push(`  labeled: ${s.labeled}   (unlabeled rows skipped: ${s.unlabeled})`);
  if (s.labeled === 0) {
    out.push('  Nothing labeled yet — set `trueMinTier` on rows in the sheet, then re-run.');
    out.push('═'.repeat(64));
    return out.join('\n');
  }
  const gate = s.passesGate ? 'PASS ✓' : s.counts.tp + s.counts.fp < 5 ? 'need ≥5 over-modeled calls' : 'FAIL ✗';
  out.push('');
  out.push(`  PRECISION (over-modeled calls):  ${pct(s.precision)}   gate ≥90% → ${gate}`);
  out.push(`    of ${s.counts.tp + s.counts.fp} "downgrade" calls, ${s.counts.tp} you agreed, ${s.counts.fp} were false`);
  out.push(`  recall (caught your over-modeled): ${pct(s.recall)}`);
  out.push(`  exact-tier match: ${pct(s.exactTierAccuracy)} · within-one: ${pct(s.withinOneTierAccuracy)} · direction: ${pct(s.directionAccuracy)}`);
  out.push('');
  if (s.falseDowngrades.length > 0) {
    out.push('  ⚠ FALSE DOWNGRADES (judge said cheaper, you disagreed — fix these first):');
    for (const f of s.falseDowngrades.slice(0, 10)) {
      out.push(`    #${f.id} ${f.model.replace('claude-', '')}→${f.judgeTier} (you: ${f.trueTier})  ${f.taskGist.replace(/\s+/g, ' ').slice(0, 40)}`);
      out.push(`        judge: "${f.reason.slice(0, 56)}"`);
    }
    out.push('');
  }
  out.push('  CONFUSION  (rows = judge tier, cols = your tier)');
  out.push(`           ${tiers.map((t) => t.slice(0, 6).padStart(6)).join(' ')}`);
  for (const r of tiers) {
    out.push(`    ${r.padEnd(6)} ${tiers.map((c) => String(s.confusion[r][c]).padStart(6)).join(' ')}`);
  }
  out.push('═'.repeat(64));
  out.push('');
  return out.join('\n');
}
