// Claude Code adapter — parses ~/.claude/projects/<proj>/<session>.jsonl into the
// normalized Session model. Each line is one event; assistant events carry
// message.usage + model, user events carry promptId and (for slash commands) a
// <command-message> marker, and attachment events of type 'invoked_skills' mark
// skill invocations. Robust to malformed lines (skipped).

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { countTokens } from '../configFiles.js';
import { emptyInjectedPrefix, foldAttachment } from '../injectedPrefix.js';
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

/**
 * Fold a later row of the SAME streamed message into the usage already recorded.
 * Per-field max, not sum: every row restates the whole running total, so summing
 * would multiply the bill by the row count. Max (rather than last-wins) is also
 * order-independent, which matters because rows are not guaranteed monotonic —
 * on real data max matched an independent implementation to the token while
 * last-wins was 2,114 tokens short.
 */
function mergeUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
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

/** Fold one JSONL row's content blocks into a turn: union tool names, file ops,
 *  Read basenames, and reasoning/prose lengths, and register each tool_use id so
 *  a later tool_result can match back. A single streamed assistant message is
 *  logged across MULTIPLE rows sharing one message.id — usage repeated verbatim,
 *  but content blocks PARTITIONED across rows (thinking on one, the tool_use on
 *  the next). Calling this once per same-id row accumulates the whole message;
 *  usage is applied ONCE by the caller, on the row that first opens the turn. */
