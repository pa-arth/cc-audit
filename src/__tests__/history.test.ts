import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AggregateRecord } from '../aggregate.js';
import { computeDelta, readBaseline, windowKey, writeSnapshot } from '../history.js';

/** Just the delta-bearing fields — writeSnapshot stringifies verbatim and readBaseline
 *  parses with the minimal schema, so a partial record cast is all a test needs. */
function record(overrides: { spend?: number; carry?: number; premium?: number; rereads?: number } = {}): AggregateRecord {
  return {
    schemaVersion: 7,
    generatedAt: '2026-07-01T12:00:00.000Z',
    window: { days: 29.2 },
    spend: { perMonthUsd: overrides.spend ?? 3900 },
    fluency: {
      premiumTurnShare: overrides.premium ?? 0.96,
      redundantReadRate: overrides.rereads ?? 0.35,
    },
    contextHygiene: { avoidableTotalUsdPerMonth: overrides.carry ?? 910 },
  } as unknown as AggregateRecord;
}

describe('history snapshots', () => {
  const home0 = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-history-'));
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX → isolates ~/.cc-audit
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });

  const dir = () => join(home, '.cc-audit', 'history');
  beforeEach(() => rmSync(dir(), { recursive: true, force: true }));

  it('maps --since-days to a window key, bare run to "all"', () => {
    expect(windowKey(30)).toBe('w30');
    expect(windowKey(undefined)).toBe('all');
  });

  it('writes one snapshot per day per key; same day+key overwrites', () => {
    writeSnapshot(record({ spend: 100 }), 'w30', '2026-07-01');
    writeSnapshot(record({ spend: 200 }), 'w30', '2026-07-01');
    writeSnapshot(record(), 'all', '2026-07-01');
    expect(readdirSync(dir()).sort()).toEqual(['2026-07-01-all.json', '2026-07-01-w30.json']);
    // The overwrite won: reading from a later day sees the second write.
    expect(readBaseline('w30', '2026-07-02')?.snapshot.spend.perMonthUsd).toBe(200);
  });

  it('baseline picks the newest PRIOR day with a matching key', () => {
    writeSnapshot(record({ spend: 100 }), 'w30', '2026-06-20');
    writeSnapshot(record({ spend: 150 }), 'w30', '2026-06-28');
    writeSnapshot(record({ spend: 999 }), 'w30', '2026-07-01'); // today — excluded
    writeSnapshot(record({ spend: 555 }), 'w7', '2026-06-30'); // other key — excluded
    const b = readBaseline('w30', '2026-07-01');
    expect(b?.date).toBe('2026-06-28');
    expect(b?.snapshot.spend.perMonthUsd).toBe(150);
  });

  it('returns undefined on empty or missing history', () => {
    expect(readBaseline('w30', '2026-07-01')).toBeUndefined();
    mkdirSync(dir(), { recursive: true });
    expect(readBaseline('w30', '2026-07-01')).toBeUndefined();
  });

  it('skips corrupt and schema-incompatible snapshots, falling back to older ones', () => {
    writeSnapshot(record({ spend: 100 }), 'w30', '2026-06-10');
    // v6-style record missing contextHygiene.avoidableTotalUsdPerMonth — schema-skips.
    const v6 = record() as unknown as Record<string, unknown>;
    (v6 as { contextHygiene: object }).contextHygiene = {};
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), '2026-06-20-w30.json'), JSON.stringify(v6));
    writeFileSync(join(dir(), '2026-06-25-w30.json'), 'not json{');
    const b = readBaseline('w30', '2026-07-01');
    expect(b?.date).toBe('2026-06-10');
    expect(b?.snapshot.spend.perMonthUsd).toBe(100);
  });

  it('a future-schema snapshot with extra fields still parses', () => {
    const v9 = { ...(record({ spend: 300 }) as unknown as Record<string, unknown>), schemaVersion: 9, newThing: { x: 1 } };
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), '2026-06-29-w30.json'), JSON.stringify(v9));
    expect(readBaseline('w30', '2026-07-01')?.snapshot.spend.perMonthUsd).toBe(300);
  });

  it('computeDelta pairs prev/cur across all four metrics', () => {
    writeSnapshot(record({ spend: 3900, carry: 910, premium: 0.96, rereads: 0.35 }), 'w30', '2026-06-12');
    const b = readBaseline('w30', '2026-07-01')!;
    const d = computeDelta(b, record({ spend: 3100, carry: 640, premium: 0.71, rereads: 0.2 }));
    expect(d.baselineDate).toBe('2026-06-12');
    expect(d.spendPerMonthUsd).toEqual({ prev: 3900, cur: 3100 });
    expect(d.avoidableCarryPerMonthUsd).toEqual({ prev: 910, cur: 640 });
    expect(d.premiumTurnShare).toEqual({ prev: 0.96, cur: 0.71 });
    expect(d.redundantReadRate).toEqual({ prev: 0.35, cur: 0.2 });
  });
});
