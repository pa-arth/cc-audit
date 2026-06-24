// Thin client for the hosted right-sizing judge (POST /v1/public/cost-audit).
// The deterministic half of cc-audit runs fully local; only this optional step
// (the trajectory-level judgment — the closed moat) calls our endpoint, which
// runs gpt-5.5 on our credits. Override the base URL with CC_AUDIT_API (e.g. a
// local API in dev).

import type { SessionFootprint } from './footprint.js';

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
}

const DEFAULT_API = 'https://api.promptster.ai';

export async function judgeFootprints(
  footprints: SessionFootprint[],
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
): Promise<RightSizingResult> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/public/cost-audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: footprints }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`cost-audit endpoint returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as RightSizingResult;
}

export interface PostReportResult {
  id: string;
  url: string;
  // Global, anonymous fluency percentile (you-vs-population), computed server-
  // side from the public corpus. Null until the corpus is large enough to rank
  // against. Rides on this response so the CLI prints it with no extra egress.
  benchmark?: { fluencyPercentile: number; cohortSize: number } | null;
}

/**
 * POST the privacy-safe aggregate (+ optional right-sizing SUMMARY — never the
 * per-task verdicts/gists) to the report store, returning a shareable id + url.
 */
export async function postReport(
  body: { aggregate: unknown; rightSizing?: unknown; anonId?: string },
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
): Promise<PostReportResult> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/public/cost-audit-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`cost-audit-report endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as PostReportResult;
}
