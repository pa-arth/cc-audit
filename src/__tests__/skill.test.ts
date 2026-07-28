import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

  it('ships complete text — readable with no network, which is the whole reason it is embedded', () => {
    expect(SKILL_MARKDOWN.startsWith('---\nname: cc-audit\n')).toBe(true);
    expect(SKILL_MARKDOWN).toContain('cc-audit --json');
    expect(SKILL_MARKDOWN).toMatch(/cc-audit-skill-version:\s*\d+/);
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
