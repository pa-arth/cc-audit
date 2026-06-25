// The single trust boundary for reading audited Claude Code config files.
//
// Project CLAUDE.md and project skills ship INSIDE cloned repos, so any path they
// reference (`@imports`, "read X" instructions) is untrusted attacker input: a
// hostile repo could point at a 2GB file (OOM), 10k imports (read storm), or
// `@/etc/passwd` / `@~/.ssh/*` (read sensitive contents). Rather than guard each
// vector at each call site, EVERY config read in the audit goes through
// `readConfigFile` here. No other module calls readFileSync on a derived config
// path — so a new caller (e.g. the conditional-context detector) physically cannot
// bypass the boundary. The safe path is the only path.
//
// The trick that makes this lossless: CharCountTokenizer is just length/4, so we
// never need to READ a file to count its tax — `statSync().size / 4` is the same
// number. Untrusted/oversize/non-regular files therefore yield a size-only token
// count and NO contents; their tax is still reflected, but nothing dangerous is
// loaded into the process.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CharCountTokenizer } from './vendor/tokenizer.js';

export const MAX_IMPORT_DEPTH = 4; // CC inlines @imports up to 4 hops deep
export const MAX_FILE_BYTES = 256 * 1024; // ~64k tok; larger ⇒ size-estimate only, no read
export const MAX_IMPORTS_PER_FILE = 25; // refs followed from a single file
export const MAX_FILES_TOTAL = 100; // files touched per closure (depth + breadth backstop)
export const MAX_DIR_WALK = 40; // ancestor dirs scanned for memory files (loop backstop)

// The memory files Claude Code concatenates into context. Both load at every level
// of the directory walk; CLAUDE.local.md is the gitignored personal override.
const MEMORY_FILENAMES = ['CLAUDE.md', 'CLAUDE.local.md'];

const tokenizer = new CharCountTokenizer();
export const countTokens = (text: string): number => tokenizer.count(text);

/** Neutralize a string read from an UNTRUSTED config file before it can flow into the
 *  report, a network payload, or any assistant-facing output. Prompt-injection tactics
 *  need newlines, control chars, and instruction/role markers to break out of a data
 *  context; we strip control chars (incl. newlines/tabs), collapse whitespace, and
 *  hard-cap length so an attacker-controlled value can only ever read as an inert short
 *  token — never as instructions a downstream model would follow.
 *
 *  THE INVARIANT: any value sourced from an untrusted config file (a cloned repo's
 *  CLAUDE.md / skill) that reaches output MUST pass through here. The deterministic
 *  core never sends file CONTENTS to a model at all; this guards the few constrained
 *  fields (filenames, names) that do surface, so the safe shape is enforced on purpose,
 *  not as an accident of some upstream regex. */
export function sanitizeUntrusted(s: string, maxLen = 80): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    // Replace C0/C1 control chars (incl. newlines, tabs, escapes) with a space; keep
    // everything printable. A char-code filter avoids a control-char regex literal.
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// CC inlines `@path` imports recursively (up to 5 hops). Liberal match: `@` at
// line-start or after whitespace, then a path-ish token. We don't try to classify
// "real" imports — resolution + the stat checks are the filter, so `@anthropic-ai/sdk`
// mentions or emails that don't resolve to a regular file are harmlessly skipped.
const IMPORT_RE = /(?:^|\s)@(\S+)/g;

/** Strip fenced code blocks and inline code spans — CC does not evaluate imports
 *  (or, for the detector, instructions) inside them. */
export function stripCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/** Resolve a `@import` / "read X" path spec relative to the file it appears in.
 *  Returns an absolute path or null. Does NOT touch the filesystem. */
export function resolveConfigRef(spec: string, fromDir: string): string | null {
  const p = spec.replace(/[.,;:!?)\]}'"]+$/, ''); // trim trailing punctuation
  if (!p) return null;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p.startsWith('/')) return p;
  return join(fromDir, p);
}

/** Regular-file byte size, or -1 for missing / dir / FIFO / device / socket. The
 *  isFile() gate also blocks `@/dev/zero`-style read hangs. */
