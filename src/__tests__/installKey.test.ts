import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { getInstallKey } from '../installKey.js';

describe('install key', () => {
  const home0 = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-install-'));
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX → isolates ~/.cc-audit
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });

  it('generates, persists, and returns the same key across calls', () => {
    const first = getInstallKey();
    expect(first).toMatch(/[0-9a-f-]{16,}/i); // a UUID-ish token
    // Persisted to ~/.cc-audit/install.json with the expected shape.
    const onDisk = JSON.parse(readFileSync(join(home, '.cc-audit', 'install.json'), 'utf8')) as {
      installKey?: string;
    };
    expect(onDisk.installKey).toBe(first);
    // Stable: a second call reads the persisted key rather than minting a new one.
    expect(getInstallKey()).toBe(first);
  });
});
