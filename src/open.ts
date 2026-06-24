// Zero-dependency browser-open + a stable anonymized machine id. Kept dep-light
// (no `open` npm package) so the single-file bundle stays small.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, hostname, platform } from 'node:os';

/** Open a URL in the default browser, fire-and-forget. Never throws. */
export function openURL(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    // On win32 `start` is a shell builtin; an empty title arg avoids quoting issues.
    const args = platform() === 'win32' ? ['', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true, shell: platform() === 'win32' }).unref();
  } catch {
    // best-effort — the URL is also printed to stdout
  }
}

/**
 * Stable, anonymized per-machine id for dedup / longitudinal "did they improve".
 * Hashed — the raw hostname/homedir never leave the machine. Not PII.
 */
export function machineAnonId(): string {
  return createHash('sha256').update(`${hostname()}|${homedir()}`).digest('hex').slice(0, 16);
}
