// Codex adapter — parses `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
// into the same normalized Session model the Claude Code adapter produces.
//
// The rollout log is a flat JSONL event stream. The records that matter, in the
// order Codex emits them:
//
//   session_meta                  once, first line — id, cwd, thread_source, parent
//   task_started   (event_msg)    opens a TASK: one user prompt and its turns
//   turn_context                  the model + effort this task ran under
//   user_message   (event_msg)    the prompt text
//   reasoning      (response_item)  ENCRYPTED — see "what this rail cannot see"
//   agent_message  (event_msg)    visible assistant prose
//   function_call / custom_tool_call (response_item)  a tool invocation
//   patch_apply_end (event_msg)   an applied edit, with the paths it touched
//   token_count    (event_msg)    CLOSES one model request, with its usage
//   task_complete  (event_msg)    ends the task
//
// `token_count` is the turn boundary. Everything accumulated since the previous
// one belongs to the request it closes, which is why tools/prose are buffered and
// flushed there rather than attached to whatever span happens to be open.
//
// ── The token conventions are INVERTED relative to Claude Code ──────────────
// `TurnUsage` is the ADDITIVE five-bucket shape: `input` is the uncached
// remainder, disjoint from `cacheRead` and the write buckets, because that is how
// Anthropic bills and every analysis (`turnTokens`, contextTokens, the knee) reads
// it. Codex reports the opposite: `input_tokens` is the TOTAL and
// `cached_input_tokens` / `cache_write_input_tokens` are SUBSETS of it — the
// wire fixture proves it, `total_tokens == input_tokens + output_tokens` with
// cached nonzero. So this adapter SUBTRACTS the cache buckets back out. Reading
// Codex's `input_tokens` straight into `TurnUsage.input` would double-count every
// cached token — at full input rate, on the largest bucket in the file.
//
// ── What this rail cannot see, and must not report as zero ──────────────────
// Three fields are genuinely unobservable here, and the honest value for all
// three is "not measured", which the type cannot express:
//   - `thinkingChars` — Codex ships reasoning as `encrypted_content`. 1598/1598
//     records in the local corpus carry it and NONE carry a plaintext summary, so
//     there is no character count to take. Left 0. `reasoning_output_tokens` is
//     the real measure and it is already inside `output`, so no cost is lost —
//     only the reasoning-effort proxy.
//   - `reads` — Codex has no `Read` tool; it reads through `exec`. There is no
//     path-level read event to collect, so redundant-read detection cannot run.
//   - `mode` — Codex has no plan mode. `collaboration_mode` is 'default' on all
//     483 turn_contexts observed.
// This is why `--codex` is opt-in and prints what it cannot measure. Folding these
// zeros into the default run would show a Codex user 0% plan mode and no redundant
// reads as if those had been measured and found absent.

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssistantTurn, FileOp, Session, Span, TurnUsage } from '../model.js';

/** Codex's per-request usage block (`info.last_token_usage`). */
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** ISO timestamp → epoch ms, or null if absent/unparseable. */
const parseTs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Codex's subset-shaped usage → the additive five-bucket `TurnUsage`.
 *
 * Clamped so the buckets can never sum past the reported total and `input` can
 * never go negative. The subset reading held on all 2504 rows of the local corpus
 * (`cached + write <= input` without exception), so the clamp is a guard against a
 * future format change, not a routine correction — but an unclamped subtraction
 * would turn one such row into a NEGATIVE input bucket that silently credits
 * money back.
 */
export function toTurnUsage(u: CodexUsage): TurnUsage {
  const total = num(u.input_tokens);
  const cached = Math.min(num(u.cached_input_tokens), total);
  const write = Math.min(num(u.cache_write_input_tokens), total - cached);
  return {
    input: total - cached - write,
    output: num(u.output_tokens),
    cacheRead: cached,
    // Codex has ONE write bucket; Anthropic has two (5-minute and 1-hour TTL).
    // It lands in the 5m slot because `pricing.ts` sums both slots against the
    // single OpenAI `cacheWrite` rate, so the choice of slot cannot change the
    // bill — and inventing a 1h split Codex never reported would be worse.
    cacheWrite5m: write,
    cacheWrite1h: 0,
  };
}

/** Two usage blocks that are field-for-field identical. */
function sameUsage(a: TurnUsage, b: TurnUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite5m === b.cacheWrite5m &&
    a.cacheWrite1h === b.cacheWrite1h
  );
}

/** Is this a genuine typed prompt rather than machine-injected scaffolding? */
function isGenuinePrompt(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  // Same rule the Claude Code adapter uses: injected/hook/system text opens with a
  // lowercase-hyphenated tag, which a human prompt practically never does.
  if (/^<[a-z][a-z0-9-]*>/.test(t)) return false;
  // Codex re-injects the prior conversation on a compaction continuation and when
  // it spawns a reviewer subagent; both open with a fixed instruction preamble.
  if (t.startsWith('The following is the Codex agent history')) return false;
  return true;
}

/** Project label from the session cwd — last two path segments, matching the
 *  Claude Code adapter's `decodeProject` output shape. */
