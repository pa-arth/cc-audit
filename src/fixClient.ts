// Client for the hosted config-review REWRITE (POST /v1/public/config-review →
// poll GET). This is the only `fix` path that spends our credits (the rewrite +
// the k=3 judge + the adversarial safety cross-check run server-side). Spend is
// enforced SERVER-SIDE, keyed by the `X-Install-Key` header; the local cap is now a
// UX counter (DAILY_CAP) plus a loose abuse backstop (BACKSTOP_CAP) so we're never
// fully uncapped if server enforcement lags. The model-pin patches are purely local
// and don't touch this.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_API = 'https://api.promptster.ai';
const POLL_MS = 2000;
const MAX_POLLS = 60; // ~2 min ceiling
export const DAILY_CAP = 10; // display-only: the per-install daily cap the SERVER enforces
const BACKSTOP_CAP = 50; // local abuse ceiling — the only guard if server enforcement lags

/** The rewrite half of the config_review_v1 artifact (see configReview.ts).
 *  `safety` is optional — an older artifact or a rewrite that skipped the
 *  cross-check may omit it; callers must treat its absence as "unverified". */
export interface ConfigRewrite {
  before: string;
  after: string;
  beforeAlwaysOnTokens: number;
  afterAlwaysOnTokens: number;
  tokenDelta: number;
  projectedMonthlyUsdDelta: number;
  safety?: { verified: boolean; droppedImperatives: string[]; warnings: string[] };
}

interface ReviewReport {
  rewrite?: ConfigRewrite | null;
}

function capFile(): string {
  return join(homedir(), '.cc-audit', 'fix-spend.json');
}

function readSpend(today: string): { date: string; count: number } {
  try {
    const parsed = JSON.parse(readFileSync(capFile(), 'utf8')) as { date: string; count: number };
    if (parsed.date === today) return parsed;
  } catch {
    /* no prior state for today */
  }
  return { date: today, count: 0 };
}

/** Read-only count of config-review calls charged locally today (for the UX counter). */
export function spendToday(today: string): number {
  return readSpend(today).count;
}

/** Throw if today's LOCAL backstop is exhausted. This is no longer the daily cap
 *  (the server enforces that per install) — it's a loose abuse ceiling so we can't be
 *  fully uncapped. Read-only: does NOT consume a slot, safe to call before the request. */
export function checkSpendCap(today: string, cap = BACKSTOP_CAP): void {
  if (readSpend(today).count >= cap) {
    throw new Error(
      `local config-review backstop reached (${cap}/day). The rewrite spends credits; ` +
        'try again tomorrow.',
    );
  }
}

/** Consume one backstop slot. Call this ONLY after a submission the server accepted —
 *  i.e. after credits are actually committed — so transient failures before that
 *  point never lock a user out. The counter climbs to the backstop (not the display
 *  cap) so a run where the server isn't yet enforcing still trips the local guard. */
export function recordSpend(today: string, cap = BACKSTOP_CAP): void {
  const state = readSpend(today);
  if (state.count >= cap) return; // defensive: never exceed the backstop
  state.count += 1;
  try {
    mkdirSync(join(homedir(), '.cc-audit'), { recursive: true });
    writeFileSync(capFile(), `${JSON.stringify(state)}\n`);
  } catch {
    /* best-effort; don't fail the run on a cap-file write error */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit a config bundle for review and poll until the rewrite is ready. Returns the
 * rewrite (or null if the engine produced none). `today` is passed in (no Date.now()
 * in the deterministic core) for the daily-cap key.
 */
export async function requestConfigRewrite(
  files: Array<{ path: string; content: string }>,
  today: string,
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
  targetRuntime = 'claude_code',
  installKey: string,
): Promise<ConfigRewrite | null> {
  // Gate on the LOCAL backstop BEFORE the request, but only CONSUME a slot once the
  // server has accepted the job (credits committed). A transient POST failure must not
  // burn a slot. The real per-install daily cap is enforced server-side via X-Install-Key.
  checkSpendCap(today);
  const base = apiBase.replace(/\/$/, '');
  const res = await fetch(`${base}/v1/public/config-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-install-key': installKey },
    body: JSON.stringify({ files, targetRuntime }),
  });
  if (!res.ok) {
    // Server-side cap for this install (429 rate, 402 out-of-credits): surface a clean
    // message instead of dumping the raw status/body.
    if (res.status === 429 || res.status === 402) {
      throw new Error('daily config-review cap reached (server-enforced) — try again tomorrow.');
    }
    const body = await res.text().catch(() => '');
    throw new Error(`config-review returned ${res.status}: ${body.slice(0, 200)}`);
  }
  // 202 ⇒ job enqueued ⇒ the rewrite + judge WILL run server-side. Charge the slot now.
  recordSpend(today);
  const { sessionId } = (await res.json()) as { sessionId: string };

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    const poll = await fetch(`${base}/v1/public/config-review/${sessionId}`, {
      headers: { 'x-install-key': installKey },
    });
    // 404 right after enqueue is expected (read-your-writes lag) — keep polling; the
    // session id came from our own 202, so it will materialize. Any other non-2xx is
    // also treated as transient until the overall timeout.
    if (poll.status === 404) throw new Error('config-review session not found (may have expired)');
    if (!poll.ok) continue;
    const { status, report } = (await poll.json()) as { status: string; report: ReviewReport | null };
    if (status === 'done' || status === 'complete') return report?.rewrite ?? null;
    if (status === 'failed' || status === 'error') throw new Error('config-review failed server-side');
  }
  throw new Error('config-review timed out (no result after ~2 min)');
}
