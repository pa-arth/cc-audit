import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { attributeSpend } from '../attribute.js';
import { computeAlwaysOn } from '../alwaysOn.js';
import { computeFluency } from '../fluency.js';
import { buildRecommendations } from '../recommend.js';
import { runAudit } from '../audit.js';
import { AggregateRecordSchema } from '../aggregate.js';

// Golden fixture: two promptId spans with hand-computed cost.
//   Span A — /commit-push-pr, Sonnet: in 1000·$3 + out 500·$15 + cr 10000·$0.3
//     + cw5m 2000·$3.75 = 3000+7500+3000+7500 = 21000 / 1e6 = $0.021
//   Span B — plain prompt, Opus 4.8: in 2000·$5 + out 1000·$25 + cr 20000·$0.5
//     + cw1h 1000·$10 = 10000+25000+10000+10000 = 55000 / 1e6 = $0.055
//   total $0.076 ; command $0.021 ; non-command $0.055
const FIXTURE = [
  {
    type: 'user',
    promptId: 'p1',
    message: { content: '<command-message>commit-push-pr</command-message>\n<command-args></command-args>' },
  },
  {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
      },
      content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'shipping it' }],
    },
  },
  { type: 'user', promptId: 'p2', message: { content: 'can you fix the thing in the dashboard please' } },
  {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
      },
      content: [{ type: 'thinking', thinking: 'x'.repeat(900) }, { type: 'tool_use', name: 'Edit' }],
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

describe('parseTranscript', () => {
  it('splits into promptId spans and detects the slash command', () => {
    const s = parseTranscript('/tmp/fake-abc.jsonl', FIXTURE, 'demo/project')!;
    expect(s).not.toBeNull();
    expect(s.spans).toHaveLength(2);
    expect(s.spans[0]!.command).toBe('commit-push-pr');
    expect(s.spans[0]!.turns).toHaveLength(1);
    expect(s.spans[1]!.command).toBeNull();
    expect(s.spans[1]!.firstUserText).toContain('fix the thing');
    expect(s.spans[1]!.turns[0]!.tools).toContain('Edit');
  });
});

describe('attributeSpend (trust gate)', () => {
  const sessions = [parseTranscript('/tmp/fake-abc.jsonl', FIXTURE, 'demo/project')!];
  const spend = attributeSpend(sessions);

  it('computes total cost to the hand-verified value', () => {
    expect(spend.totalUsd).toBeCloseTo(0.076, 6);
  });

  it('attribution sums to 100% (command + non-command = total)', () => {
    expect(spend.commandTotalUsd + spend.nonCommandUsd).toBeCloseTo(spend.totalUsd, 9);
    expect(spend.commandTotalUsd).toBeCloseTo(0.021, 6);
    expect(spend.nonCommandUsd).toBeCloseTo(0.055, 6);
  });

  it('byModel shares sum to 1 and cover the total', () => {
    const sumCost = spend.byModel.reduce((n, m) => n + m.costUsd, 0);
    const sumShare = spend.byModel.reduce((n, m) => n + m.share, 0);
    expect(sumCost).toBeCloseTo(spend.totalUsd, 9);
    expect(sumShare).toBeCloseTo(1, 9);
  });

  it('builds the leak board with per-command rollups + fix flags', () => {
    const c = spend.commandLeakBoard.find((x) => x.command === 'commit-push-pr')!;
    expect(c.costUsd).toBeCloseTo(0.021, 6);
    expect(c.invocations).toBe(1);
    expect(c.turnsPerInvocation).toBe(1);
    expect(c.topModel).toBe('claude-sonnet-4-6');
    expect(c.modelPinCandidate).toBe(false); // sonnet is not premium
    expect(c.forkCandidate).toBe(false); // 1 turn
  });

  it('flags nothing as unpriced for known models', () => {
    expect(spend.unpricedShare).toBe(0);
  });
});

