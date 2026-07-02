// Claude Code adapter — parses ~/.claude/projects/<proj>/<session>.jsonl into the
// normalized Session model. Each line is one event; assistant events carry
// message.usage + model, user events carry promptId and (for slash commands) a
// <command-message> marker, and attachment events of type 'invoked_skills' mark
// skill invocations. Robust to malformed lines (skipped).

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AssistantTurn, Session, Span, TurnUsage } from '../model.js';

const COMMAND_RE = /<command-(?:message|name)>([^<\n]+)<\/command-(?:message|name)>/;

/** ISO timestamp → epoch ms, or null if absent/unparseable. */
const parseTs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

function parseUsage(u: RawUsage): TurnUsage {
  const cc = u.cache_creation ?? {};
  const cw1 = cc.ephemeral_1h_input_tokens ?? 0;
  const cw5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - cw1);
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: cw5,
    cacheWrite1h: cw1,
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: { skill?: string; command?: string; file_path?: string; notebook_path?: string };
  /** tool_use id (on `tool_use` blocks) — lets a later tool_result match back to its turn. */
  id?: string;
  /** back-reference to the tool_use id (on `tool_result` blocks). */
  tool_use_id?: string;
  /** error flag on `tool_result` blocks. */
  is_error?: boolean;
}

// Tools whose input names a file we then carry in context — re-touching the same path
// without resetting re-injects its content (the redundant-read signal).
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is ContentBlock => typeof b === 'object' && b !== null && (b as ContentBlock).type === 'text')
      .map((b) => b.text ?? '')
      .join(' ');
  }
  return '';
}

/** Is this a genuine typed user prompt (not a tool_result echo or skill scaffold)? */
function isGenuinePrompt(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.startsWith('Base directory for this skill')) return false;
  if (t.includes('"type":"tool_result"') || t.includes('[Request interrupted')) return false;
  // Hook / slash-command / local-command / system text is logged with role=user but is
  // NOT a human prompt. It all OPENS with a lowercase-hyphenated tag — <task-notification>,
  // <command-message>, <command-name>, <command-args>, <local-command-caveat>,
  // <local-command-stdout>, <system-reminder>, … — which a real prompt practically never
  // does. One rule drops the lot (and any future hook tag).
  if (/^<[a-z][a-z0-9-]*>/.test(t)) return false;
  return true;
}

/**
 * Parse a single transcript file into a Session, or null if it has no turns.
 *
 * Claude Code logs the same streamed assistant message multiple times (same
 * `message.id`, identical final usage) — counting every row overcounts cost
 * ~2.75x. `seen` dedupes by message id ACROSS files (matching ccusage); pass a
 * shared Set from the loader. Omitted (e.g. in tests) ⇒ no dedup.
 */
