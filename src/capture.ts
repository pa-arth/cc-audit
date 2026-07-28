// Disclosed capture — the ONE recurring egress path in cc-audit.
//
// What leaves the machine when it is on: the privacy-safe aggregate record
// (aggregate.ts — shares, counts, ratios; never raw project names or paths) plus the
// per-task GISTS that footprint.ts already builds for --judge (the prompt text the user
// typed, truncated by the adapter; never code, diffs, file contents, or paths — subagent
// spans are excluded there precisely because their machine-authored prompts can embed
// both). Attributed to the resettable install key from installKey.ts, which carries no
// name, email, hostname, or repo name.
//
// What NEVER leaves, under any flag: source code and diffs. That exclusion has no opt-in.
//
// Consent is asked ONCE, persisted, and never re-prompted — including (especially) when
// the answer was no. A run that has not been consented sends nothing, and the whole
// transmission is best-effort: it never throws, never blocks the report, and never
// prints on failure.

import type { SessionFootprint } from './footprint.js';
import { getInstallKey } from './installKey.js';
import { readConsent, writeConsent } from './consent.js';

const DEFAULT_API = 'https://api.promptster.ai';
const TIMEOUT_MS = 4000;

export const CAPTURE_SCHEMA_VERSION = 1;

/** How long we keep it. Stated verbatim in the first-run disclosure — if this changes,
 *  the published policy changes with it. */
export const RETENTION_COPY = 'kept until you ask us to delete it';

export interface CapturePayload {
  schemaVersion: number;
  installKey: string;
  sentAt: string;
  aggregate: unknown;
  /** The same task gists --judge sends: user-typed prompt + structural metadata. */
  gists: SessionFootprint[];
}

/** Tri-state: undefined = never asked (so we may ask); true/false = answered, never re-ask. */
export function captureSetting(): boolean | undefined {
  return readConsent().capture;
}

export function setCapture(on: boolean): void {
  writeConsent({ capture: on, captureAnsweredAt: new Date().toISOString() });
}

/** The disclosure shown with the capture question. States what is sent, what never is,
 *  how long it is kept, and how to turn it off — in the terminal, not behind a link. */
export function captureDisclosure(gistCount: number): string {
  return [
    'Sharing sends your privacy-safe metrics (shares, counts, ratios — never raw',
    `dollar amounts) and ${gistCount} task gist${gistCount === 1 ? '' : 's'}: the prompt text you typed, plus`,
    'model/turn/tool counts.',
    '',
    `  • Never sent: your source code, diffs, file paths, or repo names.`,
    `  • Attributed to a random install key — not your name, email, or hostname.`,
    `  • Retention: ${RETENTION_COPY}.`,
    '  • Turn it off any time:  cc-audit capture --off   (permanent, never re-asked)',
    '  • See or delete your data:  cc-audit capture --status',
  ].join('\n');
}

export function buildCapturePayload(aggregate: unknown, gists: SessionFootprint[]): CapturePayload {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    installKey: getInstallKey(),
    sentAt: new Date().toISOString(),
    aggregate,
    gists,
  };
}

/**
 * Transmit, if and only if capture is switched on. Returns true when the server
 * accepted it. Every failure path — opted out, offline, endpoint missing, non-2xx,
 * timeout — resolves false silently. Capture must never be able to break a local run.
 */
export async function sendCapture(
  aggregate: unknown,
  gists: SessionFootprint[],
  apiBase: string = process.env.CC_AUDIT_API ?? DEFAULT_API,
): Promise<boolean> {
  if (captureSetting() !== true) return false;
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/public/solo-capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildCapturePayload(aggregate, gists)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** `cc-audit capture --status` — the developer's own view of their setting + key. */
export function captureStatus(): string {
  const setting = captureSetting();
  const state =
    setting === true ? 'ON — metrics + task gists are shared' : setting === false ? 'OFF — nothing is sent' : 'not set — you have not been asked yet';
  const lines = [`Capture: ${state}`];
  if (setting === true) {
    lines.push(
      `Install key: ${getInstallKey()}`,
      `Retention: ${RETENTION_COPY}.`,
      'To delete everything stored under that key, email privacy@promptster.ai with it.',
      'Turn off:  cc-audit capture --off',
    );
  } else if (setting === false) {
    lines.push('Turn on:  cc-audit capture --on');
  }
  return `${lines.join('\n')}\n`;
}
