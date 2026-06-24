// Always-on context tax. Two numbers, deliberately separated:
//   1) OBSERVED standing context — the empirical turn-1 prefix. Includes the system
//      prompt + tool schemas + your first user prompt, MOST of which is FIXED and
//      cannot be trimmed. Kept as honest context, NOT as a "savings" headline.
//   2) RECOVERABLE config tax — global + project CLAUDE.md + skill listings, measured
//      from the actual files. This is the part a developer can actually cut. It's the
//      real fixable lever, and it's much smaller than the observed number.
// Labeling the full prefix as recoverable (the old behavior) over-promised savings —
// the same credibility mistake as the old MCP $246 inflation.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoMemoryTokens, countTokens, globalMemoryTokens, projectMemoryTokens } from './configFiles.js';
import { detectConditionalContext, type ConditionalContextItem } from './conditionalContext.js';
import { getAnthropicPricing } from './vendor/pricing.js';
import type { Session } from './model.js';

export interface AlwaysOnTax {
  /** OBSERVED: median standing-context size carried into every turn (turn-1 prefix).
   *  Mostly fixed system + tool schemas — NOT all recoverable. */
  standingContextTokens: number;
  /** Estimated monthly spend re-reading that observed standing context (a slice of
   *  total spend, not additional). Most of this is unavoidable. */
  observedMonthlyUsd: number;

  /** RECOVERABLE config tokens carried every turn (turn-weighted): global + project
   *  CLAUDE.md + skill listings. The real fixable lever. */
  recoverableTokensPerTurn: number;
  /** Estimated monthly spend on the recoverable config tax — the honest "you can cut this". */
  recoverableMonthlyUsd: number;
  /** Machine-level memory: ~/.claude/CLAUDE.md (+ .local + managed policy), @imports
   *  resolved. Field name kept for aggregate compatibility; it's the global memory set. */
  globalClaudeMdTokens: number;
  globalClaudeMdUsd: number;
  /** Turn-weighted project memory: every CLAUDE.md + CLAUDE.local.md from cwd up to the
   *  filesystem root (CC's directory walk), not just the file at cwd. Field name kept
   *  for aggregate compatibility; handles worktree/subdir cwds correctly. */
  projectClaudeMdTokens: number;
  projectClaudeMdUsd: number;
  /** Sum of skill name+description tokens that load every turn (a FLOOR — user skills
   *  only; bundled/plugin skills aren't on disk to count). */
  skillDescriptionTokens: number;
  skillDescriptionUsd: number;
  skillCount: number;

  /** MCP servers configured (best-effort from ~/.claude.json). */
  mcpServerCount: number;
  /** True ⇒ MCP tools are tool-search-deferred (CC default) ⇒ ~0 standing cost. */
  mcpDeferred: boolean;
  /** Share of sessions that actually invoked an MCP tool (mcp__ prefix). */
  mcpInvokedRate: number;

  /** CONDITIONAL context: files a CLAUDE.md instructs Claude to read ("read ERRORS.md
   *  before…"). NOT folded into recoverable — these load only when the instruction
   *  fires, so reporting them as always-on would repeat the over-promise mistake.
   *  Reported separately, with an empirically observed read-rate when measurable. */
  conditionalContext: ConditionalContextItem[];

  note: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Sum of `name: description` tokens for every SKILL.md directly under a skills dir.
 *  These are what the per-turn skill listing is built from. */
function skillListingTokens(skillsDir: string): { tokens: number; count: number } {
  let tokens = 0;
  let count = 0;
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { tokens: 0, count: 0 };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = join(skillsDir, e.name, 'SKILL.md');
    if (!existsSync(f)) continue;
    let txt;
    try {
      txt = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const name = /^name:\s*(.+)$/m.exec(txt)?.[1] ?? e.name;
    const desc = /^description:\s*(.+)$/m.exec(txt)?.[1] ?? '';
    tokens += countTokens(`${name}: ${desc}`);
    count += 1;
  }
  return { tokens, count };
}

function countMcpServers(): number {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const names = new Set(Object.keys(cfg.mcpServers ?? {}));
    for (const p of Object.values(cfg.projects ?? {})) {
      for (const k of Object.keys(p.mcpServers ?? {})) names.add(k);
    }
    return names.size;
  } catch {
    return 0;
  }
}

