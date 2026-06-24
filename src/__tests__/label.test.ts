import { describe, it, expect } from 'vitest';
import { scoreLabels, modelTier, type LabelRow } from '../label.js';

const row = (over: Partial<LabelRow> & { judgeTier: LabelRow['judge']['minTier']; trueMinTier: LabelRow['trueMinTier']; model?: string }): LabelRow => {
  const model = over.model ?? 'claude-opus-4-8';
  const actualTier = modelTier(model);
  const order = { haiku: 0, sonnet: 1, opus: 2, fable: 2, frontier: 2 } as const;
  return {
    id: over.id ?? 0,
    taskGist: over.taskGist ?? 'some task',
    model,
    actualTier,
    turns: 5,
    fileCount: 1,
    costUsd: 10,
    judge: {
      minTier: over.judgeTier,
      confidence: 'high',
      reason: 'because',
      overModeled: order[over.judgeTier] < order[actualTier],
    },
    trueMinTier: over.trueMinTier,
  };
};

describe('modelTier', () => {
  it('maps ids to three tiers (opus + fable collapse to frontier)', () => {
    expect(modelTier('claude-opus-4-8')).toBe('frontier');
    expect(modelTier('claude-fable-5')).toBe('frontier');
    expect(modelTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelTier('claude-haiku-4-5')).toBe('haiku');
  });
});

describe('scoreLabels', () => {
  it('counts a true positive (judge & human both call opus→sonnet over-modeled)', () => {
    const s = scoreLabels([row({ judgeTier: 'sonnet', trueMinTier: 'sonnet' })]);
    expect(s.counts).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 0 });
    expect(s.precision).toBe(1);
    expect(s.exactTierAccuracy).toBe(1);
  });

  it('counts a false downgrade (judge says cheaper, human keeps frontier) and surfaces it', () => {
    const s = scoreLabels([row({ id: 7, judgeTier: 'sonnet', trueMinTier: 'frontier', taskGist: 'gnarly race condition' })]);
    expect(s.counts).toMatchObject({ tp: 0, fp: 1 });
    expect(s.precision).toBe(0);
    expect(s.falseDowngrades).toHaveLength(1);
    expect(s.falseDowngrades[0]).toMatchObject({ id: 7, judgeTier: 'sonnet', trueTier: 'frontier' });
  });

  it('folds legacy opus/fable labels to frontier when scoring', () => {
    // judge sonnet, human labeled "opus" (old sheet) → folds to frontier → false downgrade.
    const s = scoreLabels([row({ id: 1, judgeTier: 'sonnet', trueMinTier: 'opus' as never })]);
    expect(s.counts).toMatchObject({ tp: 0, fp: 1 });
    expect(s.falseDowngrades[0]).toMatchObject({ trueTier: 'frontier' });
  });

  it('counts a false negative (human says over-modeled, judge kept it at frontier)', () => {
    const s = scoreLabels([row({ judgeTier: 'frontier', trueMinTier: 'sonnet' })]);
    expect(s.counts).toMatchObject({ tp: 0, fp: 0, fn: 1, tn: 0 });
    expect(s.recall).toBe(0);
  });

  it('computes precision as tp/(tp+fp) and gates on ≥5 positives & ≥90%', () => {
    // 9 true downgrades + 1 false downgrade → precision 0.9, 10 positives → gate PASS.
    const rows: LabelRow[] = [];
    for (let i = 0; i < 9; i++) rows.push(row({ id: i, judgeTier: 'sonnet', trueMinTier: 'sonnet' }));
    rows.push(row({ id: 9, judgeTier: 'sonnet', trueMinTier: 'frontier' }));
    const s = scoreLabels(rows);
    expect(s.precision).toBeCloseTo(0.9, 6);
    expect(s.counts).toMatchObject({ tp: 9, fp: 1 });
    expect(s.passesGate).toBe(true);
  });

  it('fails the gate below 90% precision', () => {
    const rows: LabelRow[] = [];
    for (let i = 0; i < 8; i++) rows.push(row({ id: i, judgeTier: 'sonnet', trueMinTier: 'sonnet' }));
    for (let i = 8; i < 10; i++) rows.push(row({ id: i, judgeTier: 'sonnet', trueMinTier: 'frontier' }));
    const s = scoreLabels(rows);
    expect(s.precision).toBeCloseTo(0.8, 6);
    expect(s.passesGate).toBe(false);
  });

  it('does not pass the gate with too few positives even at 100% precision', () => {
    const rows = [row({ id: 0, judgeTier: 'sonnet', trueMinTier: 'sonnet' })];
    const s = scoreLabels(rows);
    expect(s.precision).toBe(1);
    expect(s.passesGate).toBe(false); // only 1 positive, need ≥5
  });

  it('ignores unlabeled rows', () => {
    const s = scoreLabels([
      row({ id: 0, judgeTier: 'sonnet', trueMinTier: 'sonnet' }),
      row({ id: 1, judgeTier: 'haiku', trueMinTier: null }),
    ]);
    expect(s.labeled).toBe(1);
    expect(s.unlabeled).toBe(1);
  });

  it('true tier match counts correctly across tiers (within-one + direction)', () => {
    // frontier model, judge→haiku, human says sonnet: both over-modeled (TP), off by one.
    const s = scoreLabels([row({ judgeTier: 'haiku', trueMinTier: 'sonnet' })]);
    expect(s.counts).toMatchObject({ tp: 1 });
    expect(s.exactTierAccuracy).toBe(0);
    expect(s.withinOneTierAccuracy).toBe(1);
    expect(s.directionAccuracy).toBe(1); // both "below actual"
  });
});
