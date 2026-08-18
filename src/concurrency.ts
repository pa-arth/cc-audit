// Concurrency — the THIRD axis (tokens first, wall-clock second): how many sessions
// were alive at the same time, and what that bought.
//
// Two totals over the same minutes:
//   agentMinutes — sum the active minutes of each session separately. How long the
//                  work would have taken run back to back.
//   wallMinutes  — the UNION of those minutes. How long it actually took.
// Their ratio is the mean number of sessions running whenever anything was running.
//
// A session is ACTIVE in a minute if it logged a turn in that minute, or if the minute
// falls inside a gap shorter than the bridge — an agent halfway through a long tool call
// is working but leaves no timestamp to prove it. The bridge is the only free parameter
// in the method, so `sensitivity` reports the answer across its plausible range rather
// than at one flattering value: a finding that dies inside that range was never a finding.
//
// Idle time is EXCLUDED, not counted as zero. This is "how many were running when
// anything was running", not an average over the calendar.
//
// LOCAL-FIRST: every field here is a de-identified aggregate (counts and ratios, no
// paths, no project labels, no session ids), so the whole profile is uploadable.

import { allTurns, concurrencyKey, type Session } from './model.js';

const MINUTE_MS = 60_000;
const DEFAULT_BRIDGE_MS = 5 * MINUTE_MS;
/** Bridges to report in `sensitivity`, in minutes. */
const SENSITIVITY_BRIDGES = [1, 2, 5, 10];
/** Above this, a "gap" is a different working session, not a long tool call. Bridging
 *  further would silently merge two days into one stretch. */
const MAX_BRIDGE_MS = 30 * MINUTE_MS;

/** One concurrency level and how much time was spent at it. */
export interface ConcurrencyLevel {
  /** Sessions running simultaneously. */
  live: number;
  /** Minutes of YOUR time spent at this level. */
  wallMinutes: number;
  /** Session-minutes delivered at this level (= live × wallMinutes). */
  agentMinutes: number;
  /** Share of all working minutes spent at this level, 0-1. */
  wallShare: number;
}

/** One row of the bridge-sensitivity sweep. */
export interface BridgeSensitivity {
  bridgeMinutes: number;
  agentMinutes: number;
  wallMinutes: number;
  meanConcurrent: number;
}

/** How much steering each hour of agent work needed, at a given concurrency. */
export interface SteeringLevel {
  /** Label for the bucket ('1', '2', '3-4', '5-7', '8+'). */
  bucket: string;
  agentMinutes: number;
  wallMinutes: number;
  /** User prompts issued while this many sessions were live. */
  prompts: number;
  /** prompts per hour of AGENT work — flat means parallelism buys you no leverage
   *  on your own attention, it only compresses the calendar. */
  promptsPerAgentHour: number;
  /** prompts per hour of YOUR time — what the day actually feels like. */
  promptsPerWallHour: number;
}

export interface ConcurrencyProfile {
  bridgeMs: number;
  /** Minutes in which at least one session was live. */
  wallMinutes: number;
  /** Session-minutes summed across sessions. */
  agentMinutes: number;
  /** agentMinutes / wallMinutes — mean sessions live whenever anything was live. */
  meanConcurrent: number;
  /** Time-weighted median (the level at which cumulative wall time passes half). */
  medianConcurrent: number;
  /** Re-weighted by session-minutes instead of wall-minutes: how crowded it is from
   *  INSIDE a running session. Always >= meanConcurrent, and usually by a lot, because
   *  busy minutes contain more sessions to be counted. */
  sessionWeightedMean: number;
  /** Highest number of sessions live in any single minute. */
  peakConcurrent: number;
  /** Share of working minutes with exactly one session live, 0-1. Note this is a
   *  PLURALITY, not a majority — the tallest bar in the histogram is routinely solo
   *  while the great majority of time is spent with company. */
  soloShare: number;
  /** Share of working minutes with two or more live, 0-1. */
  multiShare: number;
  /** Wall-minutes saved by running in parallel: agentMinutes - wallMinutes. */
  minutesBought: number;
  histogram: ConcurrencyLevel[];
  sensitivity: BridgeSensitivity[];
  steering: SteeringLevel[];
  /** Sessions that contributed at least one timestamped minute. */
  sessionsCounted: number;
  /** Sessions dropped for having no usable timestamp (data-quality signal — a session
   *  with no `ts` on any turn cannot be placed on the clock at all). */
  sessionsUntimed: number;
}

export interface ConcurrencyOptions {
  /** Gap (ms) short enough to count as still-working. Clamped to (0, 30min]. */
  bridgeMs?: number;
}

/** Active minute indices for one session's turn timestamps, bridging short gaps. */
function activeMinutes(tsList: number[], bridgeMs: number): Set<number> {
  const mins = new Set<number>();
  let prev: number | null = null;
  for (const t of tsList) {
    const m = Math.floor(t / MINUTE_MS);
    mins.add(m);
    if (prev !== null && t - prev <= bridgeMs) {
      for (let x = Math.floor(prev / MINUTE_MS); x <= m; x += 1) mins.add(x);
    }
    prev = t;
  }
  return mins;
}

/** Group timestamped turns by the session that owns them, folding subagents into their
 *  parent. Returns sorted, de-duplicated timestamp lists. */
