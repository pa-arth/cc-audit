// Run history — the feedback loop. Every full audit run persists its aggregate record
// (already privacy-safe and per-month-normalized) to ~/.cc-audit/history/, and the next
// run opens with a delta against the newest prior-day snapshot at the same window. All
// LOCAL, all best-effort: a history failure must never fail (or pollute the stdout of)
// the run that carries it. State lives in ~/.cc-audit/, matching consent/updateCheck.
//
// Snapshot filenames are `<YYYY-MM-DD>-<windowKey>.json`. The window key comes from the
// --since-days ARG, not from the aggregate's fractional mtime-derived window.days — two
// runs of `--since-days 30` must compare, and a bare run's ever-growing window must not.
// One snapshot per UTC day per key: a same-day rerun overwrites, and the baseline search
// excludes today, so reruns never diff against themselves.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AggregateRecord } from './aggregate.js';

function historyDir(): string {
  return join(homedir(), '.cc-audit', 'history');
}

/** Window key for snapshot filenames: `w30` for --since-days 30, `all` for a bare run. */
export function windowKey(sinceDays: number | undefined): string {
  return sinceDays == null ? 'all' : `w${sinceDays}`;
}

// Baselines parse against ONLY the delta-bearing fields, not the full aggregate schema —
// otherwise every schema bump would orphan all existing history. Older snapshots missing
// a field (or corrupt JSON) are skipped silently; newer snapshots with extra fields parse.
const SnapshotDeltaSchema = z.object({
  generatedAt: z.string(),
  window: z.object({ days: z.number() }),
  spend: z.object({ perMonthUsd: z.number() }),
  fluency: z.object({ premiumTurnShare: z.number(), redundantReadRate: z.number() }),
  contextHygiene: z.object({ avoidableTotalUsdPerMonth: z.number() }),
});

export type SnapshotDelta = z.infer<typeof SnapshotDeltaSchema>;

export interface Baseline {
  /** Calendar day the snapshot was written (from the filename — clock-skew-immune). */
  date: string;
  snapshot: SnapshotDelta;
}

const SNAPSHOT_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.json$/;

function snapshotPath(key: string, isoDay: string): string {
  return join(historyDir(), `${isoDay}-${key}.json`);
}

/** Persist the run's aggregate verbatim. Deterministic filename ⇒ one per day per key. */
export function writeSnapshot(aggregate: AggregateRecord, key: string, isoDay: string): void {
  try {
    mkdirSync(historyDir(), { recursive: true });
    writeFileSync(snapshotPath(key, isoDay), `${JSON.stringify(aggregate)}\n`);
  } catch {
    /* best-effort; never fail the run on a history write error */
  }
}

/** Newest snapshot from a PRIOR day with a matching window key, or undefined. Unreadable
 *  or schema-incompatible files are skipped (newest-first) rather than surfaced. */
export function readBaseline(key: string, isoDay: string): Baseline | undefined {
  let names: string[];
  try {
    names = readdirSync(historyDir());
  } catch {
    return undefined;
  }
  const candidates = names
    .map((n) => {
      const m = SNAPSHOT_NAME.exec(n);
      return m && m[2] === key && m[1]! < isoDay ? { name: n, date: m[1]! } : null;
    })
    .filter((c): c is { name: string; date: string } => c !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const cand of candidates) {
    try {
      const parsed = SnapshotDeltaSchema.safeParse(JSON.parse(readFileSync(join(historyDir(), cand.name), 'utf8')));
      if (parsed.success) return { date: cand.date, snapshot: parsed.data };
    } catch {
      /* corrupt file — try the next-older snapshot */
    }
  }
  return undefined;
}

export interface DeltaMetric {
  prev: number;
  cur: number;
}

/** Run-over-run movement on the four headline levers. All four share one polarity:
 *  down = improved (spend, avoidable carry, premium share, redundant-read rate). */
export interface HistoryDelta {
  /** Baseline snapshot's calendar day, `YYYY-MM-DD`. */
  baselineDate: string;
  spendPerMonthUsd: DeltaMetric;
  avoidableCarryPerMonthUsd: DeltaMetric;
  premiumTurnShare: DeltaMetric;
  redundantReadRate: DeltaMetric;
}

