import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findExtraCmdValue,
  injectExtraCmd,
  installStatusline,
  isOurStatuslineValue,
  removeExtraCmd,
  uninstallStatusline,
} from '../statuslineInstall.js';

// The user's REAL claude-hud command blob (a `bash -c '…'` that ends in the hud entrypoint
// token `…src/index.ts"`, all inside the outer single quote).
const HUD_BLOB =
  'bash -c \'cols=$(stty size </dev/tty 2>/dev/null | awk \'"\'"\'{print $2}\'"\'"\'); ' +
  'plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-hud/*/ 2>/dev/null | tail -1); ' +
  'exec "/Users/x/.bun/bin/bun" --env-file /dev/null "${plugin_dir}src/index.ts"\'';

const VALUE = 'cc-audit statusline';

describe('injectExtraCmd — the plugin bash -c blob', () => {
  it('injects the fragment right after the last src/index.ts" token, double-quoted', () => {
    const r = injectExtraCmd(HUD_BLOB, VALUE);
    expect(r.status).toBe('patched');
    const cmd = r.command!;
    // The fragment is present with DOUBLE quotes…
    expect(cmd).toContain(`src/index.ts" --extra-cmd "${VALUE}"`);
    // …and lands INSIDE the outer bash -c '…' string (before its closing single quote).
    expect(cmd.endsWith(`--extra-cmd "${VALUE}"'`)).toBe(true);
    // Quoting is balanced: even number of unescaped double quotes, outer single quotes matched.
    expect((cmd.match(/"/g) ?? []).length % 2).toBe(0);
    expect(cmd.startsWith("bash -c '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    // Round-trip: uninstall restores the original byte-for-byte.
    expect(removeExtraCmd(cmd)).toBe(HUD_BLOB);
  });
});

describe('injectExtraCmd — bare claude-hud', () => {
  it('appends the fragment after a bare "command":"claude-hud"', () => {
    const r = injectExtraCmd('claude-hud', VALUE);
    expect(r.status).toBe('patched');
    expect(r.command).toBe(`claude-hud --extra-cmd "${VALUE}"`);
    expect(removeExtraCmd(r.command!)).toBe('claude-hud');
  });
});

describe('injectExtraCmd — safety / idempotency', () => {
  it('is a no-op when our extra-cmd is already present', () => {
    const once = injectExtraCmd(HUD_BLOB, VALUE).command!;
    expect(injectExtraCmd(once, VALUE).status).toBe('already-installed');
  });

  it('refuses (never clobbers) when a FOREIGN --extra-cmd is present', () => {
    const foreign = injectExtraCmd(HUD_BLOB, 'some-other-plugin').command!;
    expect(foreign).toContain('--extra-cmd "some-other-plugin"');
    const r = injectExtraCmd(foreign, VALUE);
    expect(r.status).toBe('foreign-extra-cmd');
    expect(r.command).toBeUndefined();
  });

  it('refuses a non-claude-hud command', () => {
    expect(injectExtraCmd('bash -c \'exec my-own-statusline\'', VALUE).status).toBe('not-hud');
  });

  it('refuses a value containing a double quote (would break the outer quoting)', () => {
    expect(injectExtraCmd(HUD_BLOB, 'cc-audit "statusline"').status).toBe('unsafe-value');
  });
});

describe('isOurStatuslineValue', () => {
  it('recognizes both the on-PATH and the absolute forms, and rejects foreign values', () => {
    expect(isOurStatuslineValue('cc-audit statusline')).toBe(true);
    expect(isOurStatuslineValue('/usr/bin/node /Users/x/repos/cc-audit/dist/cli.js statusline')).toBe(true);
    expect(isOurStatuslineValue('some-other-plugin')).toBe(false);
    expect(isOurStatuslineValue('weather-statusline')).toBe(false); // has "statusline" but not ours
  });
});

describe('findExtraCmdValue', () => {
  it('extracts double, single, and bare extra-cmd values', () => {
    expect(findExtraCmdValue('claude-hud --extra-cmd "a b"')).toBe('a b');
    expect(findExtraCmdValue("claude-hud --extra-cmd 'a b'")).toBe('a b');
    expect(findExtraCmdValue('claude-hud --extra-cmd bare')).toBe('bare');
    expect(findExtraCmdValue('claude-hud')).toBeNull();
  });
});

// ── settings.json patcher (over TEMP fixtures — never the real ~/.claude) ─────────────────

function tempSettings(statusLine: unknown, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccaudit-settings-'));
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ ...extra, statusLine }, null, 2)}\n`);
  return dir;
}
const readCmd = (dir: string): string =>
  (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).statusLine as { command: string }).command;

describe('installStatusline / uninstallStatusline (settings.json)', () => {
  it('patches a claude-hud settings.json, preserving other keys, and round-trips on uninstall', () => {
    const dir = tempSettings({ type: 'command', command: HUD_BLOB }, { theme: 'dark', model: 'sonnet' });
    const r = installStatusline({ configDir: dir, value: VALUE });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('patched');
    expect(readCmd(dir)).toContain(`--extra-cmd "${VALUE}"`);
    // Other keys survive the rewrite.
    const obj = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(obj.theme).toBe('dark');
    expect(obj.model).toBe('sonnet');
    // A backup was written.
    expect(readFileSync(join(dir, 'settings.json.bak'), 'utf8')).toContain('claude-hud');
    // Idempotent install.
    expect(installStatusline({ configDir: dir, value: VALUE }).status).toBe('already-installed');
    // Uninstall restores the original command byte-for-byte.
    const u = uninstallStatusline({ configDir: dir });
    expect(u.ok).toBe(true);
    expect(readCmd(dir)).toBe(HUD_BLOB);
    // Uninstall is idempotent.
    expect(uninstallStatusline({ configDir: dir }).message).toMatch(/not installed|Nothing to remove/i);
  });

  it('refuses a non-claude-hud statusLine and leaves the file unchanged', () => {
    const dir = tempSettings({ type: 'command', command: 'bash -c \'exec my-statusline\'' });
    const before = readFileSync(join(dir, 'settings.json'), 'utf8');
    const r = installStatusline({ configDir: dir, value: VALUE });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('not-hud');
    expect(r.message).toContain('--extra-cmd'); // prints the manual snippet
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  });

  it('refuses a settings.json with comments (JSONC) — never corrupts it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccaudit-jsonc-'));
    const jsonc = '{\n  // my hud\n  "statusLine": { "type": "command", "command": "claude-hud" }\n}\n';
    writeFileSync(join(dir, 'settings.json'), jsonc);
    const r = installStatusline({ configDir: dir, value: VALUE });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('jsonc');
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(jsonc); // untouched
  });

  it('refuses when a foreign --extra-cmd is already present, file unchanged', () => {
    const foreign = injectExtraCmd(HUD_BLOB, 'weather-plugin').command!;
    const dir = tempSettings({ type: 'command', command: foreign });
    const before = readFileSync(join(dir, 'settings.json'), 'utf8');
    const r = installStatusline({ configDir: dir, value: VALUE });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('foreign-extra-cmd');
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  });
});
