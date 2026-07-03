import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  buildModelPinProposals,
  frontmatterModelPatch,
  isHostedTrimCandidate,
  renderFix,
  runFix,
  type FixProposal,
} from '../fix.js';
import { checkSpendCap, recordSpend, requestConfigRewrite, spendToday } from '../fixClient.js';
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

  it('buildModelPinProposals is the same local path (patch written, real file untouched)', () => {
    const before = readFileSync(skillFile, 'utf8');
    const proposals = buildModelPinProposals([
      { kind: 'model-pin', title: 'pin', monthlyUsdSaved: 1, file: skillFile, action: 'pin' },
      { kind: 'trim-config', title: 'not a pin', monthlyUsdSaved: 1, file: skillFile, action: 'x' },
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe('model-pin');
    expect(readFileSync(skillFile, 'utf8')).toBe(before);
    expect(existsSync(proposals[0]!.proposalFile)).toBe(true);
  });

  it('gates the hosted rewrite to real CLAUDE.md files — a SKILL.md trim rec must never egress', () => {
    const claudeMd = join(work, 'CLAUDE.md');
    writeFileSync(claudeMd, 'standing guidance\n');
    const trim = (file: string | null): Recommendation => ({
      kind: 'trim-config',
      title: 't',
      monthlyUsdSaved: 1,
      file,
      action: 'trim',
    });
    expect(isHostedTrimCandidate(trim(claudeMd))).toBe(true);
    // Dead-weight skills and unused plugins are also kind trim-config — a SKILL.md
    // path or no path at all must NOT be sent to the hosted config-review.
    expect(isHostedTrimCandidate(trim(skillFile))).toBe(false);
    expect(isHostedTrimCandidate(trim(null))).toBe(false);
    expect(isHostedTrimCandidate(trim(join(work, 'missing', 'CLAUDE.md')))).toBe(false);
    expect(isHostedTrimCandidate({ kind: 'model-pin', title: 'p', monthlyUsdSaved: 1, file: claudeMd, action: 'a' })).toBe(false);
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
    expect(() => checkSpendCap(day, 3)).toThrow(/backstop reached/);
  });

  it('demoted: the default local check does not block at the old 10/day cap', () => {
    const day = '2026-06-19-c';
    for (let i = 0; i < 12; i++) recordSpend(day); // well past the display cap of 10
    expect(spendToday(day)).toBe(12); // counter keeps climbing toward the backstop
    expect(() => checkSpendCap(day)).not.toThrow(); // default (backstop) still allows it
  });

  it('the loose local backstop (default 50) still blocks a runaway', () => {
    const day = '2026-06-19-d';
    for (let i = 0; i < 50; i++) recordSpend(day);
    expect(spendToday(day)).toBe(50);
    expect(() => checkSpendCap(day)).toThrow(/backstop reached/);
  });
});

describe('requestConfigRewrite egress (X-Install-Key + server cap)', () => {
  const home0 = process.env.HOME;
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-egress-'));
    process.env.HOME = home; // isolate the backstop counter file
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(home, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const files = [{ path: 'CLAUDE.md', content: 'x' }];

  it('sends x-install-key on both the POST and the poll GET', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/v1/public/config-review')) {
          return { ok: true, status: 202, json: async () => ({ sessionId: 's1' }) } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'done', report: { rewrite: null } }),
        } as unknown as Response;
      }),
    );
    vi.useFakeTimers();
    const pending = requestConfigRewrite(files, '2026-06-20-a', 'https://api.test', 'claude_code', 'KEY-123');
    await vi.runAllTimersAsync(); // flush the poll's sleep()
    const result = await pending;
    vi.useRealTimers();

    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    const header = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.['x-install-key'];
    expect(header(calls[0]!.init)).toBe('KEY-123'); // POST
    expect(header(calls[1]!.init)).toBe('KEY-123'); // poll GET
  });

  it('maps a server 429 to a clean "server-enforced" message (no raw status dump)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) as unknown as Response),
    );
    await expect(
      requestConfigRewrite(files, '2026-06-20-b', 'https://api.test', 'claude_code', 'KEY-123'),
    ).rejects.toThrow(/server-enforced/);
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

describe('runFix (context-guardrail branch — local, no network)', () => {
  const cwd0 = process.cwd();
  const home0 = process.env.HOME;
  let work: string;
  let home: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'cc-audit-guardfix-'));
    home = mkdtempSync(join(tmpdir(), 'cc-audit-guardfix-home-'));
    process.chdir(work); // proposals are written to ./.cc-audit relative to cwd
    process.env.HOME = home; // isolates ~/.claude/settings.json reads
  });
  afterAll(() => {
    process.chdir(cwd0);
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const rec = (): Recommendation => ({
    kind: 'context-guardrail',
    title: 'Ran to the context wall 12× — add a live /compact guardrail',
    monthlyUsdSaved: 28,
    file: join(home, '.claude', 'settings.json'),
    action: 'Run `cc-audit fix`.',
  });

  it('emits script + settings proposal even when settings.json does not exist', async () => {
    const proposals = await runFix([rec()], '2026-07-01');
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('context-guardrail');
    expect(p.realFileMissing).toBe(true);
    expect(p.safe).toBe(true);
    expect(existsSync(p.companion!.artifact)).toBe(true);
    expect(readFileSync(p.companion!.artifact, 'utf8')).toContain('WARN_PCT=80');
    expect(p.companion!.installTo).toBe(join(home, '.claude', 'cc-audit-context-guard.sh'));
    const proposed = JSON.parse(readFileSync(p.proposalFile, 'utf8')) as { statusLine: { command: string } };
    expect(proposed.statusLine.command).toBe(p.companion!.installTo);
    // The real settings file was never created — proposals only.
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    const out = renderFix(proposals);
    expect(out).toContain('new file — review');
    expect(out).toContain('chmod +x');
    expect(out).not.toContain('git diff --no-index');
  });

  it('wraps an existing statusLine command and preserves other settings keys', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-hud.sh' }, env: { FOO: '1' } }),
    );
    const proposals = await runFix([rec()], '2026-07-01');
    const p = proposals[0]!;
    expect(p.realFileMissing).toBe(false);
    expect(p.summary).toContain('wraps your existing statusline');
    expect(readFileSync(p.companion!.artifact, 'utf8')).toContain('my-hud.sh');
    const proposed = JSON.parse(readFileSync(p.proposalFile, 'utf8')) as Record<string, unknown>;
    expect(proposed.env).toEqual({ FOO: '1' });
    expect(renderFix(proposals)).toContain('git diff --no-index');
  });

  it('corrupt settings.json → caution proposal, script still emitted', async () => {
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json');
    const proposals = await runFix([rec()], '2026-07-01');
    const p = proposals[0]!;
    expect(p.safe).toBe(false);
    expect(p.caution).toContain('did not parse');
    expect(existsSync(p.companion!.artifact)).toBe(true);
    expect(renderFix(proposals)).toContain('⚠ SAFETY:');
  });
});
