// Thin client for the hosted right-sizing judge (POST /v1/public/cost-audit).
// The deterministic half of cc-audit runs fully local; only this optional step
// (the trajectory-level judgment — the closed moat) calls our endpoint, which
// runs gpt-5.5 on our credits. Override the base URL with CC_AUDIT_API (e.g. a
// local API in dev).

import type { SessionFootprint } from './footprint.js';
import type { HygieneJudgeItem, HygieneVerdict } from './hygieneFootprint.js';

export interface Verdict {
  minTier: 'haiku' | 'sonnet' | 'frontier';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  savingsUsd: number;
  overModeled: boolean;
  unassessed: boolean;
}

export interface RightSizingResult {
  verdicts: Verdict[];
  summary: {
    judged: number;
    overModeledCount: number;
    overModeledShare: number;
    totalCostUsd: number;
    totalSavingsUsd: number;
    savingsShare: number;
  };
  /** Context-hygiene refinement — POSITIONAL to the `hygiene` items sent in the request.
   *  Optional: a backend that predates the ride-along omits it and the CLI keeps the
   *  deterministic avoidable-carry headline. */
  hygiene?: HygieneVerdict[];
}

const DEFAULT_API = 'https://api.promptster.ai';

// The hosted judge runs a model pass behind a gateway (Cloudflare), so a transient
// 502/503/504 or a dropped connection is expected background noise — one slow gpt-5.5
// call in the batch can tip the origin over the proxy timeout. Without a retry, that
// blip discards an entire consented right-sizing run. 5xx/429/408/network are retried;
// 4xx (a real, actionable validation error) is not.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pull a human-meaningful message out of an error body, discarding gateway HTML.
 *  A Cloudflare 502 page (`<!DOCTYPE html>…`) carries no signal — never surface it. */
function summarizeBody(body: string): string {
  const t = body.trim();
  if (!t || t.startsWith('<')) return ''; // gateway/HTML error page — nothing useful
  try {
    const j = JSON.parse(t) as { error?: unknown };
    if (typeof j.error === 'string') return j.error;
  } catch {
    /* not JSON — fall through to a truncated snippet */
  }
  return t.slice(0, 200);
}

/** POST JSON to the hosted API with bounded retries on transient failures, and
 *  clean (HTML-free) error messages. `service` labels the endpoint for the user. */
async function postJson<T>(url: string, body: string, service: string): Promise<T> {
  let lastDetail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch (e) {
      // network / DNS / connection reset — transient
      lastDetail = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw new Error(`${service} unreachable: ${lastDetail}`);
    }
    if (res.ok) return (await res.json()) as T;

    const text = await res.text().catch(() => '');
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      lastDetail = `HTTP ${res.status}`;
      await sleep(RETRY_BASE_MS * attempt);
      continue;
    }
    // Out of retries, or a non-retryable status.
    if (res.status >= 500) {
      throw new Error(`${service} temporarily unavailable (${res.status}) — please try again in a moment.`);
    }
    const snippet = summarizeBody(text);
    throw new Error(`${service} returned ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  /* unreachable — the loop either returns or throws */
  throw new Error(`${service} failed${lastDetail ? `: ${lastDetail}` : ''}`);
}

export async function judgeFootprints(
  footprints: SessionFootprint[],
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
  hygiene: HygieneJudgeItem[] = [],
  anonId?: string,
): Promise<RightSizingResult> {
  // `hygiene` rides in the SAME request — the judge scores both in one model pass; an
  // older backend ignores the extra field and returns no `hygiene` verdicts.
  // `anonId` (privacy-safe hash, no hostname/path) lets the backend persist + attribute
  // every judge call to an install for the benchmark cohort / dedup — the model pass is
  // paid for whether or not the user later shares, so the corpus should capture it. An
  // older backend ignores the field.
  return postJson<RightSizingResult>(
    `${apiBase.replace(/\/$/, '')}/v1/public/cost-audit`,
    JSON.stringify({ sessions: footprints, hygiene, anonId }),
    'right-sizing service',
  );
}

export interface PostReportResult {
  id: string;
  url: string;
  // Legacy benchmark shape (kept for older CLIs): global anonymous percentile,
  // null until the corpus crosses MIN_COHORT.
  benchmark?: { fluencyPercentile: number; cohortSize: number } | null;
  // The gated, server-computed readout: a coarse BAND (always present once the
  // signals are scoreable — cold-start uses absolute cutoffs, warm uses percentile
  // tertiles), the relative percentile (null below MIN_COHORT), and the single
  // highest-leverage nudge. The score/thresholds themselves stay server-side.
  fluency?: {
    score: number | null;
    band: 'Developing' | 'Strong' | 'Elite' | null;
    percentile: number | null;
    cohortSize: number;
    whatMovesYouUp: string | null;
  } | null;
}

/**
 * POST the privacy-safe aggregate (+ optional right-sizing SUMMARY — never the
 * per-task verdicts/gists) to the report store, returning a shareable id + url.
 */
export async function postReport(
  body: { aggregate: unknown; rightSizing?: unknown; hygieneRefinement?: unknown; anonId?: string },
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
): Promise<PostReportResult> {
  return postJson<PostReportResult>(
    `${apiBase.replace(/\/$/, '')}/v1/public/cost-audit-report`,
    JSON.stringify(body),
    'report service',
  );
}
