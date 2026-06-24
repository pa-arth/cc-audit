import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { readConsent, writeConsent } from '../consent.js';

describe('consent state', () => {
  const home0 = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-consent-'));
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX → isolates ~/.cc-audit
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns empty when no consent file exists', () => {
    expect(readConsent()).toEqual({});
  });

  it('persists the local-read ack across reads', () => {
    writeConsent({ localRead: true });
    expect(readConsent().localRead).toBe(true);
  });

  it('merges patches rather than clobbering prior state', () => {
    writeConsent({ localRead: true });
    writeConsent({}); // no-op patch must not drop the prior ack
    expect(readConsent().localRead).toBe(true);
  });
});