function projectFromCwd(cwd: string | null): string {
  if (!cwd) return 'unknown';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || cwd;
}

/**
 * Parse one rollout file into a Session, or null if it recorded no model request.
 *
 * Unlike the Claude Code adapter there is no cross-file message-id dedup to do:
 * Codex writes one file per thread and never replays another thread's requests
 * into it. The dedup that IS needed is WITHIN a file — see `sameUsage` below.
 */
export function parseRollout(filePath: string, raw: string): Session | null {
  let mtime = 0;
  try {
    mtime = statSync(filePath).mtimeMs;
  } catch {
    /* keep 0 */
  }

  const spans: Span[] = [];
  let sessionId = filePath.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? filePath;
  let parentSessionId: string | null = null;
  let isSubagentThread = false;
  let subagentName: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let nextSpanAutoCompacted = false;
  /** The most recently opened span. Read off the array rather than tracked in a
   *  separate variable: spans are only ever appended, so the tail IS the current
   *  span, and a variable assigned only inside `openSpan` gets narrowed to `null`
   *  by the compiler at every use site. */
  const lastSpan = (): Span | undefined => spans[spans.length - 1];

  // Buffered content for the request the NEXT `token_count` will close.
  let pendTools: string[] = [];
  let pendFileOps: FileOp[] = [];
  let pendTextChars = 0;
  let pendToolErrors = 0;
  let pendTs: number | null = null;
  let pendToolResultTs: number | null = null;
  // The usage block of the request we last emitted, so an immediately-repeated
  // `token_count` can be recognized. Codex occasionally emits the same request's
  // usage twice; summing both overstates that request. Verified against the
  // cumulative `total_token_usage` across the whole local corpus: suppressing an
  // exact repeat of the PREVIOUS row makes all 25 files reconcile to the token,
  // and two of them are off by exactly one duplicated row without it.
  let lastEmitted: TurnUsage | null = null;

  const resetPending = (): void => {
    pendTools = [];
    pendFileOps = [];
    pendTextChars = 0;
    pendToolErrors = 0;
    pendTs = null;
    pendToolResultTs = null;
  };

  const openSpan = (turnId: string | null): Span => {
    const span: Span = {
      promptId: turnId,
      command: null,
      invokedSkills: [],
      firstUserText: '',
      turns: [],
      // A subagent thread is a sidechain in its entirety — Codex gives it its own
      // file with `thread_source: 'subagent'`, where Claude Code inlines sidechain
      // rows into the parent transcript.
      isSidechain: isSubagentThread,
      autoCompacted: nextSpanAutoCompacted,
      attributionSkill: null,
      attributionAgent: isSubagentThread ? subagentName : null,
      userTs: null,
    };
    nextSpanAutoCompacted = false;
    spans.push(span);
    return span;
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
    const payload = (d.payload ?? {}) as Record<string, unknown>;
    const pType = payload.type as string | undefined;
    const ts = parseTs(d.timestamp);

    if (type === 'session_meta') {
      if (typeof payload.id === 'string') sessionId = payload.id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      isSubagentThread = payload.thread_source === 'subagent';
      if (isSubagentThread && typeof payload.parent_thread_id === 'string') {
        parentSessionId = payload.parent_thread_id;
      }
      const src = payload.source as { subagent?: { other?: unknown } } | undefined;
      const other = src?.subagent?.other;
      if (typeof other === 'string') subagentName = other;
      continue;
    }

    if (type === 'turn_context') {
      // Per-task model. Recorded on the parser rather than the span because a
      // session can switch models between tasks and each turn carries its own.
      if (typeof payload.model === 'string') model = payload.model;
      if (cwd == null && typeof payload.cwd === 'string') cwd = payload.cwd;
      continue;
    }

    // A compaction lands between tasks; flag the task that opens after it, which
    // is the same "ran to the wall" signal the Claude Code adapter reads off
    // `isCompactSummary`.
    if (type === 'compacted' || pType === 'context_compacted') {
      nextSpanAutoCompacted = true;
      continue;
    }

    if (pType === 'task_started') {
      const span = openSpan(typeof payload.turn_id === 'string' ? payload.turn_id : null);
      if (ts != null) span.userTs = ts;
      continue;
    }

    if (pType === 'user_message') {
      const span = lastSpan() ?? openSpan(null);
      const text = typeof payload.message === 'string' ? payload.message : '';
      span.userTs ??= ts;
      if (!span.firstUserText && isGenuinePrompt(text)) {
        span.firstUserText = text.trim().slice(0, 700);
        // Codex slash commands arrive as a leading /token on the prompt itself.
        // Normalized without the slash to match the Claude Code adapter, so
        // attribution buckets the same command name across both rails.
        const cmd = /^\/([a-z][\w-]*)/i.exec(span.firstUserText);
        if (cmd) span.command ??= cmd[1]!;
      }
      continue;
    }

    if (pType === 'agent_message') {
      if (typeof payload.message === 'string') pendTextChars += payload.message.length;
      continue;
    }

    if (pType === 'function_call' || pType === 'custom_tool_call') {
      if (typeof payload.name === 'string') pendTools.push(payload.name);
      if (pendTs == null) pendTs = ts;
      // `status` is Codex's own verdict on the call. Only an explicit failure
      // counts — an absent status is unknown, not success.
      if (payload.status === 'failed') pendToolErrors += 1;
      continue;
    }

    if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
      // The `output` field carries command stdout and file contents. It is READ
      // past and never retained — only the fact that a result arrived, for the
      // tool-exec time bound. Same invariant as the Claude Code adapter's
      // tool_result handling: counts and timestamps, never payloads.
      if (ts != null && (pendToolResultTs == null || ts > pendToolResultTs)) pendToolResultTs = ts;
      continue;
    }

    if (pType === 'patch_apply_end') {
      // `changes` is keyed by absolute path, with a `unified_diff` body per entry.
      // Take the PATHS only — the diff bodies are source and never enter the model
      // (privacy invariant; paths themselves stay local, same as `FileOp.path`).
      const changes = payload.changes as Record<string, unknown> | undefined;
      if (changes && typeof changes === 'object') {
        for (const path of Object.keys(changes)) pendFileOps.push({ tool: 'apply_patch', path });
      }
      if (payload.success === false) pendToolErrors += 1;
      if (ts != null && (pendToolResultTs == null || ts > pendToolResultTs)) pendToolResultTs = ts;
      continue;
    }

    if (pType === 'token_count') {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const last = info.last_token_usage as CodexUsage | undefined;
      // `total_token_usage` is the session's running cumulative. Deliberately NOT
      // used: differencing a cumulative re-books the whole history the moment a
      // row is missing or repeated, and the first row would credit its entire
      // prefix to one turn. `last_token_usage` is the per-request figure.
      if (!last) continue;
      const usage = toTurnUsage(last);
      if (lastEmitted && sameUsage(lastEmitted, usage)) {
        // An exact repeat of the previous request's usage — Codex restating, not a
        // second request. Skip it WITHOUT touching the buffer.
        //
        // Leaving the buffer alone is the whole subtlety here. A repeat is not
        // necessarily adjacent to the row it repeats: across the local corpus the five
        // of them sit at gaps of 0, 0, 1, 2 and 7 records, and the gap-7 case spans a
        // `task_complete` / `task_started` / `user_message` boundary while the gap-2 case
        // has a `function_call` in it. Anything buffered in that gap was issued AFTER the
        // repeated request finished, so it belongs to the next genuine request — folding
        // it backward would attribute a tool call to the wrong turn, and on the
        // task-boundary case would attribute it to the wrong SPAN (or drop it, since the
        // freshly-opened span has no turn to fold into yet).
        continue;
      }
      const span = lastSpan() ?? openSpan(null);
      const turn: AssistantTurn = {
        model,
        usage,
        tools: pendTools,
        fileOps: pendFileOps,
        // Encrypted on this rail — see the header. 0 means "no plaintext to
        // count", not "did not reason".
        thinkingChars: 0,
        textChars: pendTextChars,
        reads: [],
        ts: pendTs ?? ts,
        mode: null,
        toolResultTs: pendToolResultTs,
        toolErrorCount: pendToolErrors,
      };
      span.turns.push(turn);
      lastEmitted = usage;
      resetPending();
      continue;
    }
  }

  const withTurns = spans.filter((s) => s.turns.length > 0);
  if (withTurns.length === 0) return null;
  return {
    sessionId,
    parentSessionId,
    project: projectFromCwd(cwd),
    cwd,
    mtime,
    // Codex has no plan mode to record; an empty list here is "none observed on a
    // rail that has none", which is why fluency's plan-mode signal must not read
    // Codex sessions. See `source`.
    modes: [],
    spans: withTurns,
    source: 'codex',
    // `injected` is deliberately absent: Codex logs no attachment rows, so the
    // turn-1 prefix was never measured. Absent means "not measured" — a zeroed
    // InjectedPrefix would read as "measured, and nothing was injected".
  };
}

export interface CodexLoadOptions {
  /** Defaults to ~/.codex/sessions */
  root?: string;
  /** Only include rollouts whose file mtime is within the last N days. */
  sinceDays?: number;
}

/** Load and parse every Codex rollout under the sessions root. */
export function loadCodexSessions(opts: CodexLoadOptions = {}): Session[] {
  const root = opts.root ?? join(homedir(), '.codex', 'sessions');
  const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const files: string[] = [];
  collectRollouts(root, files);
  const sessions: Session[] = [];
  for (const fp of files) {
    try {
      if (cutoff && statSync(fp).mtimeMs < cutoff) continue;
      const session = parseRollout(fp, readFileSync(fp, 'utf8'));
      if (session) sessions.push(session);
    } catch {
      continue;
    }
  }
  return sessions;
}

/** Rollouts nest by date (`sessions/YYYY/MM/DD/`), so this walks recursively. */
function collectRollouts(dir: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collectRollouts(full, acc);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) acc.push(full);
  }
}
