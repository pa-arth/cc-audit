import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAnalysisPrompt,
  compactFindings,
  detectAgent,
  estimateTokens,
  runAgentAnalysis,
} from '../agentRun.js';

/** An aggregate whose list sections all exceed their caps, so truncation must engage. */
function fixture() {
  const rows = (n: number, key: string) =>
    Array.from({ length: n }, (_, i) => ({ name: `row-${i}`, [key]: n - i }));
  return {
    window: { days: 30 },
    spend: { perMonthUsd: 100, byModel: [{ model: 'claude-opus-5', share: 1 }] },
    fluency: { sessions: 40, carryShare: 0.8 },
    alwaysOn: { standingContextTokens: 9000 },
    contextHygiene: { avoidableTotalUsdPerMonth: 41 },
    conditionalContext: { refCount: 2 },
    roiLedger: { deadWeightSkillCount: 1 },
    dataQuality: { unpricedShare: 0 },
    commands: rows(30, 'perMonthUsd'),
    subagents: rows(20, 'perMonthUsd'),
    modelInvokedSkills: rows(25, 'spanUsdUpperBound'),
    topSessions: rows(50, 'costShare'),
    temporal: { hourHistogram: rows(24, 'turns'), thinkMs: 5 },
    friction: { totalToolErrors: 9, totalSelfCorrections: 3, totalRetryLoops: 1, bySkill: rows(32, 'frictionRate') },
  } as unknown as Record<string, unknown>;
}

describe('compactFindings', () => {
  it('caps every long-tail list', () => {
    const f = compactFindings(fixture());
    expect(f.commands).toHaveLength(8);
    expect(f.subagents).toHaveLength(6);
    expect(f.modelInvokedSkills).toHaveLength(6);
    expect((f.friction as { bySkill: unknown[] }).bySkill).toHaveLength(5);
  });

  it('keeps the highest-ranked rows, not the first ones', () => {
    const f = compactFindings(fixture());
    const kept = f.commands as Array<{ perMonthUsd: number }>;
    expect(kept[0]!.perMonthUsd).toBe(30);
    expect(kept.map((r) => r.perMonthUsd)).toEqual([30, 29, 28, 27, 26, 25, 24, 23]);
  });

  it('DECLARES every cut — a silent top-N would read as "we saw everything"', () => {
    const f = compactFindings(fixture());
    expect(f.truncated).toEqual([
      { field: 'commands', kept: 8, of: 30 },
      { field: 'subagents', kept: 6, of: 20 },
      { field: 'modelInvokedSkills', kept: 6, of: 25 },
      { field: 'friction.bySkill', kept: 5, of: 32 },
    ]);
  });

  it('declares nothing when nothing was cut', () => {
    const small = { ...fixture(), commands: [], subagents: [], modelInvokedSkills: [], friction: { bySkill: [] } };
    expect(compactFindings(small).truncated).toEqual([]);
  });

  it('keeps the scalar diagnosis blocks whole', () => {
    const f = compactFindings(fixture());
    expect(f.contextHygiene).toEqual({ avoidableTotalUsdPerMonth: 41 });
    expect(f.dataQuality).toEqual({ unpricedShare: 0 });
    expect(f.spend).toEqual({ perMonthUsd: 100, byModel: [{ model: 'claude-opus-5', share: 1 }] });
  });

  it('drops the sections coaching never cites, and says so in the note', () => {
    const f = compactFindings(fixture());
    expect(f.topSessions).toBeUndefined();
    expect(f.temporal).toBeUndefined();
    expect(f.note).toMatch(/omitted entirely/);
  });

  it('survives an aggregate missing sections rather than throwing', () => {
    expect(() => compactFindings({})).not.toThrow();
    expect(compactFindings({}).commands).toEqual([]);
  });

  it('materially shrinks the payload — the point of the exercise', () => {
    const full = JSON.stringify(fixture()).length;
    const compact = JSON.stringify(compactFindings(fixture())).length;
    expect(compact).toBeLessThan(full / 2);
  });
});

describe('buildAnalysisPrompt', () => {
  const prompt = buildAnalysisPrompt(compactFindings(fixture()));

  it('asks for exactly three plans and inlines the data', () => {
    expect(prompt).toContain('exactly three');
    expect(prompt).toContain('"avoidableTotalUsdPerMonth": 41');
  });

  it('carries the honesty rules that keep the output trustworthy', () => {
    expect(prompt).toContain('Never invent a number');
    expect(prompt).toContain('Never fabricate a comparison');
    expect(prompt).toContain('dataQuality.unpricedShare');
    expect(prompt).toContain('Respect `truncated`');
  });

  it('tells the model it has no repo, so it cannot pretend to cite their files', () => {
    expect(prompt).toContain('WITHOUT their repo loaded');
    expect(prompt).toContain('Do not pretend you can');
  });

  it('asks for no tools — the read-only posture is structural, not a promise', () => {
    expect(prompt).toContain('Use no tools');
  });

  it('estimates tokens conservatively (never understates the window cost)', () => {
    // 3.5 chars/token is below the ~4 typical for prose, so the estimate runs high.
    expect(estimateTokens(prompt)).toBeGreaterThan(prompt.length / 4);
  });
});

describe('detectAgent', () => {
  const path0 = process.env.PATH;
  let dir: string;

  const fakeBin = (name: string, body = '#!/bin/sh\nexit 0\n') => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-audit-agent-'));
  });
  afterAll(() => {
    process.env.PATH = path0;
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(join(dir, 'claude'), { force: true });
    rmSync(join(dir, 'codex'), { force: true });
  });

  it('returns null when neither agent is installed', () => {
    process.env.PATH = dir;
    expect(detectAgent()).toBeNull();
  });

  it('resolves claude DETERMINISTICALLY when both are present', () => {
    process.env.PATH = dir;
    fakeBin('claude');
    fakeBin('codex');
    expect(detectAgent()?.bin).toBe('claude');
  });

  it('falls through to codex when claude is absent', () => {
    process.env.PATH = dir;
    fakeBin('codex');
    expect(detectAgent()?.bin).toBe('codex');
  });
});

describe('runAgentAnalysis', () => {
  let dir: string;

  const fakeBin = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-audit-run-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the agent stdout on success, ignoring transcript chatter on stderr', async () => {
    const path = fakeBin('ok', '#!/bin/sh\necho "chatter" >&2\necho "three plans here"\n');
    const r = await runAgentAnalysis({ bin: 'claude', path }, 'prompt');
    expect(r).toMatchObject({ ok: true, text: 'three plans here', bin: 'claude' });
  });

  it('reports a non-zero exit as a NAMED failure rather than throwing', async () => {
    const path = fakeBin('boom', '#!/bin/sh\necho "not logged in" >&2\nexit 1\n');
    const r = await runAgentAnalysis({ bin: 'claude', path }, 'prompt');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('claude failed');
    expect(r.error).toContain('not logged in');
  });

  it('treats empty output as a failure — an empty section must not read as a complete one', async () => {
    const path = fakeBin('silent', '#!/bin/sh\nexit 0\n');
    const r = await runAgentAnalysis({ bin: 'codex', path }, 'prompt');
    expect(r).toMatchObject({ ok: false, error: 'codex returned nothing' });
  });

  it('never throws, even when the binary does not exist', async () => {
    const r = await runAgentAnalysis({ bin: 'claude', path: join(dir, 'nope') }, 'prompt');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});
