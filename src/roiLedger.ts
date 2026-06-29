// Skill / MCP ROI ledger — carry cost vs. realized value, with a verdict. The
// "itemized context invoice" idea taken one step past CSA: we already own the carry
// half (alwaysOn.skillCarry, ~/.claude.json server list) AND the realized half
// (attribute.ts's three boards), so we can name the DEAD-WEIGHT — a skill enumerated
// on disk, re-paid every turn, but invoked ~0 times corpus-wide.
//
// The dead-weight verdict is deliberately TWO-SIDED: a never-invoked skill is either
// genuinely unused (delete it) OR its `description:` trigger keywords don't match how
// you phrase prompts so it never fires (rewrite it). Claude does keyword-ish, not
// semantic, activation — and we cannot tell which case it is from transcripts alone,
// so we surface both levers and let the user open the file.
//
// LOCAL-ONLY: skill/server names are custom (repo/org-shaped) and never leave the
// machine. Only the counts-only `summary` is safe to aggregate (see aggregate.ts).

import type { AlwaysOnTax } from './alwaysOn.js';
import type { SpendBreakdown } from './attribute.js';
import type { Session } from './model.js';

export type SkillVerdict = 'dead-weight' | 'heavy-but-earning' | 'cheap-fine';

export interface SkillRoiRow {
  /** Display key — declaredName when present, else slug. */
  name: string;
  slug: string;
  /** CARRY: standing listing cost this skill re-pays every turn ($/mo). 0 if not on disk
   *  (a bundled/plugin skill seen only via invocation — no SKILL.md to count). */
  carryUsdPerMonth: number;
  carryTokens: number;
  /** REALIZED value, unified across the three attribution boards. */
  invocations: number;
  /** command.costUsd + subagent.costUsd + modelInvoked.spanUsdUpperBound (UPPER BOUND —
   *  the model-invoked share is the whole span, shared with other work). */
  realizedUsd: number;
  viaCommand: boolean;
  viaModelInvoked: boolean;
  viaSubagent: boolean;
  /** False when no SKILL.md was found on disk (carry unknown; can't recommend a file edit). */
  onDisk: boolean;
  /** n<5 corpus confidence: 0 < invocations < CONFIDENCE_MIN → render dimmed / "unconfirmed". */
  lowConfidence: boolean;
  verdict: SkillVerdict;
  /** Friction integration point (see friction.ts). Absent until friction is folded in. */
  frictionCount?: number;
}

export interface McpRoiRow {
  /** Raw server name (LOCAL-ONLY). */
  server: string;
  invocations: number;
  distinctTools: number;
  sessionsUsed: number;
  /** Present in ~/.claude.json. */
  configured: boolean;
  /** Configured but never invoked. If !deferred it's ALSO paying standing token cost. */
  deadWeight: boolean;
  /** Servers are tool-search-deferred (no standing cost even if dead). */
  deferred: boolean;
}

export interface RoiLedger {
  /** Sorted: dead-weight (by carry desc) → earning (by realized desc) → cheap. */
  skills: SkillRoiRow[];
  /** Sorted: dead-weight first, then by invocations desc. */
  mcp: McpRoiRow[];
  /** Counts-only summary — the ONLY part safe for the aggregate. */
  summary: {
    deadWeightSkillCount: number;
    deadWeightSkillCarryUsdPerMonth: number;
    earningSkillCount: number;
    cheapSkillCount: number;
    deadWeightMcpCount: number;
    /** Any dead server while !deferred ⇒ standing token cost for nothing. */
    deadWeightMcpStandingCost: boolean;
  };
}

const CONFIDENCE_MIN = 5; // mirror conditionalContext.MIN_SESSIONS_FOR_CONFIRM
const DEAD_WEIGHT_MAX_INV = 0; // ~0 invocations corpus-wide = dead-weight
// "Heavy" = carry that's a real line item. Tie to the $0.50/mo floor recommend.ts uses
// for the pin gate, so the ledger and the recommendations agree.
const HEAVY_CARRY_USD = 0.5;

/** Normalize a skill key: strip a `plugin:` prefix, lowercase. Mirrors locateSkillFile. */
const norm = (n: string): string => (n.includes(':') ? n.split(':').pop()! : n).toLowerCase();

