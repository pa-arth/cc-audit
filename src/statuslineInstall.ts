// Auto-wiring the live-guardrail statusline into claude-hud. claude-hud renders extra
// label providers passed via `--extra-cmd "<cmd>"` (it runs each with execAsync and appends
// the returned {"label":…}). So "installing" cc-audit means splicing ONE `--extra-cmd`
// argument into the user's existing claude-hud `statusLine.command` in settings.json — a
// single string that is itself a `bash -c '…'` blob. This file is the surgical patcher.
//
// It is deliberately CONSERVATIVE and never guesses:
//   - refuses if settings.json isn't plain JSON (comments ⇒ JSON.parse fails ⇒ we won't
//     round-trip it and strip their comments),
//   - refuses if the statusLine isn't claude-hud,
//   - refuses if a FOREIGN --extra-cmd is already present (never clobbers someone else's),
//   - is idempotent (already-installed ⇒ no-op),
//   - backs up settings.json before writing.
// Only an explicit `--install`/`--uninstall` or an interactive "yes" ever reaches the write
// path — the label emitter (`cc-audit statusline` with no flags) NEVER touches settings.json.

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTRA_CMD_FLAG = '--extra-cmd';
// The anchor inside the plugin blob: the hud entrypoint token. We splice our arg in right
// after it so it lands INSIDE the outer `bash -c '…'` single-quoted string.
const HUD_ENTRY_ANCHOR = 'src/index.ts"';

/** The exact fragment a user would paste if they wire it by hand. */
export function manualSnippet(value: string): string {
  return (
    "Add cc-audit as an --extra-cmd on your claude-hud statusLine.command in\n" +
    "settings.json — insert this immediately after the hud entrypoint (…src/index.ts\"),\n" +
    "inside the outer bash -c '…' string, using DOUBLE quotes:\n\n" +
    `    ${EXTRA_CMD_FLAG} "${value}"\n\n` +
    'For a bare "command": "claude-hud" it becomes:\n\n' +
    `    claude-hud ${EXTRA_CMD_FLAG} "${value}"\n`
  );
}

/** Is an --extra-cmd value OURS (either the on-PATH `cc-audit … statusline` or the absolute
 *  `<node> <…/cli.js> statusline` form)? Used for idempotency and safe uninstall — we only
 *  ever touch our own fragment, never a foreign one. */
export function isOurStatuslineValue(value: string): boolean {
  return /\bstatusline\b/.test(value) && /(cc-audit|cli\.js)/.test(value);
}

/** The first --extra-cmd value in a command string (double/single-quoted or bare), or null. */
export function findExtraCmdValue(command: string): string | null {
  const m = command.match(/--extra-cmd\s+("([^"]*)"|'([^']*)'|(\S+))/);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

export type PatchStatus =
  | 'patched'
  | 'already-installed'
  | 'foreign-extra-cmd'
  | 'not-hud'
  | 'unsafe-value'
  // A backup/write to settings.json threw — distinct from 'not-hud' (no claude-hud
  // statusline) so a caller routing on status can't misread I/O failure as bad setup.
  | 'io-error';

export interface PatchResult {
  // injectExtraCmd is a pure classifier — it never does I/O, so it can't yield 'io-error'
  // (that only comes from the settings.json write). Excluding it keeps the install switch
  // exhaustive without a dead branch.
  status: Exclude<PatchStatus, 'io-error'>;
  /** The rewritten command — only present when status === 'patched'. */
  command?: string;
}

/**
 * Splice ` --extra-cmd "<value>"` into a claude-hud command string. Pure — takes and returns
 * the raw command string, so it's trivially unit-testable over fixtures. Inserts after the
 * last hud entrypoint token (the plugin blob) or, for a bare `claude-hud`, at the end.
 */
export function injectExtraCmd(command: string, value: string): PatchResult {
  if (!command.includes('claude-hud')) return { status: 'not-hud' };
  // A double quote in the value would break the double-quoted fragment inside the outer
  // single-quoted bash -c string — refuse rather than emit a corrupt command.
  if (value.includes('"')) return { status: 'unsafe-value' };

  const existing = findExtraCmdValue(command);
  if (existing != null) {
    if (isOurStatuslineValue(existing)) return { status: 'already-installed' };
    return { status: 'foreign-extra-cmd' }; // never clobber someone else's extra-cmd
  }

  const fragment = ` ${EXTRA_CMD_FLAG} "${value}"`;
  const anchorIdx = command.lastIndexOf(HUD_ENTRY_ANCHOR);
  if (anchorIdx >= 0) {
    // Plugin blob: land the fragment right after `…src/index.ts"`, INSIDE the outer quote.
    const at = anchorIdx + HUD_ENTRY_ANCHOR.length;
    return { status: 'patched', command: command.slice(0, at) + fragment + command.slice(at) };
  }
  // Bare `claude-hud` (optionally with flags), no outer quote to stay inside — append.
  return { status: 'patched', command: command + fragment };
}

/** Remove OUR ` --extra-cmd "…"` fragment from a command string, restoring the original
 *  byte-for-byte. A foreign extra-cmd is left untouched. Idempotent. */
export function removeExtraCmd(command: string): string {
  const re = /\s*--extra-cmd\s+("([^"]*)"|'([^']*)'|(\S+))/;
  const m = command.match(re);
  if (!m || m.index == null) return command;
  const val = m[2] ?? m[3] ?? m[4] ?? '';
  if (!isOurStatuslineValue(val)) return command; // don't touch a foreign one
  return command.slice(0, m.index) + command.slice(m.index + m[0].length);
}

