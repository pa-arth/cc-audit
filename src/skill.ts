// The cc-audit analysis skill: the PRIMARY path by which a developer's own agent
// turns `cc-audit --json` into coaching.
//
// It is EMBEDDED here, not fetched. The skill is an instruction set that runs in the
// developer's repo with their agent's permissions, so a network delivery path would
// make one bad push reach every install at once. Shipping it in the binary means:
// installs offline, readable before it ever runs, and there is no supply chain to
// compromise. The copy in the public repo is the readable source of truth — it is not
// the delivery mechanism.
//
// Compute stays on THEIR subscription: this file writes a markdown file, nothing more.
// cc-audit never calls a hosted model to produce this analysis.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bump when SKILL_MARKDOWN changes so an existing install is refreshed, not skipped. */
export const SKILL_VERSION = 3;

const VERSION_MARKER = 'cc-audit-skill-version:';

/** The full text written to ~/.claude/skills/cc-audit/SKILL.md. */
export const SKILL_MARKDOWN = `---
name: cc-audit
description: Analyze this developer's own Claude Code usage and produce three concrete improvement plans. Use when they ask about their token spend, why they ran out of window, their context hygiene, model choices, CLAUDE.md/skill overhead, or ask to be coached on how they drive the agent. Runs the local \`cc-audit\` CLI — read-only, no network.
---

<!-- ${VERSION_MARKER} ${SKILL_VERSION} -->

# cc-audit — coach me on my own usage

You are coaching the developer on **their own** agent usage, using measured data from
their local transcripts. You are already in their session with their repo loaded — use
that. Generic advice is a failure; the whole point is that you can see both the numbers
and the code they were written about.

## 1. Get the data

\`\`\`bash
cc-audit --json --since-days 30
\`\`\`

That prints one JSON object and exits. What it does, stated exactly — do not paraphrase
this to the developer more reassuringly than it reads:

- **Reads** \`~/.claude/projects\` (their transcripts).
- **Writes** a run-history snapshot under \`~/.cc-audit/history/\`, so the next run can
  show deltas. If they ran the analysis from the CLI, the plans it produced are also
  kept under \`~/.cc-audit/history/advice/\`. Nothing else on disk.
- **Transmits** only if they previously turned on data sharing. If they did, this command
  also sends the privacy-safe aggregate plus their task gists. \`cc-audit capture --status\`
  says which, and \`cc-audit capture --off\` stops it.
- **Never** reads or transmits source code or diffs, under any flag.

If the command is not found, tell them to run \`npx @promptster/cc-audit\` and stop; do not
guess at numbers.

Run it once. Do not re-run it per finding.

## 2. Read the fields that matter

The record is large. These are the ones that carry the diagnosis:

**Where the window went**
- \`spend.perMonthUsd\`, \`spend.totalUsd\`, \`window.days\` — the size of the bill and the
  window it was measured over.
- \`spend.byModel[]\` — \`{model, share}\`. Share of spend, not of turns.
- \`spend.commandShare\` / \`subagentShare\` / \`nonCommandShare\` — slash commands vs
  spawned subagents vs plain conversation.

**Avoidable carry — usually the biggest single lever**
- \`contextHygiene.avoidableTotalUsdPerMonth\` — the headline: spend that context
  discipline would have avoided. Split into \`avoidableCompactUsdPerMonth\` (ran to the
  wall instead of compacting) and \`avoidableClearUsdPerMonth\` (switched tasks dragging
  finished context).
- \`contextHygiene.autoCompactions\`, \`sessionsRunToWall\`, \`overdueEpisodes\`,
  \`staleCarrySwitches\` — the counts behind it.
- \`fluency.carryShare\` / \`carryUsd\` — how much of every turn was re-sent history.
- \`fluency.redundantReadRate\` — files read again that were already in context.

**Standing overhead — paid on every single turn**
- \`alwaysOn.standingContextTokens\`, \`alwaysOnConfigTokensPerTurn\`,
  \`alwaysOnConfigMonthlyUsd\`.
- \`alwaysOn.globalClaudeMdTokens\` / \`projectClaudeMdTokens\` — the CLAUDE.md tax.
- \`alwaysOn.skillCount\`, \`skillDescriptionTokens\`, \`pluginCount\`,
  \`unusedPluginCount\`, \`pluginListingTokens\`, \`mcpServerCount\`, \`mcpDeferred\`,
  \`mcpInvokedRate\` — installed surface that costs tokens whether or not it is used.
- \`alwaysOn.spawnsPerMonth\`, \`spawnPrefixTokens\`, \`spawnTaxMonthlyUsd\` — subagent
  respawn overhead.
- \`roiLedger.deadWeightSkillCount\`, \`deadWeightSkillCarryUsdPerMonth\`,
  \`deadWeightMcpCount\` — installed and never invoked.

**How they drive it**
- \`fluency.planModeRate\`, \`medianTurnsPerTask\`, \`p90TurnsPerTask\`,
  \`premiumTurnShare\`, \`modelDiversity\`, \`subagentUsageRate\`, \`score\`.
- \`commands[]\` — per slash command: \`perMonthUsd\`, \`invocationsPerMonth\`,
  \`turnsPerInvocation\`, \`topModel\`, \`contextTaxRatio\`, and the flags
  \`forkCandidate\` / \`modelPinCandidate\` / \`contextHeavy\`.
- \`friction.bySkill[]\` — \`toolErrors\`, \`selfCorrections\`, \`retryLoops\`,
  \`frictionRate\`. Skill names here are **hashed**; refer to them by rank ("their
  highest-friction skill"), never by the hash string.

**Sanity check before you claim anything**
- \`dataQuality.unpricedShare\` — if a meaningful share of spend is unpriced, say so and
  soften the dollar claims. Do not quietly present a partial bill as a complete one.
- \`fluency.sessions\` — a handful of sessions cannot support a confident habit claim.

## 3. Check what you told them last time

Before writing anything new, look for prior runs. Two directories, both optional:

\`\`\`bash
ls ~/.cc-audit/history/ ~/.cc-audit/history/advice/ 2>/dev/null
\`\`\`

- \`history/<YYYY-MM-DD>-<window>.json\` — a **full aggregate** from that day. Every field
  in section 2 is in there, so you can compare any number, not just a preset few.
- \`history/advice/<YYYY-MM-DD>-<window>.json\` — \`{generatedAt, agent, raw, plans,
  closing}\`: the plans that were actually given. \`plans\` may be \`null\` when the parse
  failed; \`raw\` is always the full text, so read \`raw\` when \`plans\` is null.

**Only compare files with the same \`<window>\` key.** A \`w30\` run and an \`all\` run cover
different spans; diffing across them produces a number that means nothing.

If there IS prior advice, open this analysis with follow-through, before the new plans:

- For each prior plan, name the field it targeted and quote **prev → cur**. Say whether
  it moved in the intended direction, moved against it, or didn't move.
- **Do not claim credit.** A number moving is not proof the advice caused it — a quiet
  week, a finished project, or a different task mix moves these too. Write "avoidable
  carry is down $31/mo since 07-21, when the plan was to \`/clear\` between tasks" and
  stop. Do not write "your fix saved you $31/mo." You cannot separate the two, and
  pretending otherwise is the one thing that would make this section worthless.
- **A plan they clearly ignored is the most useful thing you can report.** If the field
  is flat and the same plan is about to be repeated, say so plainly and ask what got in
  the way — then consider whether a *different, smaller* change would actually get done.
  Repeating an identical plan verbatim, week after week, is a failure of coaching.
- Two or more prior entries ⇒ describe the trend, not just the last hop.

If there is no prior advice, say nothing about history at all. Do not announce its
absence, and never invent a comparison — this is a first run, and that is normal.

## 4. Look at their actual repo

Before writing the plans, spend a few tool calls grounding them:

- Read the CLAUDE.md files the token counts refer to. A 4k-token CLAUDE.md is a number;
  *"section 3 restates what the code already makes obvious"* is a fix.
- If \`unusedPluginCount\` or \`deadWeightSkillCount\` is non-zero, look at what is
  actually installed in \`~/.claude/\` and name the specific dead weight.
- If a command is \`contextHeavy\` or a \`forkCandidate\`, open it and say what in it
  drags context.

This is the step that makes the output worth more than the CLI's own report. Do not skip
it.

## 5. Write exactly three plans

Three. Not two, not seven. Ranked by measured impact, biggest first.

Each plan gets:

1. **A one-line name** — the habit or setting that changes.
2. **The evidence** — the specific field and value from the record, quoted as a number.
   "\`contextHygiene.avoidableTotalUsdPerMonth\` is $41/mo across 12 run-to-the-wall
   sessions", not "you have some context waste".
3. **The change** — concrete enough to do today. A file to edit and what to cut from it;
   a command to pin to a cheaper model; a point in a session where \`/clear\` belongs.
4. **What it is worth** — the recovered dollars or window, from the record. If the record
   does not support a number, say "not quantified" rather than inventing one.
5. **How they will know it worked** — the field that should move, and which direction.

Then one closing line: the single thing to change in their **next** session.

## Rules

- **Never invent a number.** Every figure comes from the record or from a file you read.
  If it is not there, say it is not measured.
- **Never fabricate a comparison.** No percentiles, no "most developers", no "top 10%" —
  this record contains no population data.
- **Window and context are different things.** The rate-limit window is what they run out
  of on a Thursday. The context window is what compaction is about. Say which one you
  mean; conflating them makes the advice wrong.
- **This is a solo picture.** No team standards, no org benchmarks, no manager framing.
  There is no PR, cycle-time, or DORA data in this record — do not reference any.
- **Read-only.** Analyze and recommend. Do not edit their config, delete skills, or
  change settings as part of this — propose the diff and let them apply it.
- **Lead with the biggest lever, not the most interesting one.** Context hygiene is
  usually it. Model right-sizing is usually smaller than it looks.
`;

