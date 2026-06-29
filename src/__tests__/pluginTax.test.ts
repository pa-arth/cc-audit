import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computePluginTax } from '../pluginTax.js';
import type { Session, Span } from '../model.js';

// pluginTax reads ~/.claude/settings.json + ~/.claude/plugins/installed_plugins.json.
// os.homedir() reads $HOME on POSIX, so pointing HOME at a tmpdir fully isolates it
// (mirrors consent.test.ts / updateCheck.test.ts).

/** Minimal session carrying just the usage signals computePluginTax inspects. */
function session(opts: { command?: string; invokedSkills?: string[]; tools?: string[] }): Session {
  const span: Span = {
    promptId: 'p',
    command: opts.command ?? null,
    invokedSkills: opts.invokedSkills ?? [],
    firstUserText: '',
    turns: [
      {
        model: 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        tools: opts.tools ?? [],
        reads: [],
        thinkingChars: 0,
        textChars: 0,
      },
    ],
    isSidechain: false,
    autoCompacted: false,
    attributionSkill: null,
    attributionAgent: null,
  };
  return { sessionId: 's', project: 'proj', cwd: null, mtime: 1, modes: [], spans: [span] };
}

describe('computePluginTax', () => {
  const home0 = process.env.HOME;
  let home: string;

  /** Scaffold a plugin install dir with the given skill/command slugs. */
  function installPlugin(slug: string, opts: { skills?: string[]; commands?: string[] } = {}): string {
    const base = join(home, '.claude', 'plugins', 'cache', slug);
    for (const s of opts.skills ?? []) {
      mkdirSync(join(base, 'skills', s), { recursive: true });
      writeFileSync(join(base, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: does ${s} things\n---\nbody`);
    }
    for (const cmd of opts.commands ?? []) {
      mkdirSync(join(base, 'commands'), { recursive: true });
      writeFileSync(join(base, 'commands', `${cmd}.md`), `---\ndescription: runs ${cmd}\n---\nbody`);
    }
    mkdirSync(base, { recursive: true });
    return base;
  }

  function writeConfig(enabledPlugins: Record<string, boolean>, plugins: Record<string, { installPath: string }[]>): void {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  }

  beforeAll(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'cc-audit-plugin-'));
  });
  beforeEach(() => {
    // Fresh home per test so configs don't bleed across cases.
    home = mkdtempSync(join(tmpdir(), 'cc-audit-plugin-'));
    process.env.HOME = home;
  });
  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    process.env.HOME = home0;
  });

  it('returns all-zero when no plugin config exists', () => {
    const tax = computePluginTax([]);
    expect(tax).toMatchObject({ pluginCount: 0, pluginListingTokens: 0, unusedCount: 0, plugins: [] });
  });

  it('counts enabled plugins and excludes disabled ones', () => {
    const onPath = installPlugin('on', { skills: ['alpha'], commands: ['run'] });
    const offPath = installPlugin('off', { skills: ['beta'] });
    writeConfig(
      { 'on@mk': true, 'off@mk': false },
      { 'on@mk': [{ installPath: onPath }], 'off@mk': [{ installPath: offPath }] },
    );
    const tax = computePluginTax([]);
    expect(tax.pluginCount).toBe(1);
    expect(tax.plugins.map((p) => p.name)).toEqual(['on']);
    expect(tax.pluginSkillTokens).toBeGreaterThan(0);
    expect(tax.pluginCommandTokens).toBeGreaterThan(0);
    expect(tax.pluginListingTokens).toBe(tax.pluginSkillTokens + tax.pluginCommandTokens + tax.pluginAgentTokens);
  });

  it('flags an enabled plugin as unused when none of its assets were invoked', () => {
    const path = installPlugin('lonely', { skills: ['never-run'] });
    writeConfig({ 'lonely@mk': true }, { 'lonely@mk': [{ installPath: path }] });
    const tax = computePluginTax([session({ invokedSkills: ['something-else'] })]);
    expect(tax.unusedCount).toBe(1);
    expect(tax.plugins[0]!.invoked).toBe(false);
  });

  it('marks a plugin invoked when its skill is used, including the plugin:skill namespaced form', () => {
    const path = installPlugin('used', { skills: ['the-skill'] });
    writeConfig({ 'used@mk': true }, { 'used@mk': [{ installPath: path }] });
    // CC logs plugin skill invocations namespaced as `plugin:skill`.
    const tax = computePluginTax([session({ invokedSkills: ['used:the-skill'] })]);
    expect(tax.plugins[0]!.invoked).toBe(true);
    expect(tax.unusedCount).toBe(0);
  });

  it('marks a plugin invoked when the model used it under the plugin name', () => {
    const path = installPlugin('soloskill', { skills: ['soloskill'] });
    writeConfig({ 'soloskill@mk': true }, { 'soloskill@mk': [{ installPath: path }] });
    const tax = computePluginTax([session({ invokedSkills: ['soloskill'] })]);
    expect(tax.plugins[0]!.invoked).toBe(true);
  });

  it('does NOT mark a plugin invoked when an unrelated bare command shares a bundled asset slug', () => {
    // Plugin `tools` bundles a generically-named `review` skill the user never ran. The
    // user did run the built-in `/review` (logged bare as `review`). A bare asset-slug
    // match would wrongly flag the plugin as used and hide it from the unused list.
    const path = installPlugin('tools', { skills: ['review'] });
    writeConfig({ 'tools@mk': true }, { 'tools@mk': [{ installPath: path }] });
    const tax = computePluginTax([session({ command: 'review' })]);
    expect(tax.plugins[0]!.invoked).toBe(false);
    expect(tax.unusedCount).toBe(1);
  });

  it('skips a stale install whose installPath no longer exists, without throwing', () => {
    writeConfig({ 'ghost@mk': true }, { 'ghost@mk': [{ installPath: join(home, 'does', 'not', 'exist') }] });
    expect(() => computePluginTax([])).not.toThrow();
    expect(computePluginTax([]).pluginCount).toBe(0);
  });
});