// ── settings.json I/O ────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Config dir; defaults to CLAUDE_CONFIG_DIR || ~/.claude. */
  configDir?: string;
  /** Override the extra-cmd value (tests). Otherwise resolved from the environment. */
  value?: string;
}

export type InstallOutcome =
  | { ok: true; status: 'patched' | 'already-installed'; value: string; message: string }
  | { ok: false; status: PatchStatus | 'jsonc' | 'no-settings'; value: string; message: string };

function configDirOf(opts: InstallOptions): string {
  return opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}
function settingsPathOf(opts: InstallOptions): string {
  return join(configDirOf(opts), 'settings.json');
}

/** Does `cc-audit` resolve on PATH? (In a minimal HUD env it might not — the dev-worktree
 *  case — so the caller falls back to an absolute node invocation.) */
export function ccAuditOnPath(): boolean {
  try {
    execFileSync('command', ['-v', 'cc-audit'], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

/** The extra-cmd value to install: the on-PATH `cc-audit statusline` when available, else an
 *  absolute, PATH-independent `<node> <…/cli.js> statusline` (the running binary + script). */
export function resolveExtraCmdValue(): { value: string; form: 'path' | 'absolute' } {
  if (ccAuditOnPath()) return { value: 'cc-audit statusline', form: 'path' };
  const node = process.execPath;
  const cli = process.argv[1] ? resolve(process.argv[1]) : '';
  return { value: `${node} ${cli} statusline`, form: 'absolute' };
}

/** Read + JSON-parse settings.json. Returns the parsed object and raw text, or an error tag
 *  ('no-settings' | 'jsonc') — we NEVER attempt to mutate a file we can't cleanly parse. */
function readSettings(
  opts: InstallOptions,
): { obj: Record<string, unknown>; raw: string } | { error: 'no-settings' | 'jsonc' } {
  let raw: string;
  try {
    raw = readFileSync(settingsPathOf(opts), 'utf8');
  } catch {
    return { error: 'no-settings' };
  }
  try {
    return { obj: JSON.parse(raw) as Record<string, unknown>, raw };
  } catch {
    return { error: 'jsonc' }; // comments / trailing commas — refuse, don't corrupt
  }
}

function statusLineCommand(obj: Record<string, unknown>): string | null {
  const sl = obj.statusLine as { type?: unknown; command?: unknown } | undefined;
  if (!sl || sl.type !== 'command' || typeof sl.command !== 'string') return null;
  return sl.command;
}

/** True when a claude-hud statusLine is present AND our extra-cmd is NOT yet installed AND the
 *  file is clean JSON — i.e. the interactive offer is worth making. Never writes. */
export function isOfferable(opts: InstallOptions = {}): boolean {
  const read = readSettings(opts);
  if ('error' in read) return false;
  const cmd = statusLineCommand(read.obj);
  if (cmd == null || !cmd.includes('claude-hud')) return false;
  const existing = findExtraCmdValue(cmd);
  return existing == null; // offer only when there's no extra-cmd yet (foreign ⇒ don't nag)
}

/** Install (idempotent). Backs up settings.json, splices our --extra-cmd in, writes 2-space
 *  JSON preserving every other key. Refuses (ok:false) on any ambiguity. Never throws. */
export function installStatusline(opts: InstallOptions = {}): InstallOutcome {
  const resolved = opts.value ? { value: opts.value, form: 'path' as const } : resolveExtraCmdValue();
  const value = resolved.value;
  const read = readSettings(opts);
  if ('error' in read) {
    if (read.error === 'no-settings') {
      return {
        ok: false,
        status: 'no-settings',
        value,
        message: `No settings.json at ${settingsPathOf(opts)}.\n\n${manualSnippet(value)}`,
      };
    }
    return {
      ok: false,
      status: 'jsonc',
      value,
      message:
        `${settingsPathOf(opts)} isn't plain JSON (comments or trailing commas). I won't ` +
        `rewrite it and risk corrupting it.\n\n${manualSnippet(value)}`,
    };
  }

  const cmd = statusLineCommand(read.obj);
  if (cmd == null || !cmd.includes('claude-hud')) {
    return {
      ok: false,
      status: 'not-hud',
      value,
      message: `No claude-hud statusLine found in ${settingsPathOf(opts)} to attach to.\n\n${manualSnippet(value)}`,
    };
  }

  const patch = injectExtraCmd(cmd, value);
  switch (patch.status) {
    case 'already-installed':
      return { ok: true, status: 'already-installed', value, message: 'Already installed — the guardrail line is wired into claude-hud.' };
    case 'foreign-extra-cmd':
      return {
        ok: false,
        status: 'foreign-extra-cmd',
        value,
        message: `Your claude-hud already has a different --extra-cmd; I won't overwrite it.\n\n${manualSnippet(value)}`,
      };
    case 'unsafe-value':
    case 'not-hud':
      return { ok: false, status: patch.status, value, message: `Couldn't safely patch the command.\n\n${manualSnippet(value)}` };
    case 'patched': {
      const path = settingsPathOf(opts);
      try {
        copyFileSync(path, `${path}.bak`);
        (read.obj.statusLine as { command: string }).command = patch.command!;
        writeFileSync(path, `${JSON.stringify(read.obj, null, 2)}\n`);
      } catch (err) {
        return { ok: false, status: 'io-error', value, message: `Failed to write settings.json: ${err instanceof Error ? err.message : String(err)}` };
      }
      const formNote =
        resolved.form === 'absolute'
          ? '\n(cc-audit is not on PATH, so I wired an absolute node invocation that works in the HUD\'s minimal environment.)'
          : '';
      return {
        ok: true,
        status: 'patched',
        value,
        message:
          `Wired the context-guardrail line into claude-hud (backup at ${path}.bak).${formNote}\n` +
          'It shows on the next HUD render. Remove it any time with:  cc-audit statusline --uninstall',
      };
    }
  }
}

/** Uninstall (idempotent). Backs up, removes our --extra-cmd fragment, writes. */
export function uninstallStatusline(opts: InstallOptions = {}): InstallOutcome {
  const value = 'cc-audit statusline';
  const read = readSettings(opts);
  if ('error' in read) {
    const status = read.error;
    return {
      ok: false,
      status,
      value,
      message:
        status === 'no-settings'
          ? `No settings.json at ${settingsPathOf(opts)}.`
          : `${settingsPathOf(opts)} isn't plain JSON; not touching it.`,
    };
  }
  const cmd = statusLineCommand(read.obj);
  if (cmd == null) {
    return { ok: true, status: 'already-installed', value, message: 'Nothing to remove — no claude-hud statusLine.' };
  }
  const next = removeExtraCmd(cmd);
  if (next === cmd) {
    return { ok: true, status: 'already-installed', value, message: 'Nothing to remove — the guardrail line was not installed.' };
  }
  const path = settingsPathOf(opts);
  try {
    copyFileSync(path, `${path}.bak`);
    (read.obj.statusLine as { command: string }).command = next;
    writeFileSync(path, `${JSON.stringify(read.obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, status: 'io-error', value, message: `Failed to write settings.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, status: 'patched', value, message: `Removed the guardrail line from claude-hud (backup at ${path}.bak).` };
}
