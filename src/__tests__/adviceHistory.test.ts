import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readAdviceHistory, readBaseline, windowKey, writeAdvice, writeSnapshot } from '../history.js';
import type { AggregateRecord } from '../aggregate.js';

const ADVICE = {
  agent: 'claude',
  raw: '**Plan 1 — Stop running to the wall**\nUse /compact.\n\n**Next session: /clear between tasks**',
  plans: [{ n: 1, title: 'Stop running to the wall', body: 'Use /compact.' }],
  closing: '/clear between tasks',
};

describe('advice history — the record of what was RECOMMENDED', () => {
  const home0 = process.env.HOME;
  let home: string;
  const dir = () => join(home, '.cc-audit', 'history', 'advice');

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-advice-hist-'));
    process.env.HOME = home;
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(join(home, '.cc-audit'), { recursive: true, force: true });
  });

  it('round-trips the plans so a later run can ask what was advised', () => {
    writeAdvice(ADVICE, 'w30', '2026-07-21');
    const got = readAdviceHistory('w30', '2026-07-28');
    expect(got).toHaveLength(1);
    expect(got[0]!.date).toBe('2026-07-21');
    expect(got[0]!.advice.raw).toBe(ADVICE.raw);
    expect(got[0]!.advice.plans![0]!.title).toBe('Stop running to the wall');
    expect(got[0]!.advice.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps advice whose plans FAILED to parse — raw is the fallback that must survive', () => {
    // parseAdvice() returns plans:null on unfamiliar output. If that entry were dropped
    // or rejected on read, the weeks where the model wrote prose would silently vanish
    // from the follow-through record — exactly the weeks a human still needs read back.
    writeAdvice({ agent: 'codex', raw: 'freeform prose, no plan headers at all', plans: null, closing: null }, 'w30', '2026-07-20');
    const got = readAdviceHistory('w30', '2026-07-28');
    expect(got).toHaveLength(1);
    expect(got[0]!.advice.plans).toBeNull();
    expect(got[0]!.advice.raw).toContain('freeform prose');
  });

  it('EXCLUDES today, so a same-day rerun never reads back its own advice as history', () => {
    writeAdvice(ADVICE, 'w30', '2026-07-28');
    expect(readAdviceHistory('w30', '2026-07-28')).toEqual([]);
  });

  it('only matches the SAME window key — w30 and all cover different spans', () => {
    writeAdvice(ADVICE, 'all', '2026-07-21');
    expect(readAdviceHistory('w30', '2026-07-28')).toEqual([]);
    expect(readAdviceHistory('all', '2026-07-28')).toHaveLength(1);
  });

  it('returns newest first and honours the limit', () => {
    for (const d of ['2026-07-07', '2026-07-14', '2026-07-21']) writeAdvice(ADVICE, 'w30', d);
    expect(readAdviceHistory('w30', '2026-07-28').map((e) => e.date)).toEqual([
      '2026-07-21',
      '2026-07-14',
      '2026-07-07',
    ]);
    expect(readAdviceHistory('w30', '2026-07-28', 2).map((e) => e.date)).toEqual(['2026-07-21', '2026-07-14']);
  });

  it('never writes an empty husk', () => {
    writeAdvice({ agent: 'claude', raw: '   ', plans: null, closing: null }, 'w30', '2026-07-21');
    expect(readAdviceHistory('w30', '2026-07-28')).toEqual([]);
  });

  it('skips a corrupt file instead of losing the older advice behind it', () => {
    writeAdvice(ADVICE, 'w30', '2026-07-14');
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), '2026-07-21-w30.json'), '{ not json');
    const got = readAdviceHistory('w30', '2026-07-28');
    expect(got).toHaveLength(1);
    expect(got[0]!.date).toBe('2026-07-14');
  });

  it('missing directory is empty history, not a throw — a first run has none', () => {
    expect(readAdviceHistory('w30', '2026-07-28')).toEqual([]);
  });

  it('does NOT pollute the aggregate baseline search', () => {
    // The advice subdirectory lives inside historyDir(). If it were ever flattened into
    // `<day>-<key>-advice.json` siblings, readBaseline's scan would start considering
    // them. Prove the snapshot lane is untouched by a directory full of advice.
    const agg = {
      generatedAt: '2026-07-21T00:00:00.000Z',
      window: { days: 30 },
      spend: { perMonthUsd: 100 },
      fluency: { premiumTurnShare: 0.5, redundantReadRate: 0.1 },
      contextHygiene: { avoidableTotalUsdPerMonth: 20 },
    } as unknown as AggregateRecord;
    writeSnapshot(agg, 'w30', '2026-07-21');
    for (const d of ['2026-07-22', '2026-07-23']) writeAdvice(ADVICE, 'w30', d);
    const base = readBaseline('w30', '2026-07-28');
    expect(base?.date).toBe('2026-07-21');           // the snapshot, not an advice file
    expect(base?.snapshot.spend.perMonthUsd).toBe(100);
    // and the advice dir does not appear as a snapshot candidate
    expect(readdirSync(join(home, '.cc-audit', 'history'))).toContain('advice');
  });

  it('windowKey shapes the filename the skill is told to match on', () => {
    expect(windowKey(30)).toBe('w30');
    expect(windowKey(undefined)).toBe('all');
  });
});
