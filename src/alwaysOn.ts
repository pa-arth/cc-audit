// Always-on context tax. Two numbers, deliberately separated:
//   1) OBSERVED standing context — the empirical turn-1 prefix. Includes the system
//      prompt + tool schemas + your first user prompt, MOST of which is FIXED and
//      cannot be trimmed. Kept as honest context, NOT as a "savings" headline.
//   2) ALWAYS-ON CONFIG cost — the context the developer CHOSE, re-paid every turn.
//      We report it as a COST, not as "savings": useful CLAUDE.md / auto-memory is not
//      waste, and telling people to delete it to save money is the same over-promise as
//      the old MCP $246 inflation. Real trim advice is kept narrow and evidence-based
//      (see conditionalContext read-rates) — the value call stays with the user.
//
// (2) IS MEASURED FROM THE TRANSCRIPT, NOT CENSUSED FROM DISK. See injectedPrefix.ts for
// the full reasoning. The short version: Claude Code records every injected block,
// itemised, as a typed `attachment` row. A disk census cannot see built-in skills (they
// ship inside the binary), does not read `skillOverrides` (so it bills skills the user
// switched off), misses symlinked skill dirs, and goes stale on every vendor release with
// nothing subscribed to tell it. Measured over 501 local sessions, the census read the
// skill listing at 967 tokens against a measured median near 5,680 — and it was wrong in
// BOTH directions, so "scale the floor up" would not have fixed it.
//
// THE DISK CENSUS IS RETAINED, DEMOTED. It ATTRIBUTES a measured block to the user's
// files — which skill, which hook, which command owns which slice. It no longer decides
// how big the block is. Every attribution here is a slice OF a measured total, never an
// addend TO it: plugin listings and user commands appear INSIDE the injected skill
// listing, so adding them alongside it (as this module used to) double-counts them.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoMemoryTokens, countTokens, globalMemoryTokens, projectMemoryTokens } from './configFiles.js';
import { detectConditionalContext, type ConditionalContextItem } from './conditionalContext.js';
import { fixedPrefixTokens, reconcile, type ReconciliationFailure } from './injectedPrefix.js';
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
  /** countTokens(`${name}: ${desc}`) — this skill's slice of the measured listing. */
  descTokens: number;
  /** Did this skill appear in an injected `skill_listing` in the window?
   *
   *  Disk presence is NOT loading. `settings.json > skillOverrides` can switch a skill
   *  off, and Claude Code then leaves it out of the listing while the SKILL.md stays
   *  exactly where it was — six such skills on the machine that motivated this change,
   *  every one of them previously billed a per-turn carry cost it does not have. The
   *  listing's own `names[]` is the only authoritative membership statement. */
  loaded: boolean;
  /** Why a disk skill is not loading, when we can say ('disabled in skillOverrides').
   *  null when it IS loading, or when it is absent for a reason we cannot name — which
   *  is itself worth distinguishing from a confident "disabled". */
  notLoadedReason: string | null;
}

/** Fields whose token count could not be determined, mapped to the reason.
 *
 *  A field named here reports `null`, never `0`. Zero and unknown render identically to
 *  a reader and mean opposite things: "you carry no hook output" is a stronger and more
 *  wrong claim than "we could not size your hook output". A field ABSENT from this map
 *  carries a real measurement, including a real measured zero. */