function turnsBySession(sessions: Session[]): { timed: Map<string, number[]>; untimed: number } {
  const acc = new Map<string, number[]>();
  const anyTurn = new Set<string>();
  for (const s of sessions) {
    const key = concurrencyKey(s);
    for (const t of allTurns(s)) {
      anyTurn.add(key);
      if (t.ts == null) continue;
      const list = acc.get(key);
      if (list) list.push(t.ts);
      else acc.set(key, [t.ts]);
    }
  }
  const timed = new Map<string, number[]>();
  for (const [key, list] of acc) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    if (sorted.length > 0) timed.set(key, sorted);
  }
  return { timed, untimed: anyTurn.size - timed.size };
}

/** Minute index → how many sessions were live in it. */
function minuteMap(timed: Map<string, number[]>, bridgeMs: number): Map<number, number> {
  const live = new Map<number, number>();
  for (const list of timed.values()) {
    for (const m of activeMinutes(list, bridgeMs)) {
      live.set(m, (live.get(m) ?? 0) + 1);
    }
  }
  return live;
}

const bucketOf = (live: number): string =>
  live <= 1 ? '1' : live === 2 ? '2' : live <= 4 ? '3-4' : live <= 7 ? '5-7' : '8+';
const BUCKETS = ['1', '2', '3-4', '5-7', '8+'] as const;

/** Every user prompt's timestamp, folded to the owning session. Sidechain spans are
 *  excluded: a subagent's task instruction is the machine talking to itself, not you
 *  steering, and counting it would inflate exactly the number that measures your input. */
function promptTimestamps(sessions: Session[]): number[] {
  const out: number[] = [];
  for (const s of sessions) {
    for (const span of s.spans) {
      if (span.isSidechain || span.userTs == null) continue;
      out.push(span.userTs);
    }
  }
  return out;
}

export function computeConcurrency(sessions: Session[], opts: ConcurrencyOptions = {}): ConcurrencyProfile {
  const bridgeMs = Math.min(
    MAX_BRIDGE_MS,
    Math.max(1, Math.trunc(opts.bridgeMs ?? DEFAULT_BRIDGE_MS)),
  );
  const { timed, untimed } = turnsBySession(sessions);
  const live = minuteMap(timed, bridgeMs);

  const wallMinutes = live.size;
  let agentMinutes = 0;
  let peakConcurrent = 0;
  const atLevel = new Map<number, number>();
  for (const n of live.values()) {
    agentMinutes += n;
    if (n > peakConcurrent) peakConcurrent = n;
    atLevel.set(n, (atLevel.get(n) ?? 0) + 1);
  }

  const histogram: ConcurrencyLevel[] = [...atLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([levelLive, mins]) => ({
      live: levelLive,
      wallMinutes: mins,
      agentMinutes: levelLive * mins,
      wallShare: wallMinutes > 0 ? mins / wallMinutes : 0,
    }));

  // time-weighted median
  let medianConcurrent = 0;
  let cum = 0;
  for (const row of histogram) {
    cum += row.wallMinutes;
    if (cum >= wallMinutes / 2) {
      medianConcurrent = row.live;
      break;
    }
  }

  // session-weighted mean: sum(n^2 * mins) / sum(n * mins)
  let sq = 0;
  for (const row of histogram) sq += row.live * row.live * row.wallMinutes;
  const sessionWeightedMean = agentMinutes > 0 ? sq / agentMinutes : 0;

  const soloMinutes = atLevel.get(1) ?? 0;

  // steering: attribute each prompt to the concurrency of the minute it landed in
  const prompts = new Map<string, number>();
  for (const ts of promptTimestamps(sessions)) {
    const n = live.get(Math.floor(ts / MINUTE_MS));
    if (n === undefined) continue; // prompt outside any active minute
    const b = bucketOf(n);
    prompts.set(b, (prompts.get(b) ?? 0) + 1);
  }
  const bucketWall = new Map<string, number>();
  const bucketAgent = new Map<string, number>();
  for (const [levelLive, mins] of atLevel) {
    const b = bucketOf(levelLive);
    bucketWall.set(b, (bucketWall.get(b) ?? 0) + mins);
    bucketAgent.set(b, (bucketAgent.get(b) ?? 0) + levelLive * mins);
  }
  const steering: SteeringLevel[] = BUCKETS.filter((b) => (bucketWall.get(b) ?? 0) > 0).map((b) => {
    const am = bucketAgent.get(b) ?? 0;
    const wm = bucketWall.get(b) ?? 0;
    const p = prompts.get(b) ?? 0;
    return {
      bucket: b,
      agentMinutes: am,
      wallMinutes: wm,
      prompts: p,
      promptsPerAgentHour: am > 0 ? p / (am / 60) : 0,
      promptsPerWallHour: wm > 0 ? p / (wm / 60) : 0,
    };
  });

  const sensitivity: BridgeSensitivity[] = SENSITIVITY_BRIDGES.map((minutes) => {
    const m = minuteMap(timed, minutes * MINUTE_MS);
    let agent = 0;
    for (const n of m.values()) agent += n;
    return {
      bridgeMinutes: minutes,
      agentMinutes: agent,
      wallMinutes: m.size,
      meanConcurrent: m.size > 0 ? agent / m.size : 0,
    };
  });

  return {
    bridgeMs,
    wallMinutes,
    agentMinutes,
    meanConcurrent: wallMinutes > 0 ? agentMinutes / wallMinutes : 0,
    medianConcurrent,
    sessionWeightedMean,
    peakConcurrent,
    soloShare: wallMinutes > 0 ? soloMinutes / wallMinutes : 0,
    multiShare: wallMinutes > 0 ? (wallMinutes - soloMinutes) / wallMinutes : 0,
    minutesBought: agentMinutes - wallMinutes,
    histogram,
    sensitivity,
    steering,
    sessionsCounted: timed.size,
    sessionsUntimed: untimed,
  };
}