export function parseTranscript(
  filePath: string,
  raw: string,
  project: string,
  seen?: Set<string>,
): Session | null {
  const sessionId = filePath.split('/').pop()?.replace(/\.jsonl$/, '') ?? filePath;
  let mtime = 0;
  try {
    mtime = statSync(filePath).mtimeMs;
  } catch {
    /* keep 0 */
  }

  const spans: Span[] = [];
  const modes = new Set<string>();
  let cwd: string | null = null;
  let cur: Span | null = null;
  // Active permission/agent mode, tracked across `type:"mode"` events and stamped on each
  // turn so plan-mode is turn-resolved, not just session-level.
  let curMode: string | null = null;
  // tool_use id → the turn that issued it, so a later tool_result row (in a user message)
  // can fold its is_error flag + timestamp back onto the right turn. Global across spans.
  const turnByToolId = new Map<string, AssistantTurn>();
  const ensureSpan = (promptId: string | null): Span => {
    if (cur && cur.promptId === promptId) return cur;
    cur = {
      promptId,
      command: null,
      invokedSkills: [],
      firstUserText: '',
      turns: [],
      isSidechain: false,
      autoCompacted: false,
      attributionSkill: null,
      attributionAgent: null,
      userTs: null,
    };
    spans.push(cur);
    return cur;
  };

  // Subagent trajectories are logged as sidechain rows (isSidechain:true) carrying
  // NO promptId — so they can't attach to a main-chain span. We group them into
  // their own spans keyed by agentId and read the explicit attribution Claude Code
  // stamps on each row (attributionSkill / attributionAgent). Without this, ~15% of
  // spend (every subagent the skill spawned) lands namelessly in "regular sessions".
  //
  // Legacy transcripts (before agentId was stamped) inline all sidechain rows with
  // no grouping key. Each spawn still BEGINS with its task instruction — a genuine-
  // prompt user row — so we start a new anonymous span there instead of merging
  // every spawn into one (which undercounted spawns and their setup tax). Parallel
  // legacy spawns can interleave rows across these splits; that ambiguity is
  // inherent to the old format, and sequential splitting is strictly better than
  // one merged span.
  const subSpans = new Map<string, Span>();
  let anonSeq = 0;
  const ensureSubSpan = (agentId: string): Span => {
    let s = subSpans.get(agentId);
    if (!s) {
      s = {
        promptId: null,
        command: null,
        invokedSkills: [],
        firstUserText: '',
        turns: [],
        isSidechain: true,
        autoCompacted: false,
        attributionSkill: null,
        attributionAgent: null,
        userTs: null,
      };
      spans.push(s);
      subSpans.set(agentId, s);
    }
    return s;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = d.type as string | undefined;

    // Capture the session's working dir once — used locally to find the project's
    // CLAUDE.md (never emitted; see Session.cwd).
    if (cwd == null && typeof d.cwd === 'string') cwd = d.cwd;

    if (type === 'mode' || type === 'permission-mode') {
      const v = (d.mode ?? d.permissionMode ?? d.value) as string | undefined;
      if (typeof v === 'string') {
        modes.add(v);
        curMode = v;
      }
      continue;
    }

    if (type === 'user') {
      const msg = (d.message ?? {}) as { content?: unknown };
      // tool_result blocks (carried on user rows) answer an earlier turn's tool calls.
      // Fold their is_error flag (count only — NEVER the payload) and timestamp back onto
      // the issuing turn. Runs for BOTH main + sidechain (map is keyed globally), and
      // before the early `continue`s below so it isn't skipped.
      if (Array.isArray(msg.content)) {
        const rts = parseTs(d.timestamp);
        for (const b of msg.content as ContentBlock[]) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const t = turnByToolId.get(b.tool_use_id);
            if (t) {
              if (b.is_error) t.toolErrorCount += 1;
              if (rts != null && (t.toolResultTs == null || rts > t.toolResultTs)) t.toolResultTs = rts;
            }
          }
        }
      }
      const text = userText(msg.content);
      // A sidechain user row is the subagent's task instruction — route it to that
      // agent's span (not the main chain) and record what spawned it.
      if (d.isSidechain) {
        let key = d.agentId as string | undefined;
        if (!key) {
          // Anonymous (legacy) sidechain: a genuine-prompt user row is the next
          // spawn's task instruction — open a fresh span for it. tool_result-only
          // user rows stay with the current spawn.
          if (isGenuinePrompt(text)) anonSeq += 1;
          key = `sidechain-${anonSeq}`;
        }
        const span = ensureSubSpan(key);
        span.attributionSkill ??= (d.attributionSkill as string | undefined) ?? null;
        span.attributionAgent ??= (d.attributionAgent as string | undefined) ?? null;
        span.userTs ??= parseTs(d.timestamp);
        if (!span.firstUserText && isGenuinePrompt(text)) span.firstUserText = text.trim().slice(0, 700);
        continue;
      }
      const promptId = (d.promptId as string | undefined) ?? null;
      // An auto-compaction summary ("session continued from a previous conversation
      // that ran out of context") is injected as a user row WITH a promptId — so it
      // opens the post-wall span. Flag that span (the context-hygiene "ran-to-the-wall"
      // signal) but DON'T treat the summary text as a task gist — it's machine-written
      // continuation prose, not a human prompt, and shouldn't pollute firstUserText.
      if (d.isCompactSummary) {
        if (promptId) ensureSpan(promptId).autoCompacted = true;
        continue;
      }
      // A new genuine prompt with its own promptId opens a new span.
      if (promptId) {
        const span = ensureSpan(promptId);
        // ??= so the genuine prompt row (which precedes its tool_result echoes sharing the
        // same promptId) wins — later rows don't clobber the prompt's timestamp.
        span.userTs ??= parseTs(d.timestamp);
        const cmd = COMMAND_RE.exec(text);
        // Normalize: built-in commands appear as "/compact", skills as "commit-push-pr".
        if (cmd) span.command = span.command ?? cmd[1]!.trim().replace(/^\//, '');
        if (!span.firstUserText && isGenuinePrompt(text)) span.firstUserText = text.trim().slice(0, 700);
      }
      continue;
    }

    if (type === 'attachment') {
      const att = (d.attachment ?? {}) as { type?: string; skills?: Array<{ name?: string }> };
      if (att.type === 'invoked_skills' && Array.isArray(att.skills)) {
        const span = cur ?? ensureSpan(null);
        for (const s of att.skills) if (s.name) span.invokedSkills.push(s.name);
      }
      continue;
    }

    if (type === 'assistant') {
      const msg = (d.message ?? {}) as { id?: string; model?: string; usage?: RawUsage; content?: unknown };
      if (!msg.usage) continue;
      if (seen) {
        // Dedupe streamed-message duplicates by message id (identical usage on
        // each logged row). Falls back to requestId/uuid when id is absent.
        const key = msg.id ?? (d.requestId as string) ?? (d.uuid as string) ?? '';
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
      }
      const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
      const turn: AssistantTurn = {
        model: msg.model ?? null,
        usage: parseUsage(msg.usage),
        tools: blocks.filter((b) => b.type === 'tool_use' && b.name).map((b) => b.name!),
        fileOps: blocks
          .filter((b) => b.type === 'tool_use' && b.name && FILE_TOOLS.has(b.name))
          .map((b) => ({ tool: b.name!, path: b.input?.file_path ?? b.input?.notebook_path ?? '' }))
          .filter((o) => o.path),
        thinkingChars: blocks.filter((b) => b.type === 'thinking').reduce((n, b) => n + (b.thinking?.length ?? 0), 0),
        textChars: blocks.filter((b) => b.type === 'text').reduce((n, b) => n + (b.text?.length ?? 0), 0),
        // Basename only — never the full path (privacy invariant).
        reads: blocks
          .filter((b) => b.type === 'tool_use' && b.name === 'Read' && b.input?.file_path)
          .map((b) => basename(b.input!.file_path!)),
        ts: parseTs(d.timestamp),
        mode: curMode,
        toolResultTs: null,
        toolErrorCount: 0,
      };
      // Register this turn's tool_use ids so their results can match back to it.
      for (const b of blocks) if (b.type === 'tool_use' && b.id) turnByToolId.set(b.id, turn);
      // ExitPlanMode means the user accepted the plan — subsequent turns run in normal mode.
      if (turn.tools.includes('ExitPlanMode')) curMode = 'normal';
      if (d.isSidechain) {
        const span = ensureSubSpan((d.agentId as string | undefined) ?? `sidechain-${anonSeq}`);
        span.attributionSkill ??= (d.attributionSkill as string | undefined) ?? null;
        span.attributionAgent ??= (d.attributionAgent as string | undefined) ?? null;
        span.turns.push(turn);
      } else {
        const span = cur ?? ensureSpan(null);
        span.turns.push(turn);
        // Model-invoked skills (the `Skill` tool, e.g. "ship this" → commit-push-pr)
        // carry no slash marker — record the skill name so attribution can surface
        // the leak board's natural-language blind spot.
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.name === 'Skill') {
            const skill = b.input?.skill ?? b.input?.command;
            if (skill) span.invokedSkills.push(skill);
          }
        }
      }
    }
  }

  const withTurns = spans.filter((s) => s.turns.length > 0);
  if (withTurns.length === 0) return null;
  return { sessionId, project, cwd, mtime, modes: [...modes], spans: withTurns };
}