function regularFileSize(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/** True if `child` is inside one of `roots` (so we trust it enough to read). Both
 *  sides are realpath'd so symlinked roots (e.g. macOS /var → /private/var, or a
 *  symlinked worktree) don't read as "out of tree" and silently disable reads. */
function withinAny(child: string, roots: string[]): boolean {
  const c = resolve(child);
  return roots.some((r) => {
    let p: string;
    try {
      p = realpathSync(r);
    } catch {
      p = resolve(r);
    }
    return c === p || c.startsWith(p + sep);
  });
}

const tokensFromSize = (bytes: number): number => (bytes > 0 ? Math.ceil(Math.min(bytes, MAX_FILE_BYTES) / 4) : 0);

/** A config file as seen through the trust gateway. `text` is non-null ONLY when the
 *  file was safe to actually read (regular, in-scope, within the size cap); otherwise
 *  callers get the size-based token count and no contents. `real` is the realpath,
 *  for dedup. */
export interface GatedFile {
  tokens: number;
  text: string | null;
  real: string;
}

/** THE filesystem chokepoint. Returns null only when the path isn't a regular file
 *  at all; otherwise always returns a token count, and `text` only when it was safe
 *  to read. Scope + size are checked AFTER realpath, so an in-tree symlink pointing
 *  OUT of the tree (docs/x.md → /etc/passwd) is judged by its true target. */
export function readConfigFile(path: string, trustRoots: string[]): GatedFile | null {
  const size = regularFileSize(path);
  if (size < 0) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  if (size > MAX_FILE_BYTES || !withinAny(real, trustRoots)) {
    return { tokens: tokensFromSize(size), text: null, real };
  }
  try {
    const text = readFileSync(path, 'utf8');
    return { tokens: countTokens(text), text, real };
  } catch {
    return { tokens: tokensFromSize(size), text: null, real };
  }
}

/** Tokens for a CLAUDE.md plus the transitive closure of its `@imports`, all read
 *  through readConfigFile so the trust boundary is enforced once. `seen` dedups by
 *  real path so a file imported twice (or a cycle) counts once — the non-inflating
 *  choice. */
export function claudeMdTokensWithImports(
  path: string,
  trustRoots: string[],
  seen = new Set<string>(),
  depth = 0,
  budget = { files: 0 },
): number {
  const f = readConfigFile(path, trustRoots);
  if (!f) return 0;
  if (seen.has(f.real)) return 0;
  seen.add(f.real);
  budget.files += 1;

  if (f.text === null || depth >= MAX_IMPORT_DEPTH || budget.files > MAX_FILES_TOTAL) {
    return f.tokens;
  }

  let total = f.tokens;
  const fromDir = dirname(path);
  let followed = 0;
  for (const m of stripCode(f.text).matchAll(IMPORT_RE)) {
    if (followed >= MAX_IMPORTS_PER_FILE || budget.files > MAX_FILES_TOTAL) break;
    const resolved = resolveConfigRef(m[1]!, fromDir);
    if (!resolved) continue;
    followed += 1;
    total += claudeMdTokensWithImports(resolved, trustRoots, seen, depth + 1, budget);
  }
  return total;
}

/** Managed-policy CLAUDE.md path for this OS (loaded first by CC for enterprise
 *  deployments). Returns null on unknown platforms. */
function managedPolicyDir(): string | null {
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
    case 'linux':
      return '/etc/claude-code';
    default:
      return null;
  }
}

/** True if a rule .md is PATH-SCOPED (`paths:` in its frontmatter). Those load only
 *  on-demand when Claude touches matching files, so they're NOT standing context. */
function hasPathsFrontmatter(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? /^[ \t]*paths[ \t]*:/m.test(m[1]!) : false;
}

/** Tokens for the UNSCOPED rule files (no `paths:` frontmatter) under a `.claude/rules`
 *  dir, discovered recursively. These load at launch with CLAUDE.md priority. */
