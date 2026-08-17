// Normalized, tool-agnostic trajectory model. Every adapter (Claude Code first;
// Codex/Cursor later) parses its native transcript format into these types, and
// every analysis (attribution, always-on, fluency) reads only from here. The
// promptId SPAN is the core unit — one user prompt and the assistant turns it
// triggered — because cost must be attributed per-span (a naive "invocation to
// end of session" attribution was 4x wrong during exploration).

import type { InjectedPrefix } from './injectedPrefix.js';

/** Token usage for a single assistant turn, split the way pricing needs it. */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** A file-touching tool call (Read/Edit/Write/NotebookEdit) — the tool name and the
 *  path it acted on. Used to detect redundant re-reads (the same file re-injected into
 *  context). Paths are LOCAL-ONLY: used for redundancy stats + local display, never
 *  uploaded (privacy invariant — only the derived rate leaves the machine). */
export interface FileOp {
  tool: string;
  path: string;
}

export interface AssistantTurn {
  /** Model id this turn ran under (per-turn — a session can switch models). */
  model: string | null;
  usage: TurnUsage;
  /** tool_use names invoked this turn (e.g. Read, Edit, Bash, Task). */
  tools: string[];
  /** Basenames of files opened via the `Read` tool this turn. Used to EMPIRICALLY
   *  confirm "read X before Y" config instructions (conditional-context tax) — we
   *  keep only basenames, never full paths, so nothing path-shaped is retained. */
  reads: string[];
  /** File-touching tool calls this turn, with paths — for redundant-read detection.
   *  Optional: only the Claude Code adapter populates it; treat missing as []. */
  fileOps?: FileOp[];
  /** Length of reasoning/thinking text — a rough proxy for reasoning effort. */
  thinkingChars: number;
  /** Length of visible assistant prose. */
  textChars: number;
  /** Epoch ms when this assistant row was logged (parsed from the JSONL `timestamp`).
   *  null on legacy rows / summary continuations that carry no timestamp. */
  ts: number | null;
  /** Active permission/agent mode when this turn ran ('plan' | 'normal' | ...), tracked
   *  as the parser walks `type:"mode"` events. Per-turn so plan-mode is turn-resolved,
   *  not just session-level (session.modes stays the de-duped set). null if unknown. */
  mode: string | null;
  /** Epoch ms of the tool_result that answered THIS turn's tool calls (max across blocks
   *  when several / parallel). null if the turn issued no tools or no result was logged.
   *  Bounds tool-exec time; with `ts` it splits think vs exec. */
  toolResultTs: number | null;
  /** # of this turn's tool calls whose tool_result carried `is_error:true`. Counts/flags
   *  only — NO payloads, NO error text (privacy invariant). Default 0. */
  toolErrorCount: number;
}

/** A promptId span: one user prompt and the assistant turns it triggered.
 *  Subagent (sidechain) trajectories are ALSO modeled as spans (keyed by agentId,
 *  promptId null, `isSidechain: true`) — their cost would otherwise be invisible
 *  per-skill, since Claude Code logs sidechain turns with no promptId. */
export interface Span {
  promptId: string | null;
  /** Slash-command name if this span was an explicit `/command` invocation. */
  command: string | null;
  /** Skills invoked (explicitly or auto) within this span. */
  invokedSkills: string[];
  /** First genuine user text in the span — the task gist. NEVER leaves the
   *  machine raw; redacted/summarized before any network call. */
  firstUserText: string;
  turns: AssistantTurn[];
  /** True if this span is a subagent's sidechain trajectory, not a main-chain prompt. */
  isSidechain: boolean;
  /** True if this span was opened by an AUTO-compaction continuation (the transcript's
   *  `isCompactSummary` "session continued from a previous conversation that ran out of
   *  context" marker) — i.e. context hit the wall and Claude Code force-compacted. The
   *  context-hygiene pass treats this as a reset boundary AND counts it as a
   *  "ran-to-the-wall" event (a proactive /compact should have happened earlier). */
  autoCompacted: boolean;
  /** The skill that spawned this subagent (Claude Code `attributionSkill`), if any.
   *  Only set on sidechain spans. */
  attributionSkill: string | null;
  /** The subagent type that ran it (Claude Code `attributionAgent`) — e.g. 'Explore',
   *  'general-purpose', 'workflow-subagent'. Only set on sidechain spans. */
  attributionAgent: string | null;
  /** Epoch ms of the opening user prompt for this span — anchors user-wait time (gap from
   *  the prior turn's end to this prompt) and the session timeline. null if unknown. */
  userTs: number | null;
}

export interface Session {
  /** Transcript file basename (uuid), stable per session. */
  sessionId: string;
  /** For a subagent transcript (`<session>/subagents/agent-*.jsonl`), the sessionId of
   *  the parent that spawned it; null/undefined for a top-level session. The loader
   *  makes one Session per FILE, which is right for spend (message-id dedup keeps the
   *  total honest) and wrong for anything that counts SESSIONS: a parent with six
   *  subagents would otherwise read as seven concurrent sessions. Anything counting
   *  sessions must group on `concurrencyKey(session)`, never on sessionId. */
  parentSessionId?: string | null;
  /** Human-ish project label decoded from the transcript directory. */
  project: string;
  /** Absolute working directory this session ran in (from the transcript `cwd`).
   *  Used ONLY locally to locate a project's CLAUDE.md for the always-on tax — the
   *  path NEVER enters the aggregate/output (privacy invariant). null if unknown. */
  cwd: string | null;
  /** File mtime (epoch ms) — recency proxy + window bounds. */
  mtime: number;
  /** Distinct permission/agent modes seen (e.g. 'plan') — fluency signal. */
  modes: string[];
  spans: Span[];
  /** The injected turn-1 prefix, MEASURED from the transcript's `attachment` rows rather
   *  than censused from disk. Optional: only the Claude Code adapter populates it, and
   *  hand-built Sessions in tests omit it — treat missing as "not measured", NEVER as
   *  zero. `measuredPrefixTokens` is filled by computeAlwaysOn, which owns the turn-1
   *  selection, so the reconciliation cannot disagree with standingContextTokens. */
  injected?: InjectedPrefix;
}

/** Flatten every assistant turn across a session's spans. */
export function allTurns(session: Session): AssistantTurn[] {
  return session.spans.flatMap((s) => s.turns);
}

/** The id to group by when counting SESSIONS rather than transcripts: a subagent folds
 *  into the session that spawned it. Subagents are parallelism INSIDE a session, so
 *  counting them separately double-counts the thing a concurrency measure is measuring. */
export function concurrencyKey(session: Session): string {
  return session.parentSessionId ?? session.sessionId;
}
