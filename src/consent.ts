// Consent state for cc-audit. Egress is tiered and consent is proportional to
// what leaves the machine:
//   Tier 0 (local read)  — sticky one-time ack; nothing leaves the machine.
//   Tier 1 (capture)     — aggregate + task gists, on a sticky one-time answer.
//   Tier 1 (--judge)     — task gist + metadata to the hosted model; never code/paths.
//   Tier 2 (--open)      — privacy-safe aggregate to a PUBLIC shareable link.
//
// The Tier-0 ack and the capture answer are PERSISTED and asked exactly once. Capture
// in particular is never re-prompted once answered — re-asking someone who said no is
// the behavior that turns disclosed capture into a dark pattern, so `capture` is
// deliberately tri-state (undefined = not yet asked).
//
// The flag-driven egress paths (--judge / --open) are NOT persisted: the flag is the
// consent, re-given every run, and --open always requires it because the report is
// public. State lives in ~/.cc-audit/, matching fixClient.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConsentState {
  /** User has acknowledged the one-time "read my local transcripts" prompt. */
  localRead?: boolean;
  /** Capture: true = on, false = opted out, ABSENT = never asked. Never re-prompted
   *  once set either way; an upgrade must not reset it (hence: persisted, not derived). */
  capture?: boolean;
  /** When they answered, so the disclosure they saw can be dated. */
  captureAnsweredAt?: string;
}

function consentDir(): string {
  return join(homedir(), '.cc-audit');
}

function consentPath(): string {
  return join(consentDir(), 'consent.json');
}

export function readConsent(): ConsentState {
  try {
    return JSON.parse(readFileSync(consentPath(), 'utf8')) as ConsentState;
  } catch {
    return {};
  }
}

export function writeConsent(patch: Partial<ConsentState>): void {
  const next: ConsentState = { ...readConsent(), ...patch };
  try {
    mkdirSync(consentDir(), { recursive: true });
    writeFileSync(consentPath(), `${JSON.stringify(next)}\n`);
  } catch {
    /* best-effort; never fail the run on a consent-file write error */
  }
}