/** Join carry (per-skill listing) against realized spend (three boards) into one row each. */
export function buildRoiLedger(spend: SpendBreakdown, alwaysOn: AlwaysOnTax, sessions: Session[]): RoiLedger {
  const rows = new Map<string, SkillRoiRow>();
  // declaredName/slug aliases → canonical key, so a skill reached by either form unifies.
  const aliasToKey = new Map<string, string>();

  // Seed from disk carry — these are the only rows eligible to be "dead-weight".
  for (const s of alwaysOn.skillCarry) {
    const key = norm(s.slug);
    rows.set(key, {
      name: s.declaredName || s.slug,
      slug: s.slug,
      carryUsdPerMonth: s.monthlyUsd,
      carryTokens: s.descTokens,
      invocations: 0,
      realizedUsd: 0,
      viaCommand: false,
      viaModelInvoked: false,
      viaSubagent: false,
      onDisk: true,
      lowConfidence: false,
      verdict: 'cheap-fine',
    });
    aliasToKey.set(key, key);
    aliasToKey.set(norm(s.declaredName), key);
  }

  // A board name with no carry row is a bundled/plugin skill not on disk — create a row
  // (onDisk: false) so its spend is visible, but it can never be dead-weight.
  const resolve = (name: string): SkillRoiRow => {
    const key = aliasToKey.get(norm(name)) ?? norm(name);
    let row = rows.get(key);
    if (!row) {
      row = {
        name,
        slug: key,
        carryUsdPerMonth: 0,
        carryTokens: 0,
        invocations: 0,
        realizedUsd: 0,
        viaCommand: false,
        viaModelInvoked: false,
        viaSubagent: false,
        onDisk: false,
        lowConfidence: false,
        verdict: 'cheap-fine',
      };
      rows.set(key, row);
      aliasToKey.set(key, key);
    }
    return row;
  };

  for (const c of spend.commandLeakBoard) {
    const r = resolve(c.command);
    r.invocations += c.invocations;
    r.realizedUsd += c.costUsd;
    r.viaCommand = true;
  }
  for (const sg of spend.subagentLeakBoard) {
    if (!sg.isSkill) continue;
    const r = resolve(sg.name);
    // Sidechains have no per-invocation count; treat the rollup as at least one run.
    r.invocations += 1;
    r.realizedUsd += sg.costUsd;
    r.viaSubagent = true;
  }
  for (const m of spend.modelInvokedSkills) {
    const r = resolve(m.name);
    r.invocations += m.invocations;
    r.realizedUsd += m.spanUsdUpperBound;
    r.viaModelInvoked = true;
  }

  for (const r of rows.values()) {
    if (r.onDisk && r.invocations <= DEAD_WEIGHT_MAX_INV) r.verdict = 'dead-weight';
    else if (r.carryUsdPerMonth >= HEAVY_CARRY_USD && r.invocations > 0) r.verdict = 'heavy-but-earning';
    else r.verdict = 'cheap-fine';
    r.lowConfidence = r.invocations > 0 && r.invocations < CONFIDENCE_MIN;
  }

  const VERDICT_ORDER: Record<SkillVerdict, number> = { 'dead-weight': 0, 'heavy-but-earning': 1, 'cheap-fine': 2 };
  const skills = [...rows.values()].sort((a, b) => {
    if (VERDICT_ORDER[a.verdict] !== VERDICT_ORDER[b.verdict]) return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    if (a.verdict === 'dead-weight') return b.carryUsdPerMonth - a.carryUsdPerMonth;
    return b.realizedUsd - a.realizedUsd;
  });

  const mcp = buildMcpRows(spend, alwaysOn, sessions);

  return {
    skills,
    mcp,
    summary: {
      deadWeightSkillCount: skills.filter((s) => s.verdict === 'dead-weight').length,
      deadWeightSkillCarryUsdPerMonth: skills
        .filter((s) => s.verdict === 'dead-weight')
        .reduce((n, s) => n + s.carryUsdPerMonth, 0),
      earningSkillCount: skills.filter((s) => s.verdict === 'heavy-but-earning').length,
      cheapSkillCount: skills.filter((s) => s.verdict === 'cheap-fine').length,
      deadWeightMcpCount: mcp.filter((m) => m.deadWeight).length,
      deadWeightMcpStandingCost: mcp.some((m) => m.deadWeight && !m.deferred),
    },
  };
}

function buildMcpRows(_spend: SpendBreakdown, alwaysOn: AlwaysOnTax, sessions: Session[]): McpRoiRow[] {
  // Realized: count mcp__<server>__<tool> calls across every turn.
  const seen = new Map<string, { inv: number; tools: Set<string>; sessions: Set<string> }>();
  for (const s of sessions) {
    for (const span of s.spans) {
      for (const t of span.turns) {
        for (const tool of t.tools) {
          if (!tool.startsWith('mcp__')) continue;
          const server = tool.split('__')[1];
          if (!server) continue; // malformed 'mcp__' / 'mcp__srv' (no __tool) — skip cleanly
          let e = seen.get(server);
          if (!e) {
            e = { inv: 0, tools: new Set(), sessions: new Set() };
            seen.set(server, e);
          }
          e.inv += 1;
          e.tools.add(tool);
          e.sessions.add(s.sessionId);
        }
      }
    }
  }

  const rows: McpRoiRow[] = [];
  const configured = new Set(alwaysOn.mcpServerNames);
  // Configured servers — dead-weight is only meaningful for these.
  for (const server of alwaysOn.mcpServerNames) {
    const e = seen.get(server);
    rows.push({
      server,
      invocations: e?.inv ?? 0,
      distinctTools: e?.tools.size ?? 0,
      sessionsUsed: e?.sessions.size ?? 0,
      configured: true,
      deadWeight: (e?.inv ?? 0) === 0,
      deferred: alwaysOn.mcpDeferred,
    });
  }
  // Servers invoked but not in the parsed config (project-local config we didn't read) —
  // surface them, but they can never be "dead-weight".
  for (const [server, e] of seen) {
    if (configured.has(server)) continue;
    rows.push({
      server,
      invocations: e.inv,
      distinctTools: e.tools.size,
      sessionsUsed: e.sessions.size,
      configured: false,
      deadWeight: false,
      deferred: alwaysOn.mcpDeferred,
    });
  }

  return rows.sort((a, b) => {
    if (a.deadWeight !== b.deadWeight) return a.deadWeight ? -1 : 1;
    return b.invocations - a.invocations;
  });
}
