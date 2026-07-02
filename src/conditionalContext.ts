// Conditional-context tax (Bug 2): a CLAUDE.md instruction like "read ERRORS.md
// before making changes" pulls ERRORS.md into context whenever Claude follows it.
// That's NOT always-on the way an `@import` is — it loads only when the instruction
// fires — so we report it SEPARATELY and never fold it into the always-on config total
// (folding it would repeat the over-promise mistake the always-on module warns about).
//
// Detection is deterministic (regex over the config text) so it fires regardless of
// how many sessions exist — that's what catches a fresh setup's "read X first" rule
// where a pure-transcript signal would be silent. Where the project has enough
// sessions, we additionally CONFIRM empirically: how often that file actually got
// Read, and how early. Detect deterministically, confirm when the data supports it,
// label confidence explicitly.
//
// SECURITY: every file the regex points at is resolved + counted through
// readConfigFile (the configFiles.ts trust gateway) — same scope/size/realpath
// guards as `@imports`. A hostile repo CLAUDE.md saying "read /etc/passwd" gets the
// out-of-tree treatment (size-only, never read), not contents in memory.

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readConfigFile, resolveConfigRef, sanitizeUntrusted, stripCode } from './configFiles.js';
import type { Session } from './model.js';

/** Below this many relevant sessions, "fraction that read X" is statistical noise
 *  (the audit corpus averages ~1.7 sessions/project), so we report the instruction
 *  as detected-but-unverified rather than attach a bogus rate. */
const MIN_SESSIONS_FOR_CONFIRM = 5;

/** Backstop against a pathological CLAUDE.md with thousands of "read X" lines. */
const MAX_REFS_PER_FILE = 50;

/** Backstop against a repo with a pathological number of skills, each with refs. */
const MAX_ITEMS = 200;

export interface ConditionalContextItem {
  /** Basename of the referenced file (e.g. "ERRORS.md"). Never a full path. */
  file: string;
  /** Tokens that file adds to context when the instruction is followed. */
  tokens: number;
  /** The matched instruction text itself (sanitized, whitespace-collapsed) — what the
   *  user would cut. LOCAL-ONLY: never uploaded (aggregate.ts consumes counts only). */
  instruction: string;
  /** Absolute path of the config file the instruction lives in — the file to edit.
   *  LOCAL-ONLY: never uploaded (aggregate.ts consumes counts only). */
  sourcePath: string;
  /** Where the instruction lives. A skill body is DOUBLE-conditional: it loads only
   *  when the skill is invoked, and the read happens only if Claude then obeys — so
   *  its confirmation denominator is sessions that invoked the skill, not all sessions. */
  source: 'global-claude-md' | 'project-claude-md' | 'skill';
  /** Project label for project-scoped instructions; null for the global CLAUDE.md. */
  project: string | null;
  /** Sanitized skill name when source === 'skill'; null otherwise. */
  skill: string | null;
  /** Share of relevant sessions that actually Read this file — null when too few
   *  sessions to judge (detected but unverified). */
  observedReadRate: number | null;
  /** Median turn index of the first read, across sessions that read it. A low value
   *  (≤~3) is the signature of a standing instruction vs. incidental task work. */
  observedMedianFirstTurn: number | null;
  /** How many sessions the confirmation considered (transparency on confidence). */
  sessionsConsidered: number;
}

// An imperative verb, then within a short window a path-ish token ending in a file
// extension. The extension + the existence check in scanForRefs are the real filter:
// "read the README" (no ext) and "see section 2.1" (resolves to nothing) are dropped.
const INSTRUCTION_RE =
  /\b(?:read|consult|review|check|see|follow|refer to|look at|load|open)\b[^\n]{0,40}?([~./\w-]*[\w-]+\.[A-Za-z]{1,6})\b/gi;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** 1-based index of the first turn in the session that Read `file` (by basename), or
 *  null if it was never read. */
function firstReadTurn(s: Session, file: string): number | null {
  let idx = 0;
  for (const span of s.spans) {
    for (const t of span.turns) {
      idx += 1;
      if (t.reads.includes(file)) return idx;
    }
  }
  return null;
}

function confirm(
  sessions: Session[],
  file: string,
): Pick<ConditionalContextItem, 'observedReadRate' | 'observedMedianFirstTurn' | 'sessionsConsidered'> {
  const n = sessions.length;
  if (n < MIN_SESSIONS_FOR_CONFIRM) {
    return { observedReadRate: null, observedMedianFirstTurn: null, sessionsConsidered: n };
  }
  const firstTurns: number[] = [];
  for (const s of sessions) {
    const idx = firstReadTurn(s, file);
    if (idx !== null) firstTurns.push(idx);
  }
  return {
    observedReadRate: firstTurns.length / n,
    observedMedianFirstTurn: firstTurns.length ? median(firstTurns) : null,
    sessionsConsidered: n,
  };
}

/** Imperative file references in a block of config text, resolved + counted through
 *  the trust gateway. `selfReal` (the realpath of the file the text came from) drops
 *  self-references. Returns one entry per distinct referenced basename. */