/** Decode a transcript directory name back to a readable project path. */
function decodeProject(dir: string): string {
  // Claude Code encodes the cwd with '-' separators; we can't perfectly invert
  // it, so just strip a leading dash and show the tail as a label.
  const cleaned = dir.replace(/^-/, '').replace(/-/g, '/');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

export interface LoadOptions {
  /** Defaults to ~/.claude/projects */
  root?: string;
  /** Only include sessions whose file mtime is within the last N days. */
  sinceDays?: number;
}

/** Load and parse every Claude Code transcript under the projects root. */
export function loadClaudeCodeSessions(opts: LoadOptions = {}): Session[] {
  const root = opts.root ?? join(homedir(), '.claude', 'projects');
  const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const sessions: Session[] = [];
  const seen = new Set<string>(); // global message-id dedup across all transcripts
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const dir of projectDirs) {
    const project = decodeProject(dir);
    // Transcripts nest in subdirectories (worktrees, resumed sessions), so walk
    // recursively — reading only the top level misses ~70% of files.
    const files: string[] = [];
    collectJsonl(join(root, dir), files);
    for (const fp of files) {
      try {
        if (cutoff && statSync(fp).mtimeMs < cutoff) continue;
        const session = parseTranscript(fp, readFileSync(fp, 'utf8'), project, seen);
        if (session) sessions.push(session);
      } catch {
        continue;
      }
    }
  }
  return sessions;
}

/** Claude Code's project-directory slug for a working directory: every non-alphanumeric
 *  character becomes '-' (so `/Users/x/repo/.claude/wt` → `-Users-x-repo--claude-wt`). */
export function projectDirSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The LIVE session transcript for a working directory — the newest-mtime `*.jsonl` under
 * `<root>/<slug(cwd)>/` (transcripts nest, so we walk it). This is how the live-guardrail
 * statusline self-discovers the active session without any input from claude-hud: it
 * inherits the project cwd and maps it to Claude Code's project dir. null when the project
 * has no transcripts (or the dir doesn't exist). LOCAL-ONLY, reads no file contents.
 */
export function findLiveTranscript(cwd: string, root?: string): string | null {
  const projectsRoot = root ?? join(homedir(), '.claude', 'projects');
  const dir = join(projectsRoot, projectDirSlug(cwd));
  const files: string[] = [];
  collectJsonl(dir, files);
  let newest: string | null = null;
  let newestMtime = -Infinity;
  for (const fp of files) {
    try {
      const m = statSync(fp).mtimeMs;
      if (m > newestMtime) {
        newestMtime = m;
        newest = fp;
      }
    } catch {
      /* file vanished mid-scan — skip */
    }
  }
  return newest;
}

function collectJsonl(dir: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collectJsonl(full, acc);
    else if (e.name.endsWith('.jsonl')) acc.push(full);
  }
}
