// Client for the hosted config-review (POST /v1/public/config-review → poll GET).
// The only `fix` path that spends our credits — the k=3 net-value judge runs
// server-side. Spend is enforced SERVER-SIDE, keyed by the `X-Install-Key` header;
// the local cap is a UX counter (DAILY_CAP) plus a loose abuse backstop
// (BACKSTOP_CAP) so we're never fully uncapped if server enforcement lags. The
// model-pin patches are purely local and don't touch this.
//
// We deliberately do NOT request the server's full-file REWRITE. It echoed the
// whole rewritten file back through a JSON envelope capped at ~4k output tokens, so
// any normal-sized CLAUDE.md truncated to unparseable JSON → a silent null. It was
// also risky (an auto-rewrite can drop a load-bearing rule). The judge's targeted
// findings round-trip regardless of file size and are review-first by nature, so
// that's what we surface.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_API = 'https://api.promptster.ai';
const POLL_MS = 2000;
const MAX_POLLS = 60; // ~2 min ceiling
export const DAILY_CAP = 10; // display-only: the per-install daily cap the SERVER enforces
const BACKSTOP_CAP = 50; // local abuse ceiling — the only guard if server enforcement lags

/** One targeted finding from the config_review_v1 artifact (see configReview.ts). */
export interface ConfigFinding {
  severity: 'high' | 'medium' | 'low';
  path: string | null;
  title: string;
  detail: string;
  suggestedChange: string | null;
}

/** The advisory slice of config_review_v1 we act on: the k=3 judge's net-value
 *  verdict plus its findings. `notes` carries engine notes (e.g. a judge sample
 *  that failed) so a degraded run surfaces WHY instead of vanishing. */
export interface ConfigReview {
  verdict: string; // net_positive | net_neutral | net_negative | insufficient_evidence
  findings: ConfigFinding[];
  notes: string[];
}

// The GET returns the full config_review_v1 artifact; we read only these fields.
interface ReviewReport {
  verdict?: string;
  findings?: ConfigFinding[] | null;
  meta?: { notes?: string[] | null } | null;
}

/** Normalize the untrusted network report into a ConfigReview. Defensive: the
 *  server validates the artifact, but this is third-party-shaped data on the wire. */
function normalizeReview(report: ReviewReport | null): ConfigReview | null {
  if (!report) return null;
  const findings = Array.isArray(report.findings)
    ? report.findings.filter((f): f is ConfigFinding => !!f && typeof f.title === 'string')
    : [];
  const notes = Array.isArray(report.meta?.notes)
    ? report.meta!.notes!.filter((n): n is string => typeof n === 'string')
    : [];
  return {
    verdict: typeof report.verdict === 'string' ? report.verdict : 'insufficient_evidence',
    findings,
    notes,
  };
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
 * Submit a config bundle for review and poll until the judge is done. Returns the
 * review (verdict + findings), or null if the server returned no report. `today` is
 * passed in (no Date.now() in the deterministic core) for the daily-cap key.
 */
export async function requestConfigReview(
  files: Array<{ path: string; content: string }>,
  today: string,
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
  targetRuntime = 'claude_code',
  installKey: string,
): Promise<ConfigReview | null> {
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
  // 202 ⇒ job enqueued ⇒ the k=3 judge WILL run server-side. Charge the slot now.
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
    // The server's terminal states are 'completed' / 'failed' (the persisted
    // configAuditStatus, echoed verbatim by the GET route). Match those. The
    // legacy 'done'/'complete'/'error' spellings are kept as tolerant aliases:
    // the two repos share no drift guard, so a status-word mismatch here silently
    // strands the client polling to the 2-min ceiling on EVERY completed review.
    if (status === 'completed' || status === 'done' || status === 'complete') {
      return normalizeReview(report);
    }
    if (status === 'failed' || status === 'error') throw new Error('config-review failed server-side');
  }
  throw new Error('config-review timed out (no result after ~2 min)');
}
