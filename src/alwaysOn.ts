// Always-on context tax. Two numbers, deliberately separated:
//   1) OBSERVED standing context — the empirical turn-1 prefix. Includes the system
//      prompt + tool schemas + your first user prompt, MOST of which is FIXED and
//      cannot be trimmed. Kept as honest context, NOT as a "savings" headline.
//   2) ALWAYS-ON CONFIG cost — global + project memory + skill listings, measured from
//      the actual files. This is the context the developer CHOSE, re-paid every turn.
//      We report it as a COST, not as "savings": useful CLAUDE.md / auto-memory is not
//      waste, and telling people to delete it to save money is the same over-promise as
//      the old MCP $246 inflation. Real trim advice is kept narrow and evidence-based
//      (see conditionalContext read-rates) — the value call stays with the user.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoMemoryTokens, countTokens, globalMemoryTokens, projectMemoryTokens } from './configFiles.js';
import { detectConditionalContext, type ConditionalContextItem } from './conditionalContext.js';
import { computePluginTax, type PluginInfo } from './pluginTax.js';
import { FALLBACK_READ_RATE, FALLBACK_WRITE_RATE, collectSpawnStats, median } from './spawnStats.js';
import { getAnthropicPricing } from './vendor/pricing.js';
import type { Session } from './model.js';

/** One skill's standing-carry signature, taken from its SKILL.md frontmatter. */
export interface SkillCarry {
  /** Directory name under skills/ — the SLUG, what /command and most invocations key on. */
  slug: string;
  /** `name:` frontmatter value, falling back to slug. May differ from slug (collision risk). */
  declaredName: string;
  /** countTokens(`${name}: ${desc}`) — the per-turn listing cost of THIS skill. */
  descTokens: number;
}

export interface AlwaysOnTax {
  /** OBSERVED: median standing-context size carried into every turn (turn-1 prefix).
   *  Mostly fixed system + tool schemas — NOT all recoverable. */
  standingContextTokens: number;
  /** Estimated monthly spend re-reading that observed standing context (a slice of
   *  total spend, not additional). Most of this is unavoidable. */
  observedMonthlyUsd: number;

  /** Standing CONFIG tokens carried every turn (turn-weighted): global + project memory
   *  + skill listings. This is context you CHOSE — re-paid each turn. It is a COST to
   *  surface, NOT a "savings" claim: useful config is not waste. Whether any of it is
   *  trimmable is a value judgment we leave to the user (see conditionalContext for the
   *  evidence-based trim candidates we can actually defend). */
  alwaysOnConfigTokensPerTurn: number;
  /** Estimated monthly spend re-reading that standing config — what it costs, not what
   *  you'd "save" by deleting it. */
  alwaysOnConfigMonthlyUsd: number;
  /** Machine-level memory: ~/.claude/CLAUDE.md (+ .local + managed policy), @imports
   *  resolved. Field name kept for aggregate compatibility; it's the global memory set. */
  globalClaudeMdTokens: number;
  globalClaudeMdUsd: number;
  /** Turn-weighted project memory: every CLAUDE.md + CLAUDE.local.md from cwd up to the
   *  filesystem root (CC's directory walk), not just the file at cwd. Field name kept
   *  for aggregate compatibility; handles worktree/subdir cwds correctly. */
  projectClaudeMdTokens: number;
  projectClaudeMdUsd: number;
  /** Sum of USER skill name+description tokens that load every turn (a FLOOR). Plugin-
   *  bundled skills are counted separately in the plugin* fields below. */
  skillDescriptionTokens: number;
  skillDescriptionUsd: number;
  skillCount: number;
  /** Per-skill standing-carry breakdown (LOCAL-ONLY — declaredName/slug are custom names,
   *  never uploaded). Each row's monthlyUsd is its slice of skillDescriptionUsd. */
  skillCarry: Array<SkillCarry & { monthlyUsd: number }>;

  /** Standing cost of ENABLED plugins: their bundled skill/command/agent listings load
   *  into every turn just like user skills. Split by asset kind; the listing total is
   *  folded into alwaysOnConfigTokensPerTurn. A FLOOR (CC adds listing wrapper tokens). */
  pluginSkillTokens: number;
  pluginSkillUsd: number;
  pluginCommandTokens: number;
  pluginCommandUsd: number;
  pluginAgentTokens: number;
  pluginAgentUsd: number;
  pluginListingTokens: number;
  pluginListingUsd: number;
  /** Enabled plugins counted. */
  pluginCount: number;
  /** Enabled but never invoked in the window — removal candidates (see recommendations). */
  unusedPluginCount: number;
  /** Per-plugin detail for the report. LOCAL-only — names never enter the aggregate. */
  plugins: PluginInfo[];

  /** MCP servers configured (best-effort from ~/.claude.json). */
  mcpServerCount: number;
  /** Configured MCP server names (LOCAL-ONLY). Joined against realized invocations. */
  mcpServerNames: string[];
  /** True ⇒ MCP tools are tool-search-deferred (CC default) ⇒ ~0 standing cost. */
  mcpDeferred: boolean;
  /** Share of sessions that actually invoked an MCP tool (mcp__ prefix). */
  mcpInvokedRate: number;

