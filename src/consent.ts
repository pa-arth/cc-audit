// Consent state for cc-audit. Egress is tiered and consent is proportional to
// what leaves the machine:
//   Tier 0 (local read)  — sticky one-time ack; nothing leaves the machine.
//   Tier 1 (--judge)     — task gist + metadata to the hosted model; never code/paths.
//   Tier 2 (--open)      — privacy-safe aggregate to a PUBLIC shareable link.
//
// Only the Tier-0 ack is persisted (it's a one-time "yes, read my transcripts").
// Egress (Tiers 1–2) is re-confirmed every run — Tier 2 always defaults to No
// because the report is public. State lives in ~/.cc-audit/, matching fixClient.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConsentState {
  /** User has acknowledged the one-time "read my local transcripts" prompt. */
  localRead?: boolean;
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
