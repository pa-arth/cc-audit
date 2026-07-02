import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { parseTranscript } from '../adapters/claudeCode.js';
import { detectConditionalContext } from '../conditionalContext.js';

// detectConditionalContext() reads the real global ~/.claude/CLAUDE.md (+ skills). Point
// HOME at an empty tmpdir so a developer's actual global "read X" instructions can't leak
// into the fresh-tmpdir cases that assert zero detections. (CI runs with a clean HOME, so
// this only bites locally — but the suite should be hermetic either way.)
let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'cc-cond-home-'));
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

// Build a session in `cwd` that optionally invokes a skill (turn 1) and/or Reads a
// file at a given turn. `readFileAbs` lets a test point the Read at a path outside cwd.
function makeSession(
  id: string,
  cwd: string,
  opts: { readFile?: string; readFileAbs?: string; readAtTurn?: number; turns?: number; invokeSkill?: string } = {},
) {
  const nTurns = opts.turns ?? 2;
  const events: unknown[] = [
    { type: 'user', promptId: 'p1', cwd, message: { content: 'do a real task in this repo please' } },
  ];
  for (let i = 1; i <= nTurns; i++) {
    let content: unknown[];
    if (opts.invokeSkill && i === 1) {
      content = [{ type: 'tool_use', name: 'Skill', input: { skill: opts.invokeSkill } }];
    } else if ((opts.readFile || opts.readFileAbs) && i === (opts.readAtTurn ?? 1)) {
      const fp = opts.readFileAbs ?? join(cwd, opts.readFile!);
      content = [{ type: 'tool_use', name: 'Read', input: { file_path: fp } }];
    } else {
      content = [{ type: 'text', text: 'ok' }];
    }
    events.push({
      type: 'assistant',
      message: {
        id: `a_${id}_${i}`,
        model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
        content,
      },
    });
  }
  return parseTranscript(`/tmp/cc-${id}.jsonl`, events.map((e) => JSON.stringify(e)).join('\n'), 'proj', new Set())!;
}

describe('conditional-context detector (Bug 2: "read X before Y")', () => {
  it('detects an imperative file ref and counts the referenced file via the gateway', () => {
    const proj = mkdtempSync(join(tmpdir(), 'cc-cond-'));
    writeFileSync(join(proj, 'CLAUDE.md'), 'Read ERRORS.md before making any changes.\n');
    writeFileSync(join(proj, 'ERRORS.md'), 'E'.repeat(4000)); // ~1000 tok

    const items = detectConditionalContext([makeSession('1', proj)]);
    const errors = items.find((i) => i.file === 'ERRORS.md');
    expect(errors).toBeDefined();
    expect(errors!.source).toBe('project-claude-md');
    expect(errors!.tokens).toBeGreaterThan(900);
    // The item carries what a cut suggestion needs: the instruction text itself and
    // the absolute path of the config file it lives in (LOCAL-ONLY fields).
    expect(errors!.instruction).toBe('Read ERRORS.md');
    expect(errors!.sourcePath).toBe(join(proj, 'CLAUDE.md'));
    // Single session ⇒ below the confirm threshold ⇒ detected but unverified.
    expect(errors!.observedReadRate).toBeNull();
    expect(errors!.sessionsConsidered).toBe(1);
  });

  it('ignores refs that do not resolve to a real file (the existence filter)', () => {
    const proj = mkdtempSync(join(tmpdir(), 'cc-cond-noise-'));
    // "the README" has no extension; "section 2.1" has a digit "extension" → neither
    // is a file-like token, and nothing on disk backs them.
    writeFileSync(join(proj, 'CLAUDE.md'), 'Please read the README and see section 2.1 for details.\n');
    expect(detectConditionalContext([makeSession('1', proj)])).toHaveLength(0);
  });

  it('does not detect instructions inside code fences', () => {
    const proj = mkdtempSync(join(tmpdir(), 'cc-cond-fence-'));
    writeFileSync(join(proj, 'ERRORS.md'), 'E'.repeat(4000));
    writeFileSync(join(proj, 'CLAUDE.md'), 'Example:\n```\nRead ERRORS.md before changes\n```\n');
    expect(detectConditionalContext([makeSession('1', proj)])).toHaveLength(0);
  });

  it('confirms empirically once a project has enough sessions', () => {
    const proj = mkdtempSync(join(tmpdir(), 'cc-cond-confirm-'));
    writeFileSync(join(proj, 'CLAUDE.md'), 'Always read ERRORS.md first.\n');
    writeFileSync(join(proj, 'ERRORS.md'), 'E'.repeat(4000));

    // 6 sessions: 4 read ERRORS.md at turn 2, 2 never read it.
    const sessions = [
      makeSession('a', proj, { readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('b', proj, { readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('c', proj, { readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('d', proj, { readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('e', proj),
      makeSession('f', proj),
    ];
    const errors = detectConditionalContext(sessions).find((i) => i.file === 'ERRORS.md')!;
    expect(errors.sessionsConsidered).toBe(6);
    expect(errors.observedReadRate).toBeCloseTo(4 / 6, 6);
    expect(errors.observedMedianFirstTurn).toBe(2); // standing-instruction signature: early
  });

  it('detects "read X" inside a skill body and confirms only against invoking sessions', () => {
    const proj = mkdtempSync(join(tmpdir(), 'cc-cond-skill-'));
    const skillDir = join(proj, '.claude', 'skills', 'myskill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'name: myskill\ndescription: does things\n\nRead ERRORS.md before changes.\n');
    writeFileSync(join(skillDir, 'ERRORS.md'), 'E'.repeat(4000)); // resolved relative to the skill dir

    // 5 sessions invoke myskill (the confirmation denominator); 3 of them read ERRORS.md.
    // A 6th session never invokes the skill — it must NOT dilute the rate.
    const sessions = [
      makeSession('s1', proj, { invokeSkill: 'myskill', readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('s2', proj, { invokeSkill: 'myskill', readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('s3', proj, { invokeSkill: 'myskill', readFile: 'ERRORS.md', readAtTurn: 2 }),
      makeSession('s4', proj, { invokeSkill: 'myskill' }),
      makeSession('s5', proj, { invokeSkill: 'myskill' }),
      makeSession('s6', proj, { readFile: 'ERRORS.md', readAtTurn: 1 }),
    ];
    const item = detectConditionalContext(sessions).find((i) => i.source === 'skill' && i.file === 'ERRORS.md');
    expect(item).toBeDefined();
    expect(item!.skill).toBe('myskill');
    expect(item!.tokens).toBeGreaterThan(900);
    expect(item!.sourcePath).toBe(join(skillDir, 'SKILL.md'));
    // Denominator is the 5 invoking sessions, not all 6 — and 3 of them read it.
    expect(item!.sessionsConsidered).toBe(5);
    expect(item!.observedReadRate).toBeCloseTo(3 / 5, 6);
  });

  it('counts an out-of-tree ref by size without crashing (contents never read)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-cond-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'S'.repeat(4000));
    const proj = mkdtempSync(join(tmpdir(), 'cc-cond-escape-'));
    writeFileSync(join(proj, 'CLAUDE.md'), `Read ${join(outside, 'secret.md')} before changes.\n`);

    const item = detectConditionalContext([makeSession('1', proj)]).find((i) => i.file === 'secret.md');
    // The tax is reflected (size-estimated), and the run does not throw/hang — the
    // gateway guarantees contents stay on disk for out-of-tree paths.
    expect(item).toBeDefined();
    expect(Number.isFinite(item!.tokens)).toBe(true);
    expect(item!.tokens).toBeGreaterThan(0);
  });
});