export function computeAlwaysOn(sessions: Session[]): AlwaysOnTax {
  const prefixes: number[] = [];
  let totalTurns = 0;
  let minMtime = Infinity;
  let maxMtime = 0;
  let weightedRateNum = 0;
  let weightedRateDen = 0;
  let mcpSessions = 0;

  // Static, machine-level config (same for every session): user global CLAUDE.md
  // (+ .local + managed policy), with @imports resolved.
  const claudeDir = join(homedir(), '.claude');
  const projectsRoot = join(claudeDir, 'projects');
  const globalClaudeMdTokens = globalMemoryTokens(claudeDir);
  const userSkills = skillListingTokens(join(homedir(), '.claude', 'skills'));

  // Project memory, turn-weighted by cwd. CC walks cwd→root loading every CLAUDE.md +
  // CLAUDE.local.md, so we do too (projectMemoryTokens) — counting only the file at
  // cwd zero-counts the common case where you run in a subdir/worktree and the real
  // CLAUDE.md sits at the repo root above you. Caching per distinct cwd and weighting
  // by that cwd's turns still avoids inflating a file shared across worktrees.
  const projectMdByCwd = new Map<string, number>();
  let projectTokenTurns = 0;

  for (const s of sessions) {
    if (s.mtime) {
      minMtime = Math.min(minMtime, s.mtime);
      maxMtime = Math.max(maxMtime, s.mtime);
    }
    const first = s.spans[0]?.turns[0];
    if (first) prefixes.push(first.usage.input + first.usage.cacheWrite5m + first.usage.cacheWrite1h);

    let projMd = 0;
    if (s.cwd) {
      projMd =
        projectMdByCwd.get(s.cwd) ??
        projectMemoryTokens(s.cwd, claudeDir) + autoMemoryTokens(s.cwd, projectsRoot);
      projectMdByCwd.set(s.cwd, projMd);
    }

    let sawMcp = false;
    let sessionTurns = 0;
    for (const span of s.spans) {
      for (const t of span.turns) {
        totalTurns += 1;
        sessionTurns += 1;
        const p = t.model ? getAnthropicPricing(t.model) : null;
        weightedRateNum += p ? p.cacheRead : 0.4;
        weightedRateDen += 1;
        if (t.tools.some((x) => x.startsWith('mcp__'))) sawMcp = true;
      }
    }
    projectTokenTurns += projMd * sessionTurns;
    if (sawMcp) mcpSessions += 1;
  }

  const standing = median(prefixes);
  const windowDays = maxMtime > minMtime ? Math.max(1, (maxMtime - minMtime) / 86_400_000) : 1;
  const turnsPerMonth = (totalTurns / windowDays) * 30.44;
  const rate = weightedRateDen ? weightedRateNum / weightedRateDen : 0.4; // $/1M cache-read
  const perTurnUsd = (tok: number) => (tok * turnsPerMonth * rate) / 1_000_000;

  const projectClaudeMdTokens = totalTurns ? projectTokenTurns / totalTurns : 0;
  const skillDescriptionTokens = userSkills.tokens;
  const recoverableTokensPerTurn = globalClaudeMdTokens + projectClaudeMdTokens + skillDescriptionTokens;

  // MCP tools are tool-search-deferred by default (CC v2.1.121+), so they cost ~0
  // standing — only ~120 tok of names load unless ENABLE_TOOL_SEARCH=false.
  const mcpDeferred = process.env.ENABLE_TOOL_SEARCH !== 'false';

  return {
    standingContextTokens: standing,
    observedMonthlyUsd: perTurnUsd(standing),
    recoverableTokensPerTurn,
    recoverableMonthlyUsd: perTurnUsd(recoverableTokensPerTurn),
    globalClaudeMdTokens,
    globalClaudeMdUsd: perTurnUsd(globalClaudeMdTokens),
    projectClaudeMdTokens,
    projectClaudeMdUsd: perTurnUsd(projectClaudeMdTokens),
    skillDescriptionTokens,
    skillDescriptionUsd: perTurnUsd(skillDescriptionTokens),
    skillCount: userSkills.count,
    mcpServerCount: countMcpServers(),
    mcpDeferred,
    mcpInvokedRate: sessions.length ? mcpSessions / sessions.length : 0,
    conditionalContext: detectConditionalContext(sessions),
    note:
      'Recoverable = project memory (every CLAUDE.md + CLAUDE.local.md from cwd up to the ' +
      'repo root) + global memory + skill listings, measured from your files and cache-read ' +
      'into every turn — the part you can actually trim. The larger OBSERVED standing ' +
      'context is mostly fixed system prompt + tool schemas you cannot cut. Run /context ' +
      'in a session for the authoritative live breakdown.',
  };
}