export function computeDelta(baseline: Baseline, cur: AggregateRecord): HistoryDelta {
  const prev = baseline.snapshot;
  return {
    baselineDate: baseline.date,
    spendPerMonthUsd: { prev: prev.spend.perMonthUsd, cur: cur.spend.perMonthUsd },
    avoidableCarryPerMonthUsd: {
      prev: prev.contextHygiene.avoidableTotalUsdPerMonth,
      cur: cur.contextHygiene.avoidableTotalUsdPerMonth,
    },
    premiumTurnShare: { prev: prev.fluency.premiumTurnShare, cur: cur.fluency.premiumTurnShare },
    redundantReadRate: { prev: prev.fluency.redundantReadRate, cur: cur.fluency.redundantReadRate },
  };
}

// ── Advice history ───────────────────────────────────────────────────────────────
// The plans the developer's own agent wrote, kept next to the snapshot they were
// written ABOUT. Without this there is a record that spend moved but no record of what
// was recommended, so no later run can ever ask "did they act on it?" — the aggregate
// alone can measure movement and never intent.
//
// Stored in a SUBDIRECTORY, not alongside snapshots. readBaseline() scans historyDir()
// and matches SNAPSHOT_NAME against every entry; a directory named `advice` cannot
// satisfy that regex, so advice can never be mistaken for a baseline. (Naming these
// `<day>-<key>-advice.json` in the same directory would have parsed as window key
// "w30-advice" — harmless today, but only by accident.)
//
// LOCAL ONLY, and deliberately so. This is the most specific artifact cc-audit keeps:
// it names commands, skills, and real dollar figures. No egress path reads this
// directory — not capture.ts, not open.ts, not judgeClient.ts. Keep it that way.

function adviceDir(): string {
  return join(historyDir(), 'advice');
}

// Read back leniently, like SnapshotDeltaSchema: `raw` is the only field worth failing
// over, because it is the one the agent can always act on. `plans` is best-effort model
// parsing upstream and may legitimately be null.
const StoredAdviceSchema = z.object({
  generatedAt: z.string(),
  agent: z.string(),
  raw: z.string(),
  plans: z
    .array(z.object({ n: z.number(), title: z.string(), body: z.string() }))
    .nullable()
    .optional(),
  closing: z.string().nullable().optional(),
});

export type StoredAdvice = z.infer<typeof StoredAdviceSchema>;

export interface AdviceEntry {
  /** Calendar day the advice was written, from the filename (clock-skew-immune). */
  date: string;
  advice: StoredAdvice;
}

/** Persist the plans for this run. One file per day per window key, same as snapshots,
 *  so a same-day rerun overwrites rather than accumulating near-duplicates. */
export function writeAdvice(
  advice: { agent: string; raw: string; plans?: unknown; closing?: string | null },
  key: string,
  isoDay: string,
): void {
  if (!advice.raw.trim()) return; // nothing worth keeping; never write an empty husk
  try {
    mkdirSync(adviceDir(), { recursive: true });
    const record = {
      generatedAt: new Date().toISOString(),
      agent: advice.agent,
      raw: advice.raw,
      plans: advice.plans ?? null,
      closing: advice.closing ?? null,
    };
    writeFileSync(join(adviceDir(), `${isoDay}-${key}.json`), `${JSON.stringify(record)}\n`);
  } catch {
    /* best-effort; a history write must never fail the run that carries it */
  }
}

/** Prior days' advice for this window, newest first. Excludes `isoDay` so a same-day
 *  rerun never reads back the advice it just wrote and calls it history. */
export function readAdviceHistory(key: string, isoDay: string, limit = 4): AdviceEntry[] {
  let names: string[];
  try {
    names = readdirSync(adviceDir());
  } catch {
    return [];
  }
  const out: AdviceEntry[] = [];
  const candidates = names
    .map((n) => {
      const m = SNAPSHOT_NAME.exec(n);
      return m && m[2] === key && m[1]! < isoDay ? { name: n, date: m[1]! } : null;
    })
    .filter((c): c is { name: string; date: string } => c !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const cand of candidates) {
    if (out.length >= limit) break;
    try {
      const parsed = StoredAdviceSchema.safeParse(JSON.parse(readFileSync(join(adviceDir(), cand.name), 'utf8')));
      if (parsed.success) out.push({ date: cand.date, advice: parsed.data });
    } catch {
      /* corrupt file — skip it, older advice is still useful */
    }
  }
  return out;
}