export function skillDir(): string {
  return join(homedir(), '.claude', 'skills', 'cc-audit');
}

export function skillPath(): string {
  return join(skillDir(), 'SKILL.md');
}

/** Version of the installed skill, or null when absent/unreadable/unversioned. */
export function installedSkillVersion(): number | null {
  try {
    const text = readFileSync(skillPath(), 'utf8');
    const m = text.match(new RegExp(`${VERSION_MARKER}\\s*(\\d+)`));
    return m ? Number.parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

/** True when the skill is present AND current — i.e. there is nothing to offer. */
export function isSkillCurrent(): boolean {
  return installedSkillVersion() === SKILL_VERSION;
}

export type SkillInstallStatus = 'installed' | 'updated' | 'current' | 'replaced-foreign' | 'failed';

export interface SkillInstallResult {
  status: SkillInstallStatus;
  path: string;
  message: string;
  /** Where the pre-existing file was preserved, when we found one that wasn't ours. */
  backupPath?: string;
}

/** Is there a file here already? Distinguishes "nothing installed" from "something we
 *  didn't write" — both report a null version, but only one of them is destructible. */
function skillFileExists(): boolean {
  try {
    readFileSync(skillPath(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the skill to ~/.claude/skills/cc-audit/SKILL.md. Idempotent; never throws.
 *
 * A file already at that path with NO version marker is not ours — a hand-written skill,
 * or a pre-versioning install. We back it up to `SKILL.md.bak` before writing and say so,
 * rather than silently destroying work someone did. This mirrors statuslineInstall.ts,
 * which backs settings.json up before patching and never clobbers a foreign value.
 * (An older version of OUR marker is just ours, and gets overwritten with no fuss.)
 */
export function installSkill(): SkillInstallResult {
  const path = skillPath();
  const prior = installedSkillVersion();
  if (prior === SKILL_VERSION) {
    return { status: 'current', path, message: `Analysis skill already installed at ${path}` };
  }

  // null version + a file present ⇒ foreign content. Preserve it.
  const foreign = prior === null && skillFileExists();
  let backupPath: string | undefined;
  if (foreign) {
    backupPath = `${path}.bak`;
    try {
      copyFileSync(path, backupPath);
    } catch (err) {
      // Could not preserve it ⇒ do NOT overwrite. Losing their file is worse than
      // this run not installing the skill.
      return {
        status: 'failed',
        path,
        message:
          `${path} already exists and isn't ours, and it could not be backed up ` +
          `(${err instanceof Error ? err.message : String(err)}). Left it untouched.`,
      };
    }
  }

  try {
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(path, SKILL_MARKDOWN);
  } catch (err) {
    return {
      status: 'failed',
      path,
      message: `Could not write the analysis skill to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (foreign) {
    return {
      status: 'replaced-foreign',
      path,
      backupPath,
      message: `Analysis skill installed at ${path}\n  Your previous SKILL.md was not ours — preserved at ${backupPath}`,
    };
  }
  return {
    status: prior === null ? 'installed' : 'updated',
    path,
    message: prior === null ? `Analysis skill installed at ${path}` : `Analysis skill updated at ${path}`,
  };
}

/** What to paste into an agent session to run the analysis. */
export function invocationHint(): string {
  return [
    'To run the analysis, ask your agent in any Claude Code session:',
    '',
    '    run the cc-audit skill',
    '',
    'It reads your repo alongside the numbers, so the three plans it writes are about',
    'the code you are actually working on. Everything runs on your own subscription —',
    'cc-audit never sends your sessions to a model of ours.',
  ].join('\n');
}
