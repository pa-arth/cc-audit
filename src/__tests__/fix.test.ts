import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { frontmatterModelPatch, renderFix, runFix, type FixProposal } from '../fix.js';
import { checkSpendCap, recordSpend } from '../fixClient.js';
import type { Recommendation } from '../recommend.js';

describe('frontmatterModelPatch', () => {
  it('inserts a model pin into the frontmatter', () => {
    const src = '---\nname: myskill\ndescription: does a thing\n---\n\nBody here.\n';
    const out = frontmatterModelPatch(src, 'sonnet')!;
    expect(out).not.toBeNull();
    expect(out).toMatch(/^---\nmodel: sonnet\n/);
    // Body and other frontmatter are preserved.
    expect(out).toContain('name: myskill');
    expect(out).toContain('Body here.');
  });

  it('returns null when a model is already pinned (nothing to do)', () => {
    const src = '---\nname: x\nmodel: sonnet\n---\nbody\n';
    expect(frontmatterModelPatch(src)).toBeNull();
  });

  it('returns null when there is no frontmatter fence (does not guess)', () => {
    expect(frontmatterModelPatch('no frontmatter here\njust text\n')).toBeNull();
  });
});

describe('runFix (model-pin branch — local, no network)', () => {
  const cwd0 = process.cwd();
  let work: string;
  let skillFile: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'cc-audit-fix-'));
    process.chdir(work); // proposals are written to ./.cc-audit relative to cwd
    skillFile = join(work, 'SKILL.md');
    writeFileSync(skillFile, '---\nname: myskill\ndescription: x\n---\nbody\n');
  });
  afterAll(() => {
    process.chdir(cwd0);
    rmSync(work, { recursive: true, force: true });
  });

  it('writes a reviewable proposal and never touches the real file', async () => {
    const before = readFileSync(skillFile, 'utf8');
    const rec: Recommendation = {
      kind: 'model-pin',
      title: '`myskill` runs opus-4-8 with no model pin',
      monthlyUsdSaved: 9,
      file: skillFile,
      action: 'Add `model: sonnet`',
    };
    const proposals = await runFix([rec], '2026-06-18');
    expect(proposals).toHaveLength(1);
    expect(readFileSync(skillFile, 'utf8')).toBe(before); // real file untouched
    expect(existsSync(proposals[0]!.proposalFile)).toBe(true);
    expect(readFileSync(proposals[0]!.proposalFile, 'utf8')).toMatch(/^---\nmodel: sonnet\n/);
  });
});

describe('spend-cap accounting (no lockout on transient failure)', () => {
  const home0 = process.env.HOME;
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-cap-'));
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX → isolates the cap file
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });

  it('checkSpendCap never consumes a slot — repeated failures do not lock the user out', () => {
    // 50 checks with no record (simulating 50 transient POST failures) stay allowed.
    for (let i = 0; i < 50; i++) expect(() => checkSpendCap('2026-06-19-a', 3)).not.toThrow();
  });

  it('only recordSpend consumes slots, and the cap then blocks', () => {
    const day = '2026-06-19-b'; // distinct day key ⇒ fresh count
    expect(() => checkSpendCap(day, 3)).not.toThrow();
    recordSpend(day, 3);
    recordSpend(day, 3);
    recordSpend(day, 3);
    expect(() => checkSpendCap(day, 3)).toThrow(/cap reached/);
  });
});

describe('renderFix', () => {
  it('explains when there are no patches', () => {
    expect(renderFix([])).toContain('no reviewable patches');
  });

  it('lists each patch with savings, the proposal path, and a safety caution', () => {
    const proposals: FixProposal[] = [
      {
        kind: 'model-pin',
        title: '`myskill` runs opus-4-8 with no model pin',
        realFile: '/p/.claude/skills/myskill/SKILL.md',
        proposalFile: '.cc-audit/myskill__SKILL.md.proposed',
        monthlyUsdSaved: 12.5,
        safe: true,
        caution: null,
        summary: '+ model: sonnet  (frontmatter)',
      },
      {
        kind: 'config-trim',
        title: 'Project CLAUDE.md trim',
        realFile: '/p/CLAUDE.md',
        proposalFile: '.cc-audit/p__CLAUDE.md.proposed',
        monthlyUsdSaved: 6,
        safe: false,
        caution: 'may drop: NEVER push to main',
        summary: '4,751 → 2,100 tok',
      },
    ];
    const out = renderFix(proposals);
    expect(out).toContain('~$12.50/mo');
    expect(out).toContain('git diff --no-index /p/.claude/skills/myskill/SKILL.md .cc-audit/myskill__SKILL.md.proposed');
    expect(out).toContain('⚠ SAFETY: may drop: NEVER push to main');
  });
});