export type UnmeasuredReasons = Record<string, string>;

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
   *  filesystem root (CC's directory walk), not just the file at cwd. Handles
   *  worktree/subdir cwds correctly. PROJECT INSTRUCTION FILES ONLY — auto-memory used to
   *  be folded in here and now has its own field, because the two are edited by different
   *  people on different cadences and a user who halves their memory index could not tell
   *  what moved. */
  projectClaudeMdTokens: number;
  projectClaudeMdUsd: number;
  /** Auto-memory (MEMORY.md) loaded at the start of every conversation. Split out of
   *  projectClaudeMdTokens. null ⇒ we could not locate the project's memory dir at all
   *  (the projects-dir encoding is CC-internal), which is NOT the same as "you have no
   *  auto-memory" — see `unmeasured`. */
  autoMemoryTokens: number | null;
  autoMemoryUsd: number | null;

  /** MEASURED size of the injected `skill_listing` block — the whole listing, including
   *  built-in skills, plugin commands and user commands that are not (or not findably) on
   *  disk. Replaces the old `skillDescriptionTokens`, which summed SKILL.md frontmatter
   *  under ~/.claude/skills and was a floor ~5.9x below this.
   *
   *  RENAMED DELIBERATELY. The quantity changed meaning, and a field that keeps its name
   *  while changing meaning lets a downstream comparison silently mix the two — the exact
   *  defect class this change exists to close. */
  skillListingTokens: number | null;
  skillListingUsd: number | null;
  /** Skills in the injected LISTING, not directories on disk. */
  skillCount: number | null;
  /** Per-skill standing-carry breakdown (LOCAL-ONLY — declaredName/slug are custom names,
   *  never uploaded). ATTRIBUTION INSIDE skillListingTokens, not a total: it covers only
   *  the skills we can find on disk, so it does not sum to the listing and must never be
   *  presented as if it did. Rows with `loaded: false` cost nothing and are shown so the
   *  user can see what they have switched off. */
  skillCarry: Array<SkillCarry & { monthlyUsd: number }>;
  /** Tokens of ~/.claude/commands/**  — user slash commands. They appear IN the injected
   *  listing (e.g. `opsx:apply`), so this ATTRIBUTES part of skillListingTokens and is
   *  NOT added to it. Nothing walked this directory before. */
  userCommandTokens: number;
  userCommandUsd: number;
  /** Portion of the measured listing no on-disk file accounts for — built-in skills that
   *  ship inside the Claude Code binary, mostly. Reported so the total is never quietly
   *  reduced to the part we happen to be able to name. */
  skillListingUnattributedTokens: number | null;

  /** MEASURED hook output injected into the prefix (hook_success +
   *  hook_additional_context + hook_system_message). 100% user-authored and trivially
   *  removable, which makes it the most actionable line here — and it had no field at
   *  all before this change. */
  hookOutputTokens: number | null;
  hookOutputUsd: number | null;
  /** Per-hook breakdown, median tokens across the sessions that ran that hook.
   *  LOCAL-ONLY — hook names are user-authored, same bar as skillCarry. This is what
   *  makes the hook line actionable: "950 tokens of hook output" is a fact, "SessionStart
   *  costs you 720 of them" is something you can act on. */
  hookCarry: Array<{ hookName: string; tokens: number; monthlyUsd: number; sessions: number }>;
  /** MEASURED MCP server instruction blocks. */
  mcpInstructionTokens: number | null;
  mcpInstructionUsd: number | null;
  /** MEASURED deferred-tool-name delta (the ToolSearch stub list). */
  deferredToolTokens: number | null;
  deferredToolUsd: number | null;
  /** MEASURED subagent-type listing. */
  agentListingTokens: number | null;
  agentListingUsd: number | null;
  /** Injected blocks with no field of their own, summed, with their kind names. A vendor
   *  release that adds a kind shows up HERE as a growing residual rather than as an
   *  unexplained gap — that is the whole point of carrying it. */
  otherInjectedTokens: number | null;
  otherInjectedKinds: string[];

  /** The remainder of the measured prefix: system prompt + tool schemas. NOT the user's
   *  to cut, and named for exactly that reason — without it the breakdown reads as
   *  "delete all of this" when the vendor owns the large majority of the floor. */
  fixedPrefixTokens: number | null;
  fixedPrefixUsd: number | null;
  /** Sessions whose components exceeded their measured prefix. Non-empty ⇒ double
   *  counting or a prefix formula that has drifted from the vendor's. Surfaced, never
   *  clamped: clamping is how this defect class hides, leaving a plausible number over a
   *  wrong model. */
  reconciliationFailures: ReconciliationFailure[];

  /** Fields that report `null` above, mapped to why. See UnmeasuredReasons. */
  unmeasured: UnmeasuredReasons;

  /** Standing cost of ENABLED plugins: their bundled skill/command/agent listings load
   *  into every turn just like user skills.
   *
   *  NO LONGER ADDED to alwaysOnConfigTokensPerTurn. Plugin assets appear INSIDE the
   *  injected skill listing (`claude-hud:setup` is right there in it), so adding these
   *  beside the measured listing double-counts them. They are attribution now.
   *
   *  `pluginSkillTokens: 0` is a REAL zero, verified, not an unknown: the walk runs and
   *  the enabled plugin ships commands with no `skills/` dir. Do not "fix" it to null. */
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
  /** True ⇒ MCP tools were tool-search-deferred ⇒ ~0 standing cost for their schemas.
   *
   *  DERIVED PER SESSION from the presence of a `deferred_tools_delta` attachment — i.e.
   *  from the environment the audited sessions ACTUALLY RAN IN. It used to be inferred
   *  from `process.env.ENABLE_TOOL_SEARCH` in the AUDITING process, which is a different
   *  process, frequently a different shell, and answers a different question. */
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

/** One row per SKILL.md directly under a skills dir — used to ATTRIBUTE slices of the
 *  measured listing to the user's files. Never a total: built-in skills ship inside the
 *  Claude Code binary and are not on disk at all.
 *
 *  `loaded` is filled in later, against the injected listing's own `names[]`. */
function skillListings(skillsDir: string): SkillCarry[] {
  const out: SkillCarry[] = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // isDirectory() is FALSE for a symlink pointing at a directory, and skills are
    // commonly symlinked out to a shared store (~/.agents/skills/**). Testing only
    // isDirectory() skipped four real skills on the machine that motivated this change.
    // existsSync below follows the link, so a dangling symlink still drops out.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
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
    out.push({
      slug: e.name,
      declaredName: name,
      descTokens: countTokens(`${name}: ${desc}`),
      loaded: true,
      notLoadedReason: null,
    });
  }
  return out;
}