function scanRefsInText(
  text: string,
  fromDir: string,
  trustRoots: string[],
  selfReal: string | null,
): { file: string; tokens: number; instruction: string }[] {
  const out = new Map<string, { tokens: number; instruction: string }>(); // basename -> first match
  let processed = 0;
  for (const m of stripCode(text).matchAll(INSTRUCTION_RE)) {
    if (processed >= MAX_REFS_PER_FILE) break;
    processed += 1;
    const resolved = resolveConfigRef(m[1]!, fromDir);
    if (!resolved) continue;
    const ref = readConfigFile(resolved, trustRoots);
    if (!ref || ref.tokens === 0) continue; // doesn't exist / empty ⇒ not a real ref
    if (selfReal && ref.real === selfReal) continue; // self-reference (e.g. "read this file")
    // INVARIANT: the basename AND the matched instruction come from an untrusted config
    // file and flow into the report, so both pass the sanitizer before they ever become
    // output — no newlines or instruction markers can ride along, even if hostile.
    const base = sanitizeUntrusted(basename(resolved));
    if (!base) continue;
    if (!out.has(base)) out.set(base, { tokens: ref.tokens, instruction: sanitizeUntrusted(m[0]!) });
  }
  return [...out].map(([file, v]) => ({ file, tokens: v.tokens, instruction: v.instruction }));
}

/** Imperative refs in one CLAUDE.md (read through the gateway). */
function scanForRefs(
  configPath: string,
  trustRoots: string[],
): { file: string; tokens: number; instruction: string }[] {
  const f = readConfigFile(configPath, trustRoots);
  if (!f || f.text === null) return []; // missing, or untrusted/oversize (can't scan safely)
  return scanRefsInText(f.text, dirname(configPath), trustRoots, f.real);
}

/** The skill's declared `name:` (matches how invocations are logged), falling back to
 *  the directory name. RAW — caller sanitizes for display, keeps raw for matching. */
function skillName(text: string, dirName: string): string {
  return /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? dirName;
}

/** Sessions that invoked a skill by either its declared name or its directory slug. */
function sessionsInvoking(sessions: Session[], rawName: string, dirName: string): Session[] {
  return sessions.filter((s) =>
    s.spans.some((sp) => sp.invokedSkills.includes(rawName) || sp.invokedSkills.includes(dirName)),
  );
}

/** Scan every SKILL.md under one skills dir for "read X" instructions. `scopeSessions`
 *  is the population the skill could have been invoked in (all sessions for user skills;
 *  one project's sessions for project skills). */
function scanSkillsDir(
  skillsDir: string,
  trustRoots: string[],
  scopeSessions: Session[],
  project: string | null,
  items: ConditionalContextItem[],
): void {
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return; // no skills dir here
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (items.length >= MAX_ITEMS) return;
    const skillPath = join(skillsDir, e.name, 'SKILL.md');
    const f = readConfigFile(skillPath, trustRoots);
    if (!f || f.text === null) continue;
    const refs = scanRefsInText(f.text, dirname(skillPath), trustRoots, f.real);
    if (refs.length === 0) continue;

    const rawName = skillName(f.text, e.name);
    const display = sanitizeUntrusted(rawName);
    // Double-conditional: the instruction can only fire when the skill ran, so confirm
    // ONLY against sessions that invoked it. (We don't further require the read to come
    // AFTER the invocation turn — at these sample sizes that precision isn't worth the
    // complexity; the invoked-session filter already removes the bulk of the noise.)
    const invoked = sessionsInvoking(scopeSessions, rawName, e.name);
    for (const r of refs) {
      if (items.length >= MAX_ITEMS) return;
      items.push({ ...r, sourcePath: skillPath, source: 'skill', project, skill: display, ...confirm(invoked, r.file) });
    }
  }
}

/** Detect "read X first"-style instructions across global + project CLAUDE.md AND
 *  skill bodies, count the tokens they pull in, and confirm against transcripts where
 *  session volume allows. */
export function detectConditionalContext(sessions: Session[]): ConditionalContextItem[] {
  const claudeDir = join(homedir(), '.claude');
  const items: ConditionalContextItem[] = [];

  // Global CLAUDE.md instructions apply to EVERY session, so confirm across all.
  const globalMd = join(claudeDir, 'CLAUDE.md');
  for (const r of scanForRefs(globalMd, [claudeDir])) {
    items.push({ ...r, sourcePath: globalMd, source: 'global-claude-md', project: null, skill: null, ...confirm(sessions, r.file) });
  }
  // User skills (~/.claude/skills) — trusted, invokable from any project.
  scanSkillsDir(join(claudeDir, 'skills'), [claudeDir], sessions, null, items);

  // Per-project: project CLAUDE.md + project skills (.claude/skills), both UNTRUSTED.
  const byCwd = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const g = byCwd.get(s.cwd);
    if (g) g.push(s);
    else byCwd.set(s.cwd, [s]);
  }
  for (const [cwd, group] of byCwd) {
    if (items.length >= MAX_ITEMS) break;
    const project = group[0]!.project;
    const projectMd = join(cwd, 'CLAUDE.md');
    for (const r of scanForRefs(projectMd, [cwd, claudeDir])) {
      items.push({ ...r, sourcePath: projectMd, source: 'project-claude-md', project, skill: null, ...confirm(group, r.file) });
    }
    scanSkillsDir(join(cwd, '.claude', 'skills'), [cwd, claudeDir], group, project, items);
  }

  return items;
}
