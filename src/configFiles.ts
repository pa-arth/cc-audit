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

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CharCountTokenizer } from './vendor/tokenizer.js';

export const MAX_IMPORT_DEPTH = 5; // matches CC's hop limit
export const MAX_FILE_BYTES = 256 * 1024; // ~64k tok; larger ⇒ size-estimate only, no read
export const MAX_IMPORTS_PER_FILE = 25; // refs followed from a single file
export const MAX_FILES_TOTAL = 100; // files touched per closure (depth + breadth backstop)

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
