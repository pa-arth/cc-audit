// A persistent, resettable install key for cc-audit. It rides on the credit-spending
// config-review requests (as the `X-Install-Key` header) so the server can attribute
// and enforce spend per install — the client-side daily cap is only a UX counter + a
// loose backstop now (see fixClient.ts). The key is a random UUID, NOT derived from
// any machine attribute (unlike open.ts's `machineAnonId`), and is resettable by
// deleting the file. State lives in ~/.cc-audit/, matching consent.ts / fixClient.ts.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface InstallState {
  installKey?: string;
}

function installDir(): string {
  return join(homedir(), '.cc-audit');
}

function installPath(): string {
  return join(installDir(), 'install.json');
}

/**
 * Read the persisted install key, generating and persisting one on first use.
 * Persistence is best-effort: if the file can't be written (read-only home, etc.)
 * we still return a freshly generated key so this run has a usable identifier.
 */
export function getInstallKey(): string {
  try {
    const parsed = JSON.parse(readFileSync(installPath(), 'utf8')) as InstallState;
    if (parsed.installKey) return parsed.installKey;
  } catch {
    /* no prior key — generate one below */
  }
  const key = randomUUID();
  try {
    mkdirSync(installDir(), { recursive: true });
    writeFileSync(installPath(), `${JSON.stringify({ installKey: key } satisfies InstallState)}\n`);
  } catch {
    /* best-effort; return the ephemeral key for this run */
  }
  return key;
}