  /** CONDITIONAL context: files a CLAUDE.md instructs Claude to read ("read ERRORS.md
   *  before…"). NOT folded into always-on config — these load only when the instruction
   *  fires, so reporting them as always-on would repeat the over-promise mistake.
   *  Reported separately, with an empirically observed read-rate when measurable. */
  conditionalContext: ConditionalContextItem[];

  /** Subagent spawns per month (sidechain spans with ≥1 counted turn — both the
   *  legacy inlined format and the separate agent-*.jsonl files). Every spawn
   *  RE-WRITES the standing block at cache-write prices, so the per-token costing
   *  above already folds a spawn write term into every USD field. Approximation
   *  noted: the fold prices each component's own token count at the blended spawn
   *  write rate; spawnTaxMonthlyUsd below is the precise observed number. */
  spawnsPerMonth: number;
  /** OBSERVED: median subagent turn-1 prefix (input + cache writes) — the standing
   *  block a spawn re-writes. */
  spawnPrefixTokens: number;
  /** OBSERVED: total spawn setup cost per month — each spawn's turn-1 cache writes
   *  (5-min and 1h buckets at their own model rates) + uncached input, summed and
   *  monthly-normalized. A slice of observed spend, not additional. */
  spawnTaxMonthlyUsd: number;
  /** Blended $/1M cache-read rate across turns (LOCAL-ONLY; reused by recommend.ts). */
  cacheReadRatePerMTok: number;
  /** $/1M cache-write rate the kernel prices spawn re-writes at: observed blend over
   *  actual spawn write tokens (handles the 5-min/1h mix), falling back to the
   *  turn-weighted 5-min rate when no spawns exist (LOCAL-ONLY). */
  cacheWriteRatePerMTok: number;

  note: string;
}

/** One row per SKILL.md directly under a skills dir — the per-turn skill listing is
 *  built from these. FLOOR: user skills only; bundled/plugin skills aren't on disk. */
function skillListings(skillsDir: string): SkillCarry[] {
  const out: SkillCarry[] = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
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
    out.push({ slug: e.name, declaredName: name, descTokens: countTokens(`${name}: ${desc}`) });
  }
  return out;
}

/** Sum of `name: description` tokens (and count) for every SKILL.md directly under a
 *  skills dir. Exported so pluginTax can reuse it on a plugin's bundled `skills/` dir —
 *  same on-disk shape. Thin wrapper over skillListings. */
export function skillListingTokens(skillsDir: string): { tokens: number; count: number } {
  const rows = skillListings(skillsDir);
  return { tokens: rows.reduce((n, s) => n + s.descTokens, 0), count: rows.length };
}

/** Distinct MCP server names from ~/.claude.json (root + per-project). Best-effort. */
function listMcpServers(): string[] {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const names = new Set(Object.keys(cfg.mcpServers ?? {}));
    for (const p of Object.values(cfg.projects ?? {})) {
      for (const k of Object.keys(p.mcpServers ?? {})) names.add(k);
    }
    return [...names];
  } catch {
    return [];
  }
}

