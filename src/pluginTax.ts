// Plugin standing-context tax. Installed Claude Code plugins bundle skills, slash
// commands, and subagents whose name+description listings load into context every turn
// — the same per-turn cost as a user skill, but previously invisible to the always-on
// tax (which only counted ~/.claude/skills). This module enumerates ENABLED plugins from
// local config, tokenizes their bundled listings, and cross-references real usage so we
// can flag plugins that cost context every turn but were never invoked in the window.
//
// All local, Tier-0: reads ~/.claude/settings.json + ~/.claude/plugins/* on disk. No
// network. We count only ENABLED plugins (disabled ones carry no context). We do NOT use
// the ephemeral `<installPath>/.in_use/<PID>` markers — those are running-session locks,
// not usage history; usage is measured from the transcripts (invokedSkills/commands/tools).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { countTokens } from './configFiles.js';
import { skillListingTokens } from './alwaysOn.js';
import type { Session } from './model.js';

/** One installed+enabled plugin's standing cost and usage status. LOCAL detail — the
 *  name never enters the aggregate (same privacy bar as skills). */
export interface PluginInfo {
  name: string;
  marketplace: string;
  skillTokens: number;
  commandTokens: number;
  agentTokens: number;
  /** skill + command + agent listing tokens — what this plugin adds to every turn. */
  listingTokens: number;
  /** Was any bundled skill/command/agent (or a matching MCP tool) seen in usage. */
  invoked: boolean;
}

export interface PluginTax {
  plugins: PluginInfo[];
  pluginSkillTokens: number;
  pluginCommandTokens: number;
  pluginAgentTokens: number;
  /** Grand total folded into the per-turn always-on config tax. */
  pluginListingTokens: number;
  /** Enabled plugins counted. */
  pluginCount: number;
  /** Enabled but never invoked in the window — removal candidates. */
  unusedCount: number;
}

const EMPTY: PluginTax = {
  plugins: [],
  pluginSkillTokens: 0,
  pluginCommandTokens: 0,
  pluginAgentTokens: 0,
  pluginListingTokens: 0,
  pluginCount: 0,
  unusedCount: 0,
};

interface InstallEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  lastUpdated?: string;
}

/** `name: description` tokens for every flat `*.md` (commands, agents) directly under a
 *  dir. Commands have no `name:` key (name = filename); agents may declare one. Mirrors
 *  skillListingTokens but for the flat-file shape. Returns the listing names too. */
function flatListingTokens(dir: string): { tokens: number; names: string[] } {
  let tokens = 0;
  const names: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { tokens: 0, names: [] };
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.replace(/\.md$/, '');
    let txt;
    try {
      txt = readFileSync(join(dir, e.name), 'utf8');
    } catch {
      continue;
    }
    const name = /^name:\s*(.+)$/m.exec(txt)?.[1]?.trim() ?? slug;
    const desc = /^description:\s*(.+)$/m.exec(txt)?.[1] ?? '';
    tokens += countTokens(`${name}: ${desc}`);
    names.push(name, slug);
  }
  return { tokens, names };
}

/** The set of identifiers we saw invoked across the window — normalized to bare names so
 *  a `plugin:skill` namespaced invocation matches a plugin's bare asset name. Skills,
 *  slash commands, and tool names (incl. `mcp__server__tool`) all land here. */
function usageIndex(sessions: Session[]): { ids: Set<string>; mcpTools: string[] } {
  const ids = new Set<string>();
  const mcpTools: string[] = [];
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    ids.add(raw);
    const bare = raw.includes(':') ? raw.split(':').pop()! : raw;
    if (bare) ids.add(bare);
  };
  for (const s of sessions) {
    for (const span of s.spans) {
      add(span.command);
      for (const sk of span.invokedSkills) add(sk);
      for (const t of span.turns) {
        for (const tool of t.tools) {
          if (tool.startsWith('mcp__')) mcpTools.push(tool);
        }
      }
    }
  }
  return { ids, mcpTools };
}

export function computePluginTax(sessions: Session[]): PluginTax {
  const claudeDir = join(homedir(), '.claude');

  let enabled: Record<string, boolean> = {};
  try {
    enabled =
      (JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as { enabledPlugins?: Record<string, boolean> })
        .enabledPlugins ?? {};
  } catch {
    return EMPTY;
  }

  let installed: Record<string, InstallEntry[]> = {};
  try {
    installed =
      (JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')) as {
        plugins?: Record<string, InstallEntry[]>;
      }).plugins ?? {};
  } catch {
    return EMPTY;
  }

  const { ids, mcpTools } = usageIndex(sessions);
  const plugins: PluginInfo[] = [];

  for (const [key, on] of Object.entries(enabled)) {
    if (!on) continue; // disabled ⇒ no standing context cost
    const entries = installed[key];
    if (!entries || entries.length === 0) continue;
    // Most-recently-updated install wins when a plugin is installed at multiple scopes.
    const entry = [...entries].sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''))[0]!;
    const installPath = entry.installPath;
    if (!installPath || !existsSync(installPath)) continue; // stale/removed on disk

    const at = key.lastIndexOf('@');
    const name = at >= 0 ? key.slice(0, at) : key;
    const marketplace = at >= 0 ? key.slice(at + 1) : '';

    const skills = skillListingTokens(join(installPath, 'skills'));
    const commands = flatListingTokens(join(installPath, 'commands'));
    const agents = flatListingTokens(join(installPath, 'agents'));

    // Identifiers that count as "this plugin was used": every bundled asset name plus the
    // plugin's own name (a single-skill plugin is invoked under its plugin name).
    const assetNames = [name, ...skills.names, ...commands.names, ...agents.names];
    const invoked =
      assetNames.some((n) => ids.has(n)) ||
      // Best-effort MCP match: a bundled MCP server's tools carry the plugin name. Loose
      // by design — current plugins ship no MCP, so this is a forward-looking guard.
      mcpTools.some((t) => t.toLowerCase().includes(name.toLowerCase()));

    plugins.push({
      name,
      marketplace,
      skillTokens: skills.tokens,
      commandTokens: commands.tokens,
      agentTokens: agents.tokens,
      listingTokens: skills.tokens + commands.tokens + agents.tokens,
      invoked,
    });
  }

  return {
    plugins,
    pluginSkillTokens: plugins.reduce((n, p) => n + p.skillTokens, 0),
    pluginCommandTokens: plugins.reduce((n, p) => n + p.commandTokens, 0),
    pluginAgentTokens: plugins.reduce((n, p) => n + p.agentTokens, 0),
    pluginListingTokens: plugins.reduce((n, p) => n + p.listingTokens, 0),
    pluginCount: plugins.length,
    unusedCount: plugins.filter((p) => !p.invoked).length,
  };
}
