// Disk cache for the personal context knee. computeContextKnee scans EVERY transcript —
// far too expensive for a statusline that runs on every assistant message (300ms debounce).
// So we compute it at most a few times a day, persist it under ~/.cc-audit/, and the
// per-invocation statusline path just reads this small JSON. When the cache is stale (or
// missing) the statusline kicks a DETACHED background refresh and keeps using the stale
// value (or degrades to live-only) — it never blocks on a full scan. A lock file debounces
// the refresh so rapid statusline calls don't spawn a stampede of scanners.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadClaudeCodeSessions } from './adapters/claudeCode.js';
import { computeContextKnee, type ContextKnee } from './contextKnee.js';

const CACHE_VERSION = 1;
// The knee is a slow-moving personal trait — hours of staleness is fine. Refresh lazily.
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
// Bound the scan: the knee is a recent-habits number, and old transcripts drag the scan.
const DEFAULT_WINDOW_DAYS = 30;
// Don't spawn another refresh if one was kicked within this window (stampede guard).
const REFRESH_DEBOUNCE_MS = 2 * 60 * 1000; // 2m

export interface KneeCache extends ContextKnee {
  version: number;
  /** Epoch ms the knee was computed. */
  computedAt: number;
  /** Transcript root the scan used (so a --root override doesn't read a mismatched cache). */
  root: string | null;
}

function ccAuditDir(): string {
  return join(homedir(), '.cc-audit');
}
function cachePath(): string {
  return join(ccAuditDir(), 'knee-cache.json');
}
function lockPath(): string {
  return join(ccAuditDir(), 'knee-refresh.lock');
}

export function readKneeCache(): KneeCache | null {
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf8')) as KneeCache;
    return c.version === CACHE_VERSION ? c : null;
  } catch {
    return null;
  }
}

/** Scan transcripts, compute the knee, and persist it. Runs in the detached refresh child
 *  (and can be called directly). Best-effort — never throws. */
export function computeAndWriteKneeCache(opts: { root?: string; sinceDays?: number } = {}): KneeCache | null {
  try {
    const sessions = loadClaudeCodeSessions({ root: opts.root, sinceDays: opts.sinceDays ?? DEFAULT_WINDOW_DAYS });
    const knee = computeContextKnee(sessions);
    const cache: KneeCache = { version: CACHE_VERSION, computedAt: Date.now(), root: opts.root ?? null, ...knee };
    mkdirSync(ccAuditDir(), { recursive: true });
    writeFileSync(cachePath(), `${JSON.stringify(cache)}\n`);
    return cache;
  } catch {
    return null;
  }
}

/** True when the cache is missing, a different root, or older than maxAgeMs. */
export function isKneeCacheStale(cache: KneeCache | null, root: string | null, maxAgeMs = DEFAULT_MAX_AGE_MS): boolean {
  if (!cache) return true;
  if ((cache.root ?? null) !== (root ?? null)) return true;
  return Date.now() - cache.computedAt > maxAgeMs;
}

/** Kick a detached `cc-audit __refresh-knee` that rebuilds the cache and exits, debounced by
 *  a lock file so rapid statusline calls don't spawn a stampede. Returns the child (unref'd)
 *  or null if debounced/failed. Never blocks the caller. */
export function spawnKneeRefresh(root?: string): ChildProcess | null {
  try {
    mkdirSync(ccAuditDir(), { recursive: true });
    const lock = lockPath();
    try {
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age < REFRESH_DEBOUNCE_MS) return null; // a refresh was kicked recently
    } catch {
      /* no lock yet — fall through and create it */
    }
    // Touch the lock BEFORE spawning so concurrent statusline calls see the debounce.
    writeFileSync(lock, `${Date.now()}\n`);
    try {
      utimesSync(lock, new Date(), new Date());
    } catch {
      /* mtime already fresh from the write */
    }
    const entry = process.argv[1];
    if (!entry) return null;
    const args = [entry, '__refresh-knee', ...(root ? ['--root', root] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  } catch {
    return null;
  }
}