describe('message-id dedup (trust gate)', () => {
  it('counts a streamed message logged 3x only once', () => {
    const dupEvent = {
      type: 'assistant',
      requestId: 'req_1',
      uuid: 'u1',
      message: {
        id: 'msg_dup',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [],
      },
    };
    const raw = [
      { type: 'user', promptId: 'p1', message: { content: 'do the thing for me please' } },
      dupEvent,
      { ...dupEvent, uuid: 'u2' }, // same message.id, logged again
      { ...dupEvent, uuid: 'u3' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const seen = new Set<string>();
    const s = parseTranscript('/tmp/dup.jsonl', raw, 'p', seen)!;
    // 3 logged rows, 1 distinct message.id ⇒ exactly one counted turn.
    expect(s.spans[0]!.turns).toHaveLength(1);
    const spend = attributeSpend([s]);
    // in 1000·$3 + out 500·$15 = 3000+7500 = 10500/1e6 = $0.0105 (NOT 3x).
    expect(spend.totalUsd).toBeCloseTo(0.0105, 6);
  });
});

// A main-chain prompt that spawns a subagent. The subagent's turns are logged as
// sidechain rows with NO promptId but an explicit attributionSkill — the cost the
// leak board used to lose into "regular sessions".
//   Main span — plain prompt, Sonnet: in 1000·$3 + out 500·$15 = $0.0105
//   Sidechain — deep-research, Opus 4.8: in 2000·$5 + out 1000·$25 = $0.035
const SIDECHAIN_FIXTURE = [
  { type: 'user', promptId: 'p1', message: { content: 'research the best caching strategy for us' } },
  {
    type: 'assistant',
    message: {
      id: 'm1',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', name: 'Task' }],
    },
  },
  {
    type: 'user',
    isSidechain: true,
    agentId: 'agentA',
    attributionSkill: 'deep-research',
    attributionAgent: 'general-purpose',
    message: { content: 'go research caching approaches and report back' },
  },
  {
    type: 'assistant',
    isSidechain: true,
    agentId: 'agentA',
    attributionSkill: 'deep-research',
    attributionAgent: 'general-purpose',
    message: {
      id: 'm2',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'here is what I found' }],
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

describe('subagent / sidechain attribution', () => {
  const session = parseTranscript('/tmp/sc.jsonl', SIDECHAIN_FIXTURE, 'demo/project', new Set())!;

  it('models the subagent as its own sidechain span with attribution', () => {
    expect(session.spans).toHaveLength(2);
    const main = session.spans.find((s) => !s.isSidechain)!;
    const sub = session.spans.find((s) => s.isSidechain)!;
    expect(main.promptId).toBe('p1');
    expect(sub.attributionSkill).toBe('deep-research');
    expect(sub.attributionAgent).toBe('general-purpose');
    expect(sub.turns).toHaveLength(1);
  });

  it('rolls subagent cost onto the skill (not into regular sessions)', () => {
    const spend = attributeSpend([session]);
    // The deep-research subagent cost is on the subagent board, NOT nonCommand.
    const dr = spend.subagentLeakBoard.find((s) => s.name === 'deep-research')!;
    expect(dr.costUsd).toBeCloseTo(0.035, 6);
    expect(dr.isSkill).toBe(true);
    expect(dr.modelPinCandidate).toBe(true); // opus
    expect(spend.subagentTotalUsd).toBeCloseTo(0.035, 6);
    expect(spend.nonCommandUsd).toBeCloseTo(0.0105, 6); // only the main-chain prompt
    expect(spend.commandTotalUsd).toBe(0);
  });

  it('attribution still sums to 100% (command + subagent + nonCommand = total)', () => {
    const spend = attributeSpend([session]);
    expect(spend.commandTotalUsd + spend.subagentTotalUsd + spend.nonCommandUsd).toBeCloseTo(
      spend.totalUsd,
      9,
    );
  });

  it('fluency counts subagent SPEND share and excludes sidechain from premium share', () => {
    const f = computeFluency([session]);
    // subagent cost 0.035 / total 0.0455 ≈ 0.769
    expect(f.subagentUsageRate).toBeCloseTo(0.035 / 0.0455, 4);
    // premium share is MAIN-chain only: the one main turn is Sonnet (not premium) → 0
    expect(f.premiumTurnShare).toBe(0);
  });
});

describe('context-tax + system-command + model-invoked attribution', () => {
  // A context-heavy command (re-passes a huge cached context, tiny output) + a
  // premium system command (/compact) + a model-invoked skill (Skill tool, no slash).
  const FX = [
    { type: 'user', promptId: 'h1', message: { content: '<command-name>commit-push-pr</command-name>' } },
    {
      type: 'assistant',
      message: {
        id: 'h1m',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    },
    { type: 'user', promptId: 's1', message: { content: '<command-name>compact</command-name>' } },
    {
      type: 'assistant',
      message: {
        id: 's1m',
        model: 'claude-opus-4-8', // premium — but server-controlled, so NOT pinnable
        usage: { input_tokens: 100, output_tokens: 5000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
        content: [],
      },
    },
    { type: 'user', promptId: 'm1', message: { content: 'ship this for me' } },
    {
      type: 'assistant',
      message: {
        id: 'm1m',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'commit-push-pr' } }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const spend = attributeSpend([parseTranscript('/tmp/fx.jsonl', FX, 'p', new Set())!]);

  it('flags context-heavy commands and recommends restructure over model-pin', () => {
    const cpr = spend.commandLeakBoard.find((c) => c.command === 'commit-push-pr')!;
    expect(cpr.contextTaxRatio).toBeGreaterThan(120); // (100+500000)/50 ≈ 10002
    expect(cpr.contextHeavy).toBe(true);
  });

  it('never marks a server-controlled system command as model-pinnable', () => {
    const compact = spend.commandLeakBoard.find((c) => c.command === 'compact')!;
    expect(compact.isSystemCommand).toBe(true);
    expect(compact.modelPinCandidate).toBe(false); // opus, but the model isn't the user's to pin
  });

  it('surfaces model-invoked skills (Skill tool / natural language) the leak board misses', () => {
    const mi = spend.modelInvokedSkills.find((m) => m.name === 'commit-push-pr')!;
    expect(mi).toBeTruthy();
    expect(mi.invocations).toBe(1);
    expect(mi.spanUsdUpperBound).toBeGreaterThan(0);
    // It is NOT double-counted onto the slash-command leak board.
    expect(spend.commandLeakBoard.find((c) => c.command === 'commit-push-pr')!.invocations).toBe(1);
  });
});

describe('always-on tax: recoverable vs observed + MCP framing', () => {
  // Point a session's cwd at a temp project with a known CLAUDE.md so the recoverable
  // project component is deterministic regardless of the dev's home dir.
  const projDir = mkdtempSync(join(tmpdir(), 'cc-audit-proj-'));
  writeFileSync(join(projDir, 'CLAUDE.md'), 'x'.repeat(4000)); // ~1000 tok (char/4)

  const FX = [
    { type: 'user', promptId: 'p1', cwd: projDir, message: { content: 'do a real task in this repo please' } },
    {
      type: 'assistant',
      message: {
        id: 'a1',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', name: 'mcp__Railway__whoami' }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const session = parseTranscript('/tmp/ao.jsonl', FX, 'p', new Set())!;
  const a = computeAlwaysOn([session]);

  it('captures the session cwd and counts that project CLAUDE.md', () => {
    expect(session.cwd).toBe(projDir);
    expect(a.projectClaudeMdTokens).toBeGreaterThan(900); // ~1000 tok
  });

  it('recoverable = global + project + skill listings (additive, file-measured)', () => {
    expect(a.recoverableTokensPerTurn).toBeCloseTo(
      a.globalClaudeMdTokens + a.projectClaudeMdTokens + a.skillDescriptionTokens,
      6,
    );
    // Recoverable $ and observed $ are priced with the same per-token rate.
    if (a.standingContextTokens > 0 && a.recoverableTokensPerTurn > 0) {
      expect(a.recoverableMonthlyUsd / a.recoverableTokensPerTurn).toBeCloseTo(
        a.observedMonthlyUsd / a.standingContextTokens,
        9,
      );
    }
  });

  it('treats MCP as deferred (~$0 standing) and reports a real invoked rate', () => {
    expect(a.mcpDeferred).toBe(true); // default — ENABLE_TOOL_SEARCH not "false"
    expect(a.mcpInvokedRate).toBe(1); // the one session invoked an mcp__ tool
  });
});

describe('always-on tax: CLAUDE.md @imports are counted transitively', () => {
  // A tiny CLAUDE.md that `@imports` a much larger file: the always-on cost is the
  // closure, not the 200-char entry file. This is the ERRORS.md/@import undercount.
  const proj = mkdtempSync(join(tmpdir(), 'cc-audit-import-'));
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'conventions.md'), 'y'.repeat(8000)); // ~2000 tok
  writeFileSync(join(proj, 'CLAUDE.md'), 'Read this first.\n@docs/conventions.md\n'); // tiny entry

  const FX = [
    { type: 'user', promptId: 'p1', cwd: proj, message: { content: 'do a real task in this repo please' } },
    {
      type: 'assistant',
      message: {
        id: 'a1',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const session = parseTranscript('/tmp/ao-import.jsonl', FX, 'p', new Set())!;
  const a = computeAlwaysOn([session]);

  it('includes the imported file, not just the entry CLAUDE.md', () => {
    // Entry file alone is ~10 tok; with the 2000-tok import it must clear ~1900.
    expect(a.projectClaudeMdTokens).toBeGreaterThan(1900);
  });

  it('refuses to read @imports that escape the project tree (e.g. @/etc/passwd)', () => {
    // A hostile cloned-repo CLAUDE.md pointing at a real out-of-tree file: we must
    // NOT pull its contents in. Point at an existing file we control but OUTSIDE the
    // project root, sized big enough that reading it would dominate the count.
    const outside = mkdtempSync(join(tmpdir(), 'cc-audit-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'S'.repeat(40000)); // ~10k tok if read
    const proj3 = mkdtempSync(join(tmpdir(), 'cc-audit-escape-'));
    writeFileSync(join(proj3, 'CLAUDE.md'), `tiny\n@${join(outside, 'secret.md')}\n`);
    const fx = [
      { type: 'user', promptId: 'p1', cwd: proj3, message: { content: 'do a real task in this repo please' } },
      {
        type: 'assistant',
        message: {
          id: 'a1',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const s = parseTranscript('/tmp/ao-escape.jsonl', fx, 'p', new Set())!;
    // Out-of-tree file is counted by stat size (~10k tok) but never READ — and the
    // run does not hang or throw. The point: contents stay on disk; we only stat.
    const tok = computeAlwaysOn([s]).projectClaudeMdTokens;
    expect(tok).toBeGreaterThan(9000); // size-estimated, so the tax is still reflected
    expect(Number.isFinite(tok)).toBe(true); // no OOM/hang
  });

  it('size-estimates an oversize @import instead of reading it into memory', () => {
    const proj4 = mkdtempSync(join(tmpdir(), 'cc-audit-big-'));
    mkdirSync(join(proj4, 'docs'), { recursive: true });
    writeFileSync(join(proj4, 'docs', 'huge.md'), 'B'.repeat(2 * 1024 * 1024)); // 2MB
    writeFileSync(join(proj4, 'CLAUDE.md'), 'tiny\n@docs/huge.md\n');
    const fx = [
      { type: 'user', promptId: 'p1', cwd: proj4, message: { content: 'do a real task in this repo please' } },
      {
        type: 'assistant',
        message: {
          id: 'a1',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const s = parseTranscript('/tmp/ao-big.jsonl', fx, 'p', new Set())!;
    // Capped at MAX_FILE_BYTES (256KB ⇒ ~64k tok), NOT the full 2MB (~512k tok).
    const tok = computeAlwaysOn([s]).projectClaudeMdTokens;
    expect(tok).toBeGreaterThan(60000);
    expect(tok).toBeLessThan(70000);
  });

  it('does not evaluate @imports inside code fences', () => {
    const proj2 = mkdtempSync(join(tmpdir(), 'cc-audit-fence-'));
    mkdirSync(join(proj2, 'docs'), { recursive: true });
    writeFileSync(join(proj2, 'docs', 'big.md'), 'z'.repeat(8000));
    writeFileSync(join(proj2, 'CLAUDE.md'), 'Example:\n```\n@docs/big.md\n```\n');
    const fx = [
      { type: 'user', promptId: 'p1', cwd: proj2, message: { content: 'do a real task in this repo please' } },
      {
        type: 'assistant',
        message: {
          id: 'a1',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const s2 = parseTranscript('/tmp/ao-fence.jsonl', fx, 'p', new Set())!;
    expect(computeAlwaysOn([s2]).projectClaudeMdTokens).toBeLessThan(100); // import ignored
  });
});

describe('recommendations: the config-knob bridge', () => {
  // A temp project with an unpinned premium skill on disk + a transcript that invokes
  // it on Opus with a balanced (non-context-heavy) ratio.
  const proj = mkdtempSync(join(tmpdir(), 'cc-audit-rec-'));
  mkdirSync(join(proj, '.claude', 'skills', 'myskill'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'skills', 'myskill', 'SKILL.md'), 'name: myskill\ndescription: does a thing\n');

  const FX = [
    { type: 'user', promptId: 'p1', cwd: proj, message: { content: '<command-name>myskill</command-name>' } },
    {
      type: 'assistant',
      message: {
        id: 'a1',
        model: 'claude-opus-4-8',
        // Sized so the est. saving clears the report's $0.50/mo floor (balanced
        // in:out ratio keeps it off the context-heavy path).
        usage: { input_tokens: 20000, output_tokens: 20000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Edit' }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const session = parseTranscript('/tmp/rec.jsonl', FX, 'p', new Set())!;
  const recs = buildRecommendations(attributeSpend([session]), computeAlwaysOn([session]), [session]);

  it('points an unpinned premium skill at its exact SKILL.md with a model-pin action', () => {
    const r = recs.find((x) => x.kind === 'model-pin' && x.title.includes('myskill'))!;
    expect(r).toBeTruthy();
    expect(r.file).toBe(join(proj, '.claude', 'skills', 'myskill', 'SKILL.md'));
    expect(r.action).toMatch(/model:/);
    expect(r.monthlyUsdSaved).toBeGreaterThan(0);
  });

  it('does NOT recommend pinning a skill that already has a model pin', () => {
    const pinned = proj + '-pinned';
    mkdirSync(join(pinned, '.claude', 'skills', 'pinnedskill'), { recursive: true });
    writeFileSync(
      join(pinned, '.claude', 'skills', 'pinnedskill', 'SKILL.md'),
      'name: pinnedskill\ndescription: x\nmodel: sonnet\n',
    );
    const fx = [
      { type: 'user', promptId: 'q1', cwd: pinned, message: { content: '<command-name>pinnedskill</command-name>' } },
      {
        type: 'assistant',
        message: {
          id: 'b1',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const sess = parseTranscript('/tmp/rec2.jsonl', fx, 'p', new Set())!;
    const out = buildRecommendations(attributeSpend([sess]), computeAlwaysOn([sess]), [sess]);
    expect(out.some((x) => x.kind === 'model-pin' && x.title.includes('pinnedskill'))).toBe(false);
  });
});

describe('computeFluency', () => {
  it('measures premium share and habit signals', () => {
    const sessions = [parseTranscript('/tmp/fake-abc.jsonl', FIXTURE, 'demo/project')!];
    const f = computeFluency(sessions);
    expect(f.premiumTurnShare).toBeCloseTo(0.5, 6); // opus turn premium, sonnet not
    expect(f.planModeRate).toBe(0);
    expect(f.subagentUsageRate).toBe(0); // no Task tool
    expect(f.modelDiversity).toBe(2);
  });
});

describe('aggregate record (privacy)', () => {
  const sessions = [parseTranscript('/tmp/fake-abc.jsonl', FIXTURE, 'secret/repo-name')!];
  const { aggregate } = runAudit(sessions, '2026-06-16T00:00:00.000Z');

  it('validates against the schema', () => {
    expect(() => AggregateRecordSchema.parse(aggregate)).not.toThrow();
  });

  it('keeps common command names but never leaks project/repo names', () => {
    expect(aggregate.commands.some((c) => c.name === 'commit-push-pr')).toBe(true);
    const blob = JSON.stringify(aggregate);
    expect(blob).not.toContain('secret/repo-name');
    expect(blob).not.toContain('fix the thing'); // no raw prompt text
  });

  it('ships conditional-context as counts only — never filenames or skill/project names', () => {
    // Every value in the conditionalContext aggregate must be a number; a string here
    // would mean a basename or skill name leaked off the machine.
    expect(Object.values(aggregate.conditionalContext).every((v) => typeof v === 'number')).toBe(true);
  });

  it('hashes custom (non-common) command names', () => {
    const custom = [
      { type: 'user', promptId: 'q1', message: { content: '<command-message>acme-deploy</command-message>' } },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const { aggregate: agg } = runAudit([parseTranscript('/tmp/x.jsonl', custom, 'p')!], '2026-06-16T00:00:00.000Z');
    const names = agg.commands.map((c) => c.name);
    expect(names.some((n) => n.startsWith('custom-'))).toBe(true);
    expect(names).not.toContain('acme-deploy');
  });
});
