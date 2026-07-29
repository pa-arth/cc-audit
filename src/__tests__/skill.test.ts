import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  installSkill,
  installedSkillVersion,
  invocationHint,
  isSkillCurrent,
  SKILL_MARKDOWN,
  SKILL_VERSION,
  skillDir,
  skillPath,
} from '../skill.js';

describe('analysis skill', () => {
  const home0 = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-skill-'));
    process.env.HOME = home; // isolates ~/.claude/skills
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(join(home, '.claude'), { recursive: true, force: true });
  });

  it('installs to ~/.claude/skills/cc-audit/SKILL.md', () => {
    const r = installSkill();
    expect(r.status).toBe('installed');
    expect(r.path).toBe(join(home, '.claude', 'skills', 'cc-audit', 'SKILL.md'));
    expect(readFileSync(skillPath(), 'utf8')).toBe(SKILL_MARKDOWN);
  });

  it('is idempotent — a second install is a no-op, so the prompt has nothing to offer', () => {
    installSkill();
    expect(installSkill().status).toBe('current');
    expect(isSkillCurrent()).toBe(true);
  });

  it('refreshes a stale install rather than skipping it', () => {
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(skillPath(), '<!-- cc-audit-skill-version: 0 -->\nold text\n');
    expect(installedSkillVersion()).toBe(0);
    expect(isSkillCurrent()).toBe(false);
    expect(installSkill().status).toBe('updated');
    expect(installedSkillVersion()).toBe(SKILL_VERSION);
  });

  it('treats an unversioned or missing file as not-current', () => {
    expect(installedSkillVersion()).toBeNull();
    expect(isSkillCurrent()).toBe(false);
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(skillPath(), 'some hand-written skill with no marker\n');
    expect(installedSkillVersion()).toBeNull();
    expect(isSkillCurrent()).toBe(false);
  });

  it('BACKS UP a hand-written skill instead of destroying it', () => {
    const mine = '# my own cc-audit skill\ndo it my way\n';
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(skillPath(), mine);

    const r = installSkill();
    expect(r.status).toBe('replaced-foreign');
    expect(r.backupPath).toBe(`${skillPath()}.bak`);
    expect(readFileSync(r.backupPath!, 'utf8')).toBe(mine); // their work survives verbatim
    expect(readFileSync(skillPath(), 'utf8')).toBe(SKILL_MARKDOWN);
    expect(r.message).toContain('preserved at');
  });

  it('does not back up when the existing file is OURS — no .bak litter on every upgrade', () => {
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(skillPath(), '<!-- cc-audit-skill-version: 0 -->\nour older text\n');
    const r = installSkill();
    expect(r.status).toBe('updated');
    expect(r.backupPath).toBeUndefined();
    expect(existsSync(`${skillPath()}.bak`)).toBe(false);
  });

  it('describes the --json command truthfully — it writes and may transmit', () => {
    // Regression: the skill used to tell the agent this command "makes no network call,
    // and writes nothing". writeSnapshot() writes, and sendCapture() transmits once the
    // developer has opted in. A false privacy claim injected into an agent's context is
    // worse than no claim, because the agent repeats it to the user as fact.
    expect(SKILL_MARKDOWN).not.toContain('makes no network call');
    expect(SKILL_MARKDOWN).not.toContain('writes nothing');
    expect(SKILL_MARKDOWN).toContain('~/.cc-audit/');
    expect(SKILL_MARKDOWN).toContain('cc-audit capture --status');
    expect(SKILL_MARKDOWN).toMatch(/Transmits.*only if they previously turned on data sharing/s);
  });

  it('ships complete text — readable with no network, which is the whole reason it is embedded', () => {
    expect(SKILL_MARKDOWN.startsWith('---\nname: cc-audit\n')).toBe(true);
    expect(SKILL_MARKDOWN).toContain('cc-audit --json');
    expect(SKILL_MARKDOWN).toMatch(/cc-audit-skill-version:\s*\d+/);
  });

  it('teaches the agent to read prior advice, and to NOT claim credit for movement', () => {
    // The whole point of persisting plans is week-over-week follow-through. Two things
    // make it useful rather than harmful: comparing only within a window key, and
    // refusing to attribute a moved number to the advice. A quiet week moves these too.
    expect(SKILL_MARKDOWN).toContain('Check what you told them last time');
    expect(SKILL_MARKDOWN).toContain('~/.cc-audit/history/advice/');
    expect(SKILL_MARKDOWN).toMatch(/Do not claim credit/);
    expect(SKILL_MARKDOWN).toContain('same `<window>` key');
    expect(SKILL_MARKDOWN).toContain('read `raw` when `plans` is null');
  });

  it('tells the agent to stay SILENT when there is no history, not to announce it', () => {
    expect(SKILL_MARKDOWN).toMatch(/no prior advice, say nothing about history/i);
  });

  it('discloses that advice is written to disk — it is not only the snapshot now', () => {
    // Regression of the same family as the --json claim: writeAdvice() added a second
    // thing this tool puts on disk, and "Nothing else on disk" was true before it.
    expect(SKILL_MARKDOWN).toContain('~/.cc-audit/history/advice/');
    expect(SKILL_MARKDOWN).toMatch(/plans it produced are also\s+kept/);
  });

  it('asks for exactly three plans and forbids invented numbers and fake percentiles', () => {
    expect(SKILL_MARKDOWN).toContain('Write exactly three plans');
    expect(SKILL_MARKDOWN).toContain('Never invent a number');
    expect(SKILL_MARKDOWN).toContain('Never fabricate a comparison');
  });

  it('stays read-only and solo-shaped — no writes, no org framing', () => {
    expect(SKILL_MARKDOWN).toMatch(/\*\*Read-only\.\*\*/);
    expect(SKILL_MARKDOWN).toContain('No team standards, no org benchmarks');
    expect(SKILL_MARKDOWN).toMatch(/DORA/); // named only to exclude it
  });

  it('the invocation hint tells them how to run it and where the compute happens', () => {
    const hint = invocationHint();
    expect(hint).toContain('run the cc-audit skill');
    expect(hint).toContain('your own subscription');
  });
});