function rulesDirTokens(rulesDir: string, trustRoots: string[], seen: Set<string>, budget: { files: number }): number {
  let entries;
  try {
    entries = readdirSync(rulesDir, { withFileTypes: true });
  } catch {
    return 0; // no rules dir
  }
  let total = 0;
  for (const e of entries) {
    if (budget.files > MAX_FILES_TOTAL) break;
    const p = join(rulesDir, e.name);
    if (e.isDirectory()) {
      total += rulesDirTokens(p, trustRoots, seen, budget); // recurse (CC discovers nested)
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    const f = readConfigFile(p, trustRoots);
    if (!f || seen.has(f.real)) continue;
    if (f.text !== null && hasPathsFrontmatter(f.text)) continue; // path-scoped ⇒ on-demand
    seen.add(f.real);
    budget.files += 1;
    total += f.tokens;
  }
  return total;
}

/** Every always-on memory file rooted at one directory level of the walk: CLAUDE.md +
 *  CLAUDE.local.md at the dir AND at its `./.claude/` (the alternate project location),
 *  plus unscoped `./.claude/rules/`. `skipDotClaude` avoids re-counting the user-global
 *  ~/.claude when the walk passes through $HOME. */
function memoryAtDir(
  dir: string,
  claudeDir: string,
  seen: Set<string>,
  budget: { files: number },
  skipDotClaude: boolean,
): number {
  const roots = [dir, claudeDir];
  let total = 0;
  for (const name of MEMORY_FILENAMES) {
    total += claudeMdTokensWithImports(join(dir, name), roots, seen, 0, budget);
  }
  const dotClaude = join(dir, '.claude');
  if (!skipDotClaude && dotClaude !== claudeDir) {
    for (const name of MEMORY_FILENAMES) {
      total += claudeMdTokensWithImports(join(dotClaude, name), roots, seen, 0, budget);
    }
    total += rulesDirTokens(join(dotClaude, 'rules'), roots, seen, budget);
  }
  return total;
}

/** Sum the project memory CC concatenates into context every turn for a session in
 *  `cwd`: at EVERY directory from cwd up to the filesystem root, the CLAUDE.md +
 *  CLAUDE.local.md (in `./` and `./.claude/`) plus unscoped `./.claude/rules/`, each
 *  with its @import closure, deduped by realpath across the whole walk. Walking the
 *  tree (not just cwd) is what fixes the subdir/worktree undercount. The `~/.claude`
 *  level is skipped here — it's counted once by globalMemoryTokens. */
export function projectMemoryTokens(cwd: string, claudeDir: string): number {
  const seen = new Set<string>();
  const budget = { files: 0 };
  let total = 0;
  let dir = cwd;
  for (let i = 0; i < MAX_DIR_WALK; i++) {
    total += memoryAtDir(dir, claudeDir, seen, budget, dir === claudeDir);
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return total;
}

/** Machine-level memory loaded in every session regardless of project: user global
 *  ~/.claude/CLAUDE.md (+ CLAUDE.local.md), unscoped ~/.claude/rules/, and the
 *  enterprise managed-policy CLAUDE.md. */
export function globalMemoryTokens(claudeDir: string): number {
  const seen = new Set<string>();
  const budget = { files: 0 };
  let total = 0;
  for (const name of MEMORY_FILENAMES) {
    total += claudeMdTokensWithImports(join(claudeDir, name), [claudeDir], seen, 0, budget);
  }
  total += rulesDirTokens(join(claudeDir, 'rules'), [claudeDir], seen, budget);
  const policyDir = managedPolicyDir();
  if (policyDir) {
    total += claudeMdTokensWithImports(join(policyDir, 'CLAUDE.md'), [policyDir, claudeDir], seen, 0, budget);
  }
  return total;
}

const AUTO_MEMORY_MAX_BYTES = 25 * 1024; // CC loads first 25KB of MEMORY.md...
const AUTO_MEMORY_MAX_LINES = 200; // ...or first 200 lines, whichever comes first.

/** Read at most `maxBytes` from the head of a file WITHOUT loading the whole thing —
 *  bounds memory even if the file is pathologically large. Null if unreadable. */
function readHead(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Nearest ancestor of `cwd` containing a `.git` entry — the auto-memory key. Works on
 *  a now-deleted worktree path too, since it walks string parents and stat-checks each. */
function gitRepoRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < MAX_DIR_WALK; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Auto-memory (`MEMORY.md`) loaded at the start of every conversation, capped at the
 *  first 200 lines / 25KB. It lives at ~/.claude/projects/<encoded-repo-root>/memory/
 *  — keyed by the GIT REPO ROOT (shared across worktrees), not cwd. Best-effort: the
 *  projects-dir encoding (path separators/dots → '-') is CC-internal and undocumented,
 *  so a miss silently yields 0 rather than an over-count. */
export function autoMemoryTokens(cwd: string, projectsRoot: string): number {
  const repo = gitRepoRoot(cwd) ?? cwd;
  const encoded = repo.replace(/[/.]/g, '-');
  const head = readHead(join(projectsRoot, encoded, 'memory', 'MEMORY.md'), AUTO_MEMORY_MAX_BYTES);
  if (!head) return 0;
  const lines = head.split('\n');
  const capped = lines.length > AUTO_MEMORY_MAX_LINES ? lines.slice(0, AUTO_MEMORY_MAX_LINES).join('\n') : head;
  return countTokens(capped);
}