function foldBlocksIntoTurn(
  turn: AssistantTurn,
  blocks: ContentBlock[],
  turnByToolId: Map<string, AssistantTurn>,
): void {
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      if (b.name) turn.tools.push(b.name);
      if (b.name && FILE_TOOLS.has(b.name)) {
        const path = b.input?.file_path ?? b.input?.notebook_path ?? '';
        if (path) turn.fileOps!.push({ tool: b.name, path });
      }
      // Basename only — never the full path (privacy invariant).
      if (b.name === 'Read' && b.input?.file_path) turn.reads.push(basename(b.input.file_path));
      if (b.id) turnByToolId.set(b.id, turn);
    } else if (b.type === 'thinking') {
      turn.thinkingChars += b.thinking?.length ?? 0;
    } else if (b.type === 'text') {
      turn.textChars += b.text?.length ?? 0;
    }
  }
}

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
  const parentSessionId = parentOf(filePath);
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
  // message.id → the turn it opened, so subsequent rows of the same streamed
  // assistant message merge their (partitioned) content blocks into it instead
  // of being dropped by the cross-transcript `seen` dedup. Per-transcript.
  const turnById = new Map<string, AssistantTurn>();
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
  // The injected turn-1 prefix, measured from the `attachment` rows Claude Code writes
  // ahead of the first MAIN-CHAIN assistant turn. `injectedOpen` closes at that turn:
  // attachments after it are mid-session injections (task reminders, opened files) and
  // are not standing context. Sidechain rows never contribute — a subagent's prefix is
  // its own, and folding it in would let several spawns outvote the session.
  const injected = emptyInjectedPrefix();
  let injectedOpen = true;
  /** Message key of the row that CLOSED the injection window (the true turn 1). */
  let prefixCloseKey: string | null = null;
  /** Message key of the first RETAINED main-chain turn — the one `firstMain` picks. */
  let firstRetainedMainKey: string | null = null;

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
      // Everything on a main-chain user row ahead of turn 1 entered the prefix — the
      // prompt AND the <system-reminder> blocks riding with it, which is where CLAUDE.md
      // and auto-memory are actually injected. Counted as ONE term because it arrived as
      // one: the memory fields attribute inside it, they do not add to it. Splitting the
      // prompt out and then adding disk-measured memory alongside would double-count the
      // memory against itself.
      if (injectedOpen && !d.isSidechain) injected.userMessageTokens += countTokens(text);
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
      if (injectedOpen && !d.isSidechain) foldAttachment(injected, att as Record<string, unknown>);
      continue;
    }

    if (type === 'assistant') {
      const msg = (d.message ?? {}) as { id?: string; model?: string; usage?: RawUsage; content?: unknown };
      if (!msg.usage) continue;
      const key = msg.id ?? (d.requestId as string) ?? (d.uuid as string) ?? '';
      // Turn 1 has been reached: the prefix is now fixed and later attachments are
      // mid-session injections. Closed here rather than after the dedup checks below so
      // a resumed replay (whose turn-1 row is owned by an earlier transcript) still stops
      // collecting — otherwise the whole session's attachments would fold into "turn 1".
      //
      // THAT IS ONLY HALF THE PROBLEM, and the other half went unnoticed until review.
      // `computeAlwaysOn` pairs these attachments with `firstMain` — the first RETAINED
      // main-chain turn. On a resumed transcript the row closing this window is a replay
      // owned by an earlier file, so `seen` drops it below and `firstMain` lands on a
      // LATER turn whose prefix has the whole replayed conversation folded into its
      // cacheRead. Attributed stays turn-1-sized while measured grows, so
      // `fixedPrefixTokens` INFLATES — and `reconcile()` cannot catch that, because it
      // only fires on a NEGATIVE remainder. Inflation is the silent direction.
      //
      // So record which row closed the window; the retain path below records the row
      // `firstMain` will pick. If they differ, the session cannot answer "what did turn 1
      // carry", and computeAlwaysOn declines to measure it rather than pairing two halves
      // that came from different turns.
      if (!d.isSidechain && injectedOpen) prefixCloseKey = key;
      if (!d.isSidechain) injectedOpen = false;
      const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];

      // A single streamed assistant message is logged across MULTIPLE rows sharing
      // one message.id, with content blocks PARTITIONED across rows (row1 thinking,
      // row2 text, row3 the tool_use). Merge same-id rows into ONE turn: fold their
      // blocks in (so tool_use/fileOps/reads on later rows aren't dropped —
      // first-row-wins lost ~60% of file reads), and count usage ONCE.
      //
      // "Once" is NOT "the first row's copy". The input-side buckets really are
      // repeated identically (they're fixed when the request is sent), but
      // output_tokens is a RUNNING total that grows as the stream emits — the first
      // row carries a partial count and only the last carries the final one.
      // Taking row 1 undercounted output by 19% of the bill on real data. `seen`
      // (global, cross-transcript) owns the resumed-replay case; this is per-file.
      const existing = key ? turnById.get(key) : undefined;
      if (existing) {
        existing.usage = mergeUsage(existing.usage, parseUsage(msg.usage));
        foldBlocksIntoTurn(existing, blocks, turnByToolId);
        if (existing.tools.includes('ExitPlanMode')) curMode = 'normal';
        // A Skill tool_use landing on a merged (later) row still needs recording.
        if (!d.isSidechain) {
          const span = cur ?? ensureSpan(null);
          for (const b of blocks) {
            if (b.type === 'tool_use' && b.name === 'Skill') {
              const skill = b.input?.skill ?? b.input?.command;
              if (skill) span.invokedSkills.push(skill);
            }
          }
        }
        continue;
      }
      if (seen && key) {
        if (seen.has(key)) continue; // owned by an earlier transcript (resumed replay)
        seen.add(key);
      }
      const turn: AssistantTurn = {
        model: msg.model ?? null,
        usage: parseUsage(msg.usage),
        tools: [],
        fileOps: [],
        thinkingChars: 0,
        textChars: 0,
        reads: [],
        ts: parseTs(d.timestamp),
        mode: curMode,
        toolResultTs: null,
        toolErrorCount: 0,
      };
      foldBlocksIntoTurn(turn, blocks, turnByToolId);
      if (key) turnById.set(key, turn);
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
        // First RETAINED main-chain turn — exactly what `firstMain` resolves to, so the
        // comparison against prefixCloseKey is against the real selection, not a proxy.
        firstRetainedMainKey ??= key;
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
  // Do the attachments and the usage describe the SAME turn? Both null (no main-chain
  // assistant row at all) is not agreement — there is no turn to describe, and
  // `firstMain` is undefined anyway, so the session is skipped upstream regardless.
  injected.prefixTurnIsFirst = prefixCloseKey !== null && prefixCloseKey === firstRetainedMainKey;
  return { sessionId, parentSessionId, project, cwd, mtime, modes: [...modes], spans: withTurns, injected };
}

/** Claude Code 2.1.x moved subagent turns out of the parent transcript and into
 *  `<project>/<parentSessionId>/subagents/agent-*.jsonl`. The loader walks recursively
 *  and makes a Session per file, so the parent link only survives if we read it off the
 *  path here. Returns null for a top-level transcript. */
function parentOf(filePath: string): string | null {
  const parts = filePath.split('/');
  // .../<parentSessionId>/subagents/<agent>.jsonl
  return parts.length >= 3 && parts[parts.length - 2] === 'subagents'
    ? (parts[parts.length - 3] ?? null)
    : null;
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
