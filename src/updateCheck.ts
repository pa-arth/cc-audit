// Best-effort "you're a version behind — update" notice. Fully optional and
// strictly non-fatal: a short-timeout fetch to the public npm registry, cached
// for a day in ~/.cc-audit so repeat runs don't re-hit the network. It never
// throws and never blocks the audit (the caller kicks it off up front and only
// awaits the already-running promise at the end), and the notice is routed to
// stderr so it can't corrupt --json on stdout.
//
// Silenced by CC_AUDIT_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER / CI, matching the
// de-facto convention for CLI update notifiers.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { c } from './theme.js';

const PKG = '@promptster/cc-audit';
const REGISTRY = process.env.CC_AUDIT_REGISTRY ?? 'https://registry.npmjs.org';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-check at most once a day
const FETCH_TIMEOUT_MS = 1500; // a slow/offline registry can never stall the CLI

export interface UpdateNotice {
  current: string;
  latest: string;
}

interface Cache {
  latest: string;
  checkedAt: number;
}

function cachePath(): string {
  return join(homedir(), '.cc-audit', 'update-check.json');
}

function updatesDisabled(): boolean {
  return Boolean(process.env.CC_AUDIT_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || process.env.CI);
}

/**
 * -1 if a<b, 0 if equal, 1 if a>b. Compares the numeric release core only
 * (major.minor.patch); any prerelease/build suffix is ignored, so 1.2.0-rc.1
 * and 1.2.0 compare equal. Good enough to answer "is a strictly behind b".
 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) =>
    v
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function readCache(): Cache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<Cache>;
    if (typeof parsed.latest === 'string' && typeof parsed.checkedAt === 'number') {
      return { latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    /* no cache yet, or unreadable — just fetch */
  }
  return undefined;
}

function writeCache(cache: Cache): void {
  try {
    mkdirSync(join(homedir(), '.cc-audit'), { recursive: true });
    writeFileSync(cachePath(), `${JSON.stringify(cache)}\n`);
  } catch {
    /* best-effort; a failed cache write just means we re-fetch next run */
  }
}

async function fetchLatest(): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${REGISTRY.replace(/\/$/, '')}/${PKG.replace('/', '%2F')}/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined; // offline, timeout, bad JSON — all non-fatal
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve whether a newer published version exists. Returns the notice only when
 * `current` is strictly behind the latest release; returns undefined when
 * up-to-date, disabled, or the latest can't be determined. `now` is injectable
 * for tests.
 */
export async function checkForUpdate(current: string, now: number = Date.now()): Promise<UpdateNotice | undefined> {
  if (updatesDisabled()) return undefined;

  const cached = readCache();
  let latest: string | undefined;
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatest();
    if (latest) writeCache({ latest, checkedAt: now });
    else latest = cached?.latest; // fetch failed — fall back to a stale cache if we have one
  }

  if (!latest) return undefined;
  return compareVersions(current, latest) < 0 ? { current, latest } : undefined;
}

/** Two-line, theme-colored notice. Plain text when color is off (piped/NO_COLOR). */
export function renderUpdateNotice(notice: UpdateNotice): string {
  return [
    `${c.amber('▲')} A new version of cc-audit is available (${notice.current} → ${c.gold(notice.latest)}).`,
    `  Update: ${c.cyan(`npm i -g ${PKG}`)}  ${c.dim('(or rerun via npx — it fetches latest)')}`,
  ].join('\n');
}
