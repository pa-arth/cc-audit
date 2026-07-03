import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildGuardScript,
  buildSettingsProposal,
  existingStatusLineCommand,
  readUserSettings,
} from '../contextGuard.js';

/** Run a generated guard script under real bash with the given stdin. */
function runScript(script: string, stdin: string): { out: string; status: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-audit-guard-'));
  const file = join(dir, 'guard.sh');
  writeFileSync(file, script, { mode: 0o755 });
  try {
    const out = execFileSync('bash', [file], { input: stdin, encoding: 'utf8' });
    return { out, status: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const statusJson = (pct: number | string) => JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: pct } });

describe('buildGuardScript — standalone', () => {
  const script = buildGuardScript({ existingCommand: null, monthlyUsd: 28.4 });

  it('nudges /compact past the warn threshold', () => {
    const { out } = runScript(script, statusJson(85));
    expect(out).toContain('ctx 85%');
    expect(out).toContain('/compact soon');
    expect(out).toContain('$28/mo habit');
  });

  it('escalates past the red threshold', () => {
    const { out } = runScript(script, statusJson(93));
    expect(out).toContain('/compact NOW');
  });

  it('stays quiet below the threshold', () => {
    const { out } = runScript(script, statusJson(40));
    expect(out).toContain('ctx 40%');
    expect(out).not.toContain('/compact');
  });

  it('truncates fractional percentages', () => {
    const { out } = runScript(script, statusJson(85.7));
    expect(out).toContain('ctx 85%');
  });

  it('degrades silently on malformed or empty stdin (pre-2.1.132 Claude Code)', () => {
    expect(runScript(script, 'not json').status).toBe(0);
    expect(runScript(script, '').status).toBe(0);
    expect(runScript(script, '{}').out.trim()).toBe('');
  });

  it('exposes the threshold as an editable variable', () => {
    expect(script).toContain('WARN_PCT=80');
    expect(script).toContain('RED_PCT=90');
  });
});

describe('buildGuardScript — wrapper mode', () => {
  it('runs the existing statusline first and appends the guard segment', () => {
    const script = buildGuardScript({ existingCommand: 'echo BASE-LINE', monthlyUsd: 10 });
    const { out } = runScript(script, statusJson(85));
    expect(out.startsWith('BASE-LINE')).toBe(true);
    expect(out).toContain('/compact soon');
  });

  it('re-pipes stdin so an existing command that consumes it still works', () => {
    // `head -c 9` eats stdin; the guard segment must still see used_percentage.
    const script = buildGuardScript({ existingCommand: 'head -c 9', monthlyUsd: 10 });
    const { out } = runScript(script, statusJson(85));
    expect(out).toContain('{"model":'); // the base output: first 9 bytes of the JSON
    expect(out).toContain('ctx 85%');
  });

  it('standalone script never references a base command', () => {
    const script = buildGuardScript({ existingCommand: null, monthlyUsd: 10 });
    expect(script).toContain('base=""');
    expect(script).not.toContain('original statusline');
  });
});

describe('settings read + proposal', () => {
  const home0 = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-guard-home-'));
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX → isolates ~/.claude
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });

  it('missing settings.json → raw and parsed null', () => {
    const s = readUserSettings();
    expect(s.raw).toBeNull();
    expect(s.parsed).toBeNull();
    expect(s.path).toBe(join(home, '.claude', 'settings.json'));
  });

  it('corrupt settings.json → raw set, parsed null', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json');
    const s = readUserSettings();
    expect(s.raw).toBe('{not json');
    expect(s.parsed).toBeNull();
  });

  it('extracts an existing statusLine command and ignores non-command types', () => {
    expect(existingStatusLineCommand({ statusLine: { type: 'command', command: 'my-hud' } })).toBe('my-hud');
    expect(existingStatusLineCommand({ statusLine: { type: 'static', text: 'x' } })).toBeNull();
    expect(existingStatusLineCommand({})).toBeNull();
    expect(existingStatusLineCommand(null)).toBeNull();
  });

  it('proposal preserves existing settings keys and parses as JSON', () => {
    const proposal = buildSettingsProposal({ permissions: { allow: ['Bash'] } }, '/home/u/.claude/guard.sh');
    const parsed = JSON.parse(proposal) as Record<string, unknown>;
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(parsed.statusLine).toEqual({ type: 'command', command: '/home/u/.claude/guard.sh' });
  });

  it('proposal from null settings is a minimal statusLine block', () => {
    const parsed = JSON.parse(buildSettingsProposal(null, '/x/guard.sh')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['statusLine']);
  });
});
