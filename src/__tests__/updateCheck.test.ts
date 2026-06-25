import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, renderUpdateNotice } from '../updateCheck.js';

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1);
    expect(compareVersions('0.3.0', '0.3.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  });

  it('tolerates a leading v and ignores prerelease/build suffixes', () => {
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBe(0); // core-only comparison
    expect(compareVersions('1.2.0', '1.2.1-beta')).toBe(-1);
  });

  it('treats missing/garbage segments as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.3')).toBe(-1);
  });
});

describe('checkForUpdate (cached, no network)', () => {
  const home0 = process.env.HOME;
  const now = 1_700_000_000_000;
  let home: string;

  function seedCache(latest: string, checkedAt: number): void {
    mkdirSync(join(home, '.cc-audit'), { recursive: true });
    writeFileSync(join(home, '.cc-audit', 'update-check.json'), JSON.stringify({ latest, checkedAt }));
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-update-'));
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX → isolates ~/.cc-audit
  });
  afterEach(() => {
    delete process.env.CC_AUDIT_NO_UPDATE_CHECK;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });

  it('flags a notice when the cached latest is ahead', async () => {
    seedCache('0.4.0', now);
    expect(await checkForUpdate('0.3.0', now)).toEqual({ current: '0.3.0', latest: '0.4.0' });
  });

  it('returns undefined when up to date', async () => {
    seedCache('0.3.0', now);
    expect(await checkForUpdate('0.3.0', now)).toBeUndefined();
  });

  it('is silenced by opt-out env vars (never touches cache or network)', async () => {
    seedCache('99.0.0', now);
    process.env.CC_AUDIT_NO_UPDATE_CHECK = '1';
    expect(await checkForUpdate('0.3.0', now)).toBeUndefined();
  });
});

describe('renderUpdateNotice', () => {
  it('mentions both versions and the update command', () => {
    const out = renderUpdateNotice({ current: '0.3.0', latest: '0.4.0' });
    expect(out).toContain('0.3.0');
    expect(out).toContain('0.4.0');
    expect(out).toContain('npm i -g @promptster/cc-audit');
  });
});
