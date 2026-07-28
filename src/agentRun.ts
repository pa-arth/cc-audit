// The shell-out path: run the analysis RIGHT NOW, in the same terminal, on the
// developer's own agent.
//
// This exists because the skill path alone is too much friction for a first run —
// install, restart the session, remember a phrase, and only then see value. Here the
// developer types one command and reads three plans.
//
// It costs something the skill path doesn't, and the cost is the thing this tool
// measures: invoking `claude -p` spends THEIR rate-limit window. So two rules hold and
// are not negotiable:
//
//   1. The window cost is disclosed BEFORE the first invocation (see cli.ts).
//   2. The input is BOUNDED — a compacted derived summary, never the raw aggregate and
//      never raw transcripts. `compactFindings` states its own truncation in-band so the
//      model knows it is reading a subset; a silent top-N would read as "everything".
//
// Posture: the prompt carries its data INLINE and asks for no tools at all. That makes
// the read-only requirement structural rather than asserted — we hand the agent text and
// get text back. `claude` runs with --allowed-tools ''; `codex` runs -s read-only.
//
// Both agents put the final answer on STDOUT and their transcript chatter on STDERR, so
// stdout is the answer verbatim. Verified against both CLIs.

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Give a real analysis room to finish, but never hang a terminal. */
const TIMEOUT_MS = 240_000;
/** Cap the answer we print; a runaway response is a bug, not a report. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export type AgentBin = 'claude' | 'codex';

export interface DetectedAgent {
  bin: AgentBin;
  path: string;
}

/** Resolution order is FIXED so the choice is deterministic when both are installed:
 *  claude first (cc-audit reads Claude Code transcripts, so it is the agent whose work
 *  the report is about), then codex. The caller reports which one ran. */
const AGENT_ORDER: AgentBin[] = ['claude', 'codex'];

function onPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here — keep looking */
    }
  }
  return null;
}

export function detectAgent(): DetectedAgent | null {
  for (const bin of AGENT_ORDER) {
    const path = onPath(bin);
    if (path) return { bin, path };
  }
  return null;
}

/** How many rows of each long-tail list survive compaction. The scalar blocks
 *  (spend, fluency, alwaysOn, contextHygiene, roiLedger, dataQuality) are kept WHOLE —
 *  they are small and they carry the diagnosis. */
const CAPS = { commands: 8, subagents: 6, modelInvokedSkills: 6, friction: 5 } as const;

interface Truncation {
  field: string;
  kept: number;
  of: number;
}

export interface CompactFindings {
  note: string;
  truncated: Truncation[];
  [key: string]: unknown;
}

/** Only the ranking keys are typed here — the rows pass through to the model whole, so
 *  narrowing them further would just be a second copy of aggregate.ts's schema to drift. */
type Row = Record<string, unknown>;

function topN(rows: unknown, n: number, key: string): { kept: Row[]; total: number } {
  const all = Array.isArray(rows) ? (rows as Row[]) : [];
  const rank = (r: Row) => (typeof r[key] === 'number' ? (r[key] as number) : 0);
  return { kept: [...all].sort((a, b) => rank(b) - rank(a)).slice(0, n), total: all.length };
}

/**
 * A bounded derived summary of the aggregate record.
 *
 * The full record runs ~22KB, and roughly half of that is long-tail rows (every command,
 * every subagent, hash-named friction entries) that coaching never cites. Sending it all
 * would make this tool a meaningful cause of the window exhaustion it reports on.
 *
 * Every cut is declared in `truncated` so the model can say "your top 8 commands" instead
 * of mistaking a subset for the whole picture.
 */
export function compactFindings(aggregate: Record<string, unknown>): CompactFindings {
  const a = aggregate;
  const friction0 = (a.friction ?? {}) as Row;
  const truncated: Truncation[] = [];

  const commands = topN(a.commands, CAPS.commands, 'perMonthUsd');
  const subagents = topN(a.subagents, CAPS.subagents, 'perMonthUsd');
  const skills = topN(a.modelInvokedSkills, CAPS.modelInvokedSkills, 'spanUsdUpperBound');
  const friction = topN(friction0.bySkill, CAPS.friction, 'frictionRate');

  const declare = (field: string, kept: number, of: number) => {
    if (of > kept) truncated.push({ field, kept, of });
  };
  declare('commands', commands.kept.length, commands.total);
  declare('subagents', subagents.kept.length, subagents.total);
  declare('modelInvokedSkills', skills.kept.length, skills.total);
  declare('friction.bySkill', friction.kept.length, friction.total);

  return {
    note:
      'Compacted summary of a cc-audit run. List sections are ranked and truncated as ' +
      'declared in `truncated`; scalar sections are complete. Hour-of-day histogram and ' +
      'the anonymized top-sessions leaderboard are omitted entirely — they do not inform ' +
      'coaching.',
    truncated,
    window: a.window,
    spend: a.spend,
    fluency: a.fluency,
    alwaysOn: a.alwaysOn,
    contextHygiene: a.contextHygiene,
    conditionalContext: a.conditionalContext,
    roiLedger: a.roiLedger,
    dataQuality: a.dataQuality,
    commands: commands.kept,
    subagents: subagents.kept,
    modelInvokedSkills: skills.kept,
    friction: {
      totalToolErrors: friction0.totalToolErrors,
      totalSelfCorrections: friction0.totalSelfCorrections,
      totalRetryLoops: friction0.totalRetryLoops,
      bySkill: friction.kept,
    },
  };
}