export function computeAlwaysOn(sessions: Session[]): AlwaysOnTax {
  const prefixes: number[] = [];
  let totalTurns = 0;
  let minMtime = Infinity;
  let maxMtime = 0;
  let weightedRateNum = 0;
  let weightedRateDen = 0;
  let weightedWriteNum = 0;
  let weightedWriteDen = 0;
  let mcpSessions = 0;

  // Static, machine-level config (same for every session): user global CLAUDE.md
  // (+ .local + managed policy), with @imports resolved.
  const claudeDir = join(homedir(), '.claude');
  const projectsRoot = join(claudeDir, 'projects');
  const globalClaudeMdTokens = globalMemoryTokens(claudeDir);
  const userSkills = skillListings(join(homedir(), '.claude', 'skills'));
  const mcpServerNames = listMcpServers();

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
    // Main-chain spans only: on CC v2.1.x each subagent transcript is a separate
    // file that parses as its own all-sidechain Session, and there are typically
    // several per main session — sampling spans[0] blindly would let subagent
    // prefixes dominate the "observed standing context" median.
    const firstMain = s.spans.find((sp) => !sp.isSidechain && sp.turns.length > 0)?.turns[0];
    if (firstMain)
      prefixes.push(firstMain.usage.input + firstMain.usage.cacheWrite5m + firstMain.usage.cacheWrite1h);

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
        const p = t.model
          ? getAnthropicPricing(t.model, t.ts != null ? new Date(t.ts) : undefined)
          : null;
        weightedRateNum += p ? p.cacheRead : FALLBACK_READ_RATE;
        weightedRateDen += 1;
        weightedWriteNum += p ? p.cacheWrite5min : FALLBACK_WRITE_RATE;
        weightedWriteDen += 1;
        if (t.tools.some((x) => x.startsWith('mcp__'))) sawMcp = true;
      }
    }
    projectTokenTurns += projMd * sessionTurns;
    if (sawMcp) mcpSessions += 1;
  }

  const standing = median(prefixes);
  const windowDays = maxMtime > minMtime ? Math.max(1, (maxMtime - minMtime) / 86_400_000) : 1;
  const turnsPerMonth = (totalTurns / windowDays) * 30.44;
  const rate = weightedRateDen ? weightedRateNum / weightedRateDen : FALLBACK_READ_RATE; // $/1M cache-read

  // Standing context is cache-READ every turn AND cache-WRITTEN afresh on every
  // subagent spawn (siblings don't share cache). One kernel prices both legs so
  // every component field below stays mutually consistent. The write rate comes
  // from the spawns' OWN write tokens (each 5-min/1h bucket at its model's rate),
  // so the mix is priced correctly; the turn-weighted 5-min blend is only the
  // no-spawns fallback (where the write leg is zero anyway).
  const spawns = collectSpawnStats(sessions);
  const spawnsPerMonth = (spawns.length / windowDays) * 30.44;
  const spawnPrefixTokens = median(spawns.map((x) => x.prefixTok));
  const spawnWriteTok = spawns.reduce((n, x) => n + x.writeTok, 0);
  const spawnWriteUsd = spawns.reduce((n, x) => n + x.writeUsd, 0);
  const writeRate = spawnWriteTok
    ? (spawnWriteUsd / spawnWriteTok) * 1_000_000
    : weightedWriteDen
      ? weightedWriteNum / weightedWriteDen
      : FALLBACK_WRITE_RATE; // $/1M cache-write
  const perTurnUsd = (tok: number) =>
    (tok * (turnsPerMonth * rate + spawnsPerMonth * writeRate)) / 1_000_000;

  const projectClaudeMdTokens = totalTurns ? projectTokenTurns / totalTurns : 0;
  const skillDescriptionTokens = userSkills.reduce((n, s) => n + s.descTokens, 0);
  // Plugin listings load every turn too — fold them into the headline so it stops
  // undercounting your standing config.
  const pluginTax = computePluginTax(sessions);
  const alwaysOnConfigTokensPerTurn =
    globalClaudeMdTokens + projectClaudeMdTokens + skillDescriptionTokens + pluginTax.pluginListingTokens;

  // MCP tools are tool-search-deferred by default (CC v2.1.121+), so they cost ~0
  // standing — only ~120 tok of names load unless ENABLE_TOOL_SEARCH=false.
  const mcpDeferred = process.env.ENABLE_TOOL_SEARCH !== 'false';

  return {
    standingContextTokens: standing,
    observedMonthlyUsd: perTurnUsd(standing),
    alwaysOnConfigTokensPerTurn,
    alwaysOnConfigMonthlyUsd: perTurnUsd(alwaysOnConfigTokensPerTurn),
    globalClaudeMdTokens,
    globalClaudeMdUsd: perTurnUsd(globalClaudeMdTokens),
    projectClaudeMdTokens,
    projectClaudeMdUsd: perTurnUsd(projectClaudeMdTokens),
    skillDescriptionTokens,
    skillDescriptionUsd: perTurnUsd(skillDescriptionTokens),
    skillCount: userSkills.length,
    skillCarry: userSkills.map((s) => ({ ...s, monthlyUsd: perTurnUsd(s.descTokens) })),
    pluginSkillTokens: pluginTax.pluginSkillTokens,
    pluginSkillUsd: perTurnUsd(pluginTax.pluginSkillTokens),
    pluginCommandTokens: pluginTax.pluginCommandTokens,
    pluginCommandUsd: perTurnUsd(pluginTax.pluginCommandTokens),
    pluginAgentTokens: pluginTax.pluginAgentTokens,
    pluginAgentUsd: perTurnUsd(pluginTax.pluginAgentTokens),
    pluginListingTokens: pluginTax.pluginListingTokens,
    pluginListingUsd: perTurnUsd(pluginTax.pluginListingTokens),
    pluginCount: pluginTax.pluginCount,
    unusedPluginCount: pluginTax.unusedCount,
    plugins: pluginTax.plugins,
    mcpServerCount: mcpServerNames.length,
    mcpServerNames,
    mcpDeferred,
    mcpInvokedRate: sessions.length ? mcpSessions / sessions.length : 0,
    conditionalContext: detectConditionalContext(sessions),
    spawnsPerMonth,
    spawnPrefixTokens,
    spawnTaxMonthlyUsd: (spawns.reduce((n, x) => n + x.setupUsd, 0) / windowDays) * 30.44,
    cacheReadRatePerMTok: rate,
    cacheWriteRatePerMTok: writeRate,
    note:
      'Always-on config = project memory (every CLAUDE.md + CLAUDE.local.md from cwd up to ' +
      'the repo root) + global memory + skill listings + enabled-plugin listings, measured from your files and cache-read ' +
      'into every turn. This is what your chosen context COSTS, not waste to cut — useful ' +
      'config earns its tokens. The larger OBSERVED standing context is mostly fixed system ' +
      'prompt + tool schemas. Run /context in a session for the authoritative live breakdown.',
  };
}
