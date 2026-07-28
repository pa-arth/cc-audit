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

/** How long we keep it. Stated verbatim in the first-run disclosure.
 *
 *  This MUST track what the backend actually does, not what we'd like to promise. The
 *  `publicSoloScrub` worker de-identifies `solo_captures` on a 90-day window, so an
 *  earlier "kept until you ask us to delete it" was simply false — it read as indefinite
 *  retention we do not perform. If the retention window moves, this line moves with it,
 *  and so does the published policy page. */
export const RETENTION_COPY = 'de-identified after 90 days, or deleted sooner on request';

/** Self-serve erasure. Works with no account: possession of the key is the proof. */
export const DELETE_ENDPOINT = '/v1/public/solo/data';

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

/**
 * Apply the shareable-link answer to the SHARING setting. Sharing no longer has a confirm
 * of its own — it rides on that one question — so this is the whole rule, in one place.
 *
 * ONLY a yes writes. A no is deliberately a no-op, not `setCapture(false)`:
 *   • Declining to publish a public URL is a different decision from declining to share
 *     privately. Recording it as the latter puts words in their mouth.
 *   • It must not revoke a previous yes, or a user who shares happily but doesn't want
 *     THIS report public would silently lose the setting by answering the visible question.
 *   • It must not consume the tri-state `undefined`, which is what preserves the ability
 *     to ask again on a later run.
 * Sharing is turned off by `cc-audit capture --off`, and by nothing else.
 */
export function applyShareLinkAnswer(yes: boolean): void {
  if (yes) setCapture(true);
}

/** The disclosure shown wherever sharing is turned on. States what is sent, what never
 *  is, how long it is kept, and how to turn it off — in the terminal, not behind a link.
 *
 *  This is the DISCLAIMER half of the shareable-link question: saying yes there both
 *  publishes the report and switches sharing on, so the text has to stand on its own
 *  without a confirm of its own to carry it. Nothing here may be softened — a shorter,
 *  friendlier version of this paragraph is the failure mode, not an improvement. */
export function captureDisclosure(gistCount: number): string {
  return [
    'It also switches on data sharing with Promptster, so we can make the tool better.',
    'That sends the same metrics report you just read — including your spend figures in',
    `dollars — and ${gistCount} task gist${gistCount === 1 ? '' : 's'}: the prompt text you typed, plus model/turn/tool counts.`,
    '',
    `  • Never read from disk: your source code, your diffs, your file tree.`,
    `  • Task gists are your prompts VERBATIM (700 chars each). We don't add paths or`,
    `    repo names — but we don't strip what you typed. Type one, and it goes.`,
    `  • Attributed to a random install key — not your name, email, or hostname.`,
    `  • Retention: ${RETENTION_COPY}.`,
    '  • It stays on for future runs until you turn it off:  cc-audit capture --off',
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
    const base = (process.env.CC_AUDIT_API ?? DEFAULT_API).replace(/\/$/, '');
    const key = getInstallKey();
    lines.push(
      `Install key: ${key}`,
      `Retention: ${RETENTION_COPY}.`,
      '',
      'Delete everything stored under that key — no account needed, takes effect immediately:',
      `  curl -X DELETE ${base}${DELETE_ENDPOINT} \\`,
      "    -H 'content-type: application/json' \\",
      `    -d '{"installKey":"${key}"}'`,
      '',
      'Turn off future sends:  cc-audit capture --off',
    );
  } else if (setting === false) {
    lines.push('Turn on:  cc-audit capture --on');
  }
  return `${lines.join('\n')}\n`;
}