/** Skills switched off in `settings.json > skillOverrides`. Claude Code honours these and
 *  omits them from the listing; nothing here read them before, so they were billed a
 *  per-turn carry cost they do not have. Reading them lets a non-loading skill be
 *  reported with a REASON instead of just disappearing. */
function disabledSkills(claudeDir: string): Set<string> {
  try {
    const cfg = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as {
      skillOverrides?: Record<string, string>;
    };
    return new Set(
      Object.entries(cfg.skillOverrides ?? {})
        .filter(([, v]) => v === 'off')
        .map(([k]) => k),
    );
  } catch {
    return new Set();
  }
}

/** Listing tokens for user slash commands under ~/.claude/commands/**, including one
 *  level of namespacing (`commands/opsx/apply.md` → `opsx:apply`).
 *
 *  These load into the injected skill listing every turn and NOTHING walked this
 *  directory before — not this module (skills only) and not pluginTax (plugin dirs only).
 *  Six of them on the authoring machine. Attribution inside the measured listing, so it
 *  is never added to it. */
function userCommandListingTokens(commandsDir: string): number {
  let total = 0;
  const scan = (dir: string, ns: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if ((e.isDirectory() || e.isSymbolicLink()) && !e.name.endsWith('.md')) {
        if (depth < 1) scan(p, `${e.name}:`, depth + 1); // CC namespaces one level deep
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      let txt;
      try {
        txt = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const slug = e.name.replace(/\.md$/, '');
      const desc = /^description:\s*(.+)$/m.exec(txt)?.[1] ?? '';
      total += countTokens(`${ns}${slug}: ${desc}`);
    }
  };
  scan(commandsDir, '', 0);
  return total;
}

/** Sum of `name: description` tokens (and count) for every SKILL.md directly under a
 *  skills dir. Exported so pluginTax can reuse it on a plugin's bundled `skills/` dir —
 *  same on-disk shape. Thin wrapper over skillListings. */
export function diskSkillListingTokens(skillsDir: string): { tokens: number; count: number } {
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
  const userSkills = skillListings(join(claudeDir, 'skills'));
  const offSkills = disabledSkills(claudeDir);
  const userCommandTokens = userCommandListingTokens(join(claudeDir, 'commands'));
  const mcpServerNames = listMcpServers();

  // Per-session measured components. Medianed INDEPENDENTLY of the prefix median would
  // be wrong — median(a) + median(b) != median(a+b) — so the reconciliation remainder is
  // computed per session and medianed after, and the invariant is checked per session
  // where a violation is actually attributable to a transcript.
  const measured = {
    skill: [] as number[],
    hook: [] as number[],
    mcp: [] as number[],
    deferred: [] as number[],
    agent: [] as number[],
    other: [] as number[],
    fixed: [] as number[],
  };
  const otherKinds = new Set<string>();
  // hookName → per-session token totals, so each hook gets a MEDIAN across the sessions
  // that ran it rather than a mean diluted by sessions where it never fired.
  const hookByName = new Map<string, number[]>();
  const listingNames = new Set<string>();
  const listingCounts: number[] = [];
  const reconciliationFailures: ReconciliationFailure[] = [];
  let deferredSessions = 0;
  let deferralEvidenceSessions = 0;
  let sessionsWithInjection = 0;

  // Project memory, turn-weighted by cwd. CC walks cwd→root loading every CLAUDE.md +
  // CLAUDE.local.md, so we do too (projectMemoryTokens) — counting only the file at
  // cwd zero-counts the common case where you run in a subdir/worktree and the real
  // CLAUDE.md sits at the repo root above you. Caching per distinct cwd and weighting
  // by that cwd's turns still avoids inflating a file shared across worktrees.
  const projectMdByCwd = new Map<string, [projectMd: number, autoMemory: number]>();
  let projectTokenTurns = 0;
  let autoMemoryTokenTurns = 0;
  // Sessions whose cwd we know — the denominator for auto-memory. A session with no cwd
  // cannot be asked about auto-memory at all, and averaging it in as 0 would report
  // "no auto-memory" for a question we never got to ask.
  let cwdKnownTurns = 0;

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
    // The prefix includes what turn 1 READ from cache, not only what it wrote. A
    // session resuming in a project it has run in before finds the whole prefix
    // already cached and writes almost nothing — so omitting cacheRead reported a
    // large standing context as a small one, on exactly the sessions where it is
    // largest. Measured over 522 local sessions: turn 1 reads from cache in 97.9%
    // of them, and including the term moves the median 40,272 -> 59,645 (1.48x),
    // landing within 1.8% of the same quantity measured independently by
    // differencing `claude -p` runs with one context component removed (60,738).
    const prefixTokens = firstMain
      ? firstMain.usage.input +
        firstMain.usage.cacheWrite5m +
        firstMain.usage.cacheWrite1h +
        firstMain.usage.cacheRead
      : null;
    if (prefixTokens != null) prefixes.push(prefixTokens);

    // The MEASURED breakdown of that same prefix. Filled from the SAME turn the median
    // above is built from, so the components can never reconcile against a different
    // number than standingContextTokens reports.
    // `sawAnyAttachment` is the gate, NOT `s.injected` being present. A transcript that
    // predates attachment records parses into a zero-filled InjectedPrefix, and folding
    // that into the medians would push a 0 into every component — recording "we never got
    // to ask" as "you carry none of this", which is the whole defect this change closes.
    // Once the format IS present, a missing KIND is a real zero and does count: a session
    // with attachments but no hook_success genuinely ran no hooks.
    if (s.injected?.sawAnyAttachment && prefixTokens != null) {
      const inj = { ...s.injected, measuredPrefixTokens: prefixTokens };
      sessionsWithInjection += 1;
      measured.skill.push(inj.skillListingTokens);
      measured.hook.push(inj.hookOutputTokens);
      measured.mcp.push(inj.mcpInstructionTokens);
      measured.deferred.push(inj.deferredToolTokens);
      measured.agent.push(inj.agentListingTokens);
      measured.other.push(inj.otherInjectedTokens);
      for (const k of inj.otherInjectedKinds) otherKinds.add(k);
      for (const [name, tok] of Object.entries(inj.hookTokensByName)) {
        const xs = hookByName.get(name) ?? [];
        xs.push(tok);
        hookByName.set(name, xs);
      }
      for (const n of inj.skillNames) listingNames.add(n);
      if (inj.listingSkillCount != null) listingCounts.push(inj.listingSkillCount);
      deferralEvidenceSessions += 1;
      if (inj.sawDeferredTools) deferredSessions += 1;

      const failure = reconcile(s.sessionId, inj);
      if (failure) reconciliationFailures.push(failure);
      // Pushed EVEN WHEN NEGATIVE. Dropping the negatives would leave a clean-looking
      // median over a broken model — the failures list carries the alarm, and the median
      // must be built from the same population it describes.
      measured.fixed.push(fixedPrefixTokens(inj)!);
    }

    // Project memory and auto-memory are tracked separately now: they are edited by
    // different people on different cadences, and folding them into one field meant a
    // user who halved their memory index saw a number named for their CLAUDE.md move.
    let projMd = 0;
    let autoMem = 0;
    if (s.cwd) {
      const cached = projectMdByCwd.get(s.cwd);
      if (cached) {
        [projMd, autoMem] = cached;
      } else {
        projMd = projectMemoryTokens(s.cwd, claudeDir);
        autoMem = autoMemoryTokens(s.cwd, projectsRoot);
        projectMdByCwd.set(s.cwd, [projMd, autoMem]);
      }
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
    autoMemoryTokenTurns += autoMem * sessionTurns;
    if (s.cwd) cwdKnownTurns += sessionTurns;
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
  const pluginTax = computePluginTax(sessions);

  // ---- The measured components. -------------------------------------------------
  // `unmeasured` names every field that reports null and why. A field reporting a number
  // is a measurement, including a measured 0; a field reporting null is a question we
  // could not answer. They are never the same value.
  const unmeasured: UnmeasuredReasons = {};
  // NB: these strings are printed in the report, which may never use the word "window" —
  // a word it could not define for the reader (report.test.ts enforces it).
  const noInjection =
    sessions.length === 0
      ? 'no sessions on disk to measure'
      : 'no session recorded first-turn attachments (transcripts predate the format, or every session was a resumed replay)';
  const med = (xs: number[], field: string): number | null => {
    if (xs.length === 0) {
      unmeasured[field] = noInjection;
      return null;
    }
    return median(xs);
  };

  const skillListingTokens = med(measured.skill, 'skillListingTokens');
  const hookOutputTokens = med(measured.hook, 'hookOutputTokens');
  const mcpInstructionTokens = med(measured.mcp, 'mcpInstructionTokens');
  const deferredToolTokens = med(measured.deferred, 'deferredToolTokens');
  const agentListingTokens = med(measured.agent, 'agentListingTokens');
  const otherInjectedTokens = med(measured.other, 'otherInjectedTokens');
  const fixedPrefix = med(measured.fixed, 'fixedPrefixTokens');

  // Auto-memory: 0 from `autoMemoryTokens` means "no MEMORY.md at the encoded path", and
  // the encoding is CC-internal and undocumented — so a miss and a genuine absence both
  // arrived as 0. Distinguish them by whether we ever had a cwd to ask about at all.
  const autoMemory = cwdKnownTurns ? autoMemoryTokenTurns / cwdKnownTurns : null;
  if (autoMemory == null) {
    unmeasured.autoMemoryTokens = 'no session recorded a working directory, so no project memory dir could be located';
  }

  // ---- Attribution INSIDE the measured listing (never added to it). ---------------
  // A skill on disk is not a skill that loads: `skillOverrides` switches skills off and
  // CC omits them from the listing while the SKILL.md stays put. The listing's names[]
  // is the authoritative membership set, so we intersect against it. Union across the
  // window rather than the latest session, because project-scoped skills make any single
  // session's listing a partial view of what ever loads.
  // The listing's own count, not the directory count. `readdirSync` answers "how many
  // skills are installed"; the user is being told "how many load every turn", and on the
  // authoring machine those were 15 and 32.
  const skillCount = med(listingCounts, 'skillCount');

  const haveListing = listingNames.size > 0;
  const carry = userSkills.map((s) => {
    const loaded = haveListing ? listingNames.has(s.slug) || listingNames.has(s.declaredName) : true;
    const notLoadedReason = loaded
      ? null
      : offSkills.has(s.slug)
        ? 'disabled in settings.json > skillOverrides'
        : 'on disk but absent from every injected skill listing seen';
    return { ...s, loaded, notLoadedReason };
  });
  const loadedCarryTokens = carry.reduce((n, s) => n + (s.loaded ? s.descTokens : 0), 0);
  // The listing minus everything we can name on disk — built-in skills, mostly, which
  // ship inside the binary and no census can ever see. Reported so the measured total is
  // never quietly reduced to the part we happen to be able to attribute. Floored at 0
  // because attribution over-shooting the block means our per-skill estimate is off, not
  // that the block is smaller than measured — unlike fixedPrefix, where a negative is
  // real evidence of double counting and must surface.
  const skillListingUnattributedTokens =
    skillListingTokens == null
      ? null
      : Math.max(0, skillListingTokens - loadedCarryTokens - userCommandTokens - pluginTax.pluginListingTokens);

  // ---- The always-on config headline. ---------------------------------------------
  // Memory is attribution INSIDE userMessageTokens (CLAUDE.md arrives as a
  // <system-reminder> on the first user row), while the listings arrive as their own
  // attachments — so memory + measured attachments is a sum of disjoint parts.
  //
  // pluginListingTokens is NOT added any more. Plugin assets are IN the skill listing
  // (`claude-hud:setup` appears in it verbatim), so the old line added them twice.
  const measuredConfig =
    (skillListingTokens ?? 0) +
    (hookOutputTokens ?? 0) +
    (mcpInstructionTokens ?? 0) +
    (deferredToolTokens ?? 0) +
    (agentListingTokens ?? 0);
  const alwaysOnConfigTokensPerTurn =
    globalClaudeMdTokens + projectClaudeMdTokens + (autoMemory ?? 0) + measuredConfig;

  // MCP deferral, read from the sessions AS THEY RAN rather than inferred from this
  // process's env — a `deferred_tools_delta` in the transcript IS tool-search deferral
  // having happened. Majority across the window; the env fallback only survives where no
  // session recorded the attachment at all.
  const mcpDeferred = deferralEvidenceSessions
    ? deferredSessions * 2 >= deferralEvidenceSessions
    : process.env.ENABLE_TOOL_SEARCH !== 'false';

  const usd = (tok: number | null): number | null => (tok == null ? null : perTurnUsd(tok));

  const hookCarry = [...hookByName.entries()]
    .map(([hookName, xs]) => ({
      hookName,
      tokens: median(xs),
      monthlyUsd: perTurnUsd(median(xs)),
      sessions: xs.length,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    standingContextTokens: standing,
    observedMonthlyUsd: perTurnUsd(standing),
    alwaysOnConfigTokensPerTurn,
    alwaysOnConfigMonthlyUsd: perTurnUsd(alwaysOnConfigTokensPerTurn),
    globalClaudeMdTokens,
    globalClaudeMdUsd: perTurnUsd(globalClaudeMdTokens),
    projectClaudeMdTokens,
    projectClaudeMdUsd: perTurnUsd(projectClaudeMdTokens),
    autoMemoryTokens: autoMemory,
    autoMemoryUsd: usd(autoMemory),

    skillListingTokens,
    skillListingUsd: usd(skillListingTokens),
    skillCount,
    // A non-loading skill costs nothing, so its monthlyUsd is 0 — not its descTokens
    // priced as if it loaded, which is what the old row asserted for six disabled skills.
    skillCarry: carry.map((s) => ({ ...s, monthlyUsd: s.loaded ? perTurnUsd(s.descTokens) : 0 })),
    userCommandTokens,
    userCommandUsd: perTurnUsd(userCommandTokens),
    skillListingUnattributedTokens,

    hookOutputTokens,
    hookOutputUsd: usd(hookOutputTokens),
    hookCarry,
    mcpInstructionTokens,
    mcpInstructionUsd: usd(mcpInstructionTokens),
    deferredToolTokens,
    deferredToolUsd: usd(deferredToolTokens),
    agentListingTokens,
    agentListingUsd: usd(agentListingTokens),
    otherInjectedTokens,
    otherInjectedKinds: [...otherKinds],

    fixedPrefixTokens: fixedPrefix,
    fixedPrefixUsd: usd(fixedPrefix),
    reconciliationFailures,
    unmeasured,
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
      'Always-on config = memory (every CLAUDE.md + CLAUDE.local.md from cwd up to the repo ' +
      'root, plus global memory and auto-memory) + the injected skill listing, hook output, ' +
      'MCP instructions, deferred-tool and agent listings. The listings are MEASURED from ' +
      "your transcripts' first-turn attachment records, not estimated from files on disk — " +
      'built-in skills ship inside the Claude Code binary and never appear on disk at all. ' +
      'This is what your chosen context COSTS, not waste to cut — useful config earns its ' +
      'tokens. The rest of the observed standing context is fixed system prompt + tool ' +
      'schemas, reported as fixedPrefixTokens and NOT yours to trim. Run /context in a ' +
      'session for the authoritative live breakdown.',
  };
}