/**
 * The prompt pack. Embedded, like the skill — an instruction set we hand to their agent
 * is not something to fetch at runtime.
 *
 * It differs from the skill on one axis and the difference is honest: the skill runs
 * inside a session with their repo loaded, so it can point at the actual line in the
 * actual CLAUDE.md. This runs cold with only the numbers. The prompt says so, and tells
 * the model not to pretend otherwise.
 */
export function buildAnalysisPrompt(findings: CompactFindings): string {
  return `You are coaching a developer on their own Claude Code usage. Below is a compacted,
measured summary of their last sessions, produced by the \`cc-audit\` CLI reading their
local transcripts.

Write **exactly three** improvement plans, ranked by measured impact, biggest first.

For each plan give:
1. A one-line name — the habit or setting that changes.
2. The evidence — the specific field and value, quoted as a number. Not "you have some
   context waste" but "contextHygiene.avoidableTotalUsdPerMonth is $41/mo across 12
   run-to-the-wall sessions".
3. The change — concrete enough to do today.
4. What it is worth — from the record. If the record does not support a number, write
   "not quantified" rather than inventing one.
5. How they will know it worked — the field that should move, and which direction.

Close with one line: the single thing to change in their next session.

Rules:
- Never invent a number. Every figure comes from the record below.
- Never fabricate a comparison. No percentiles, no "most developers", no "top 10%" —
  this record contains no population data.
- Check \`dataQuality.unpricedShare\` before making dollar claims. If a meaningful share
  of spend is unpriced, say so and soften them. \`fluency.sessions\` being small means you
  cannot claim a confident habit.
- Respect \`truncated\`: say "your top 8 commands", never imply you saw all of them.
- The rate-limit WINDOW (what they run out of on a Thursday) and the CONTEXT window
  (what compaction is about) are different things. Say which you mean.
- This is a solo picture. No team standards, no org benchmarks, no manager framing. There
  is no PR, cycle-time, or DORA data here — do not reference any.
- You are running WITHOUT their repo loaded, so you cannot cite specific lines of their
  CLAUDE.md or read their config. Do not pretend you can. Where a fix needs their actual
  files, say what to look for and note that \`cc-audit\`'s installed skill can do that part
  in-session.
- Use no tools. Answer from the data below. Plain text, no preamble.

DATA:
${JSON.stringify(findings, null, 2)}
`;
}

/** Rough token estimate for the disclosure — deliberately conservative (~3.5 chars/token
 *  for JSON-heavy text) so we never understate what a run costs. */
export function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3.5);
}

export interface AgentRunResult {
  ok: boolean;
  /** The agent's answer (stdout), when ok. */
  text?: string;
  /** Why it failed, in words fit to show a developer. */
  error?: string;
  bin: AgentBin;
}

function argsFor(bin: AgentBin, prompt: string): string[] {
  // No tools on either path: the data is inline, so the read-only posture is structural.
  return bin === 'claude'
    ? ['-p', prompt, '--allowed-tools', '']
    : ['exec', '-s', 'read-only', '--skip-git-repo-check', prompt];
}

/**
 * Invoke the agent. Never throws — every failure comes back as `{ ok: false, error }` so
 * the caller can report a PARTIAL result rather than letting a dead agent look like an
 * empty analysis.
 */
export async function runAgentAnalysis(agent: DetectedAgent, prompt: string): Promise<AgentRunResult> {
  try {
    const { stdout } = await execFileAsync(agent.path, argsFor(agent.bin, prompt), {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      // stderr is transcript chatter on both CLIs; we read stdout only.
      encoding: 'utf8',
    });
    const text = stdout.trim();
    if (!text) return { ok: false, error: `${agent.bin} returned nothing`, bin: agent.bin };
    return { ok: true, text, bin: agent.bin };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      return { ok: false, error: `${agent.bin} timed out after ${Math.round(TIMEOUT_MS / 1000)}s`, bin: agent.bin };
    }
    const detail = (e.stderr ?? '').trim().split('\n').slice(-2).join(' ') || e.message;
    return { ok: false, error: `${agent.bin} failed: ${detail}`, bin: agent.bin };
  }
}
