import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeAlwaysOn } from '../alwaysOn.js';
import {
  attachmentTokens,
  attributedTokens,
  emptyInjectedPrefix,
  fixedPrefixTokens,
  foldAttachment,
  reconcile,
} from '../injectedPrefix.js';
import { countTokens } from '../configFiles.js';
import type { Session } from '../model.js';

// The injected turn-1 prefix, measured from the transcript rather than censused from disk.
//
// EVERY FIXTURE HERE IS RECORDED, NOT WRITTEN. `scripts/record-injected-fixture.mjs`
// takes a real transcript, keeps every row up to the first main-chain assistant turn with
// its structure, field names, string LENGTHS and usage numbers intact, and replaces
// string CONTENT with same-length filler. That matters more than it sounds: a
// hand-authored fixture encodes what we believe the producer emits, and the beliefs in
// this area were wrong in three separate ways (the injected text is in a different field
// per kind; two kinds carry no text at all; there are thirteen kinds where the design doc
// named five). A fixture written from that design doc would have passed against a broken
// parser. See the script header for why same-length filler is size-faithful under
// CharCountTokenizer and what breaks if cc-audit ever adopts a real BPE tokenizer.
//
// The three fixtures are chosen for what they exercise, not for being representative:
//   big-hook  — 5 hook_success blocks, the largest hook carry in the corpus
//   no-hook   — 7 hook_cancelled (the KNOWN-ZERO kind) and no hook output at all; also
//               carries no mcp_instructions_delta, so mcp is a genuine measured zero
//   residual  — an `edited_text_file`, i.e. an injected block with no field of its own

const FIXTURES = join(__dirname, 'fixtures');
const load = (name: string): Session => {
  const raw = readFileSync(join(FIXTURES, `injected-prefix-${name}.jsonl`), 'utf8');
  const s = parseTranscript(`/tmp/${name}.jsonl`, raw, 'fixture', new Set());
  if (!s) throw new Error(`fixture ${name} produced no session`);
  return s;
};

describe('injected prefix: parsing real recorded transcripts', () => {
  it('measures the skill listing from the block, not from any file on disk', () => {
    const s = load('big-hook');
    const inj = s.injected!;
    expect(inj.sawAnyAttachment).toBe(true);
    // The recorded listing is tens of thousands of characters. The disk census that this
    // replaces reported 967 tokens for the same machine.
    expect(inj.skillListingTokens).toBeGreaterThan(2000);
    // The listing names skills that have no SKILL.md anywhere — built-ins ship inside the
    // Claude Code binary. Membership comes from the block, so they are included.
    expect(inj.skillNames.length).toBeGreaterThan(0);
    expect(inj.listingSkillCount).toBe(inj.skillNames.length);
  });

  it('hook output is a first-class component with a real size', () => {
    const big = load('big-hook').injected!;
    const none = load('no-hook').injected!;
    expect(big.hookOutputTokens).toBeGreaterThan(1000);
    // Before this change there was NO FIELD for this at all — the assertion that would
    // have caught it did not exist, which is why it is written as a comparison between
    // two recorded sessions rather than against a constant.
    expect(big.hookOutputTokens).toBeGreaterThan(none.hookOutputTokens);
  });

  it('a KNOWN-ZERO kind contributes zero to its own component, not to the residual', () => {
    // `hook_cancelled` carries ids and a command but no injected content. The no-hook
    // fixture has seven of them. They must land on the hook component at 0 — routing them
    // to the residual would make the residual grow for blocks that cost nothing, which is
    // precisely the signal the residual exists to carry.
    const inj = load('no-hook').injected!;
    expect(inj.hookOutputTokens).toBe(0);
    expect(inj.otherInjectedKinds).not.toContain('hook_cancelled');
  });

  it('an unmapped kind lands in the residual AND is named', () => {
    // The vendor-adds-a-kind case, which is the failure this change exists to survive.
    const inj = load('residual').injected!;
    expect(inj.otherInjectedKinds).toContain('edited_text_file');
    expect(inj.otherInjectedTokens).toBeGreaterThan(0);
  });

  it('a kind we have never seen is SIZED, not silently dropped', () => {
    // Synthesised deliberately — there is no recorded fixture for a kind that does not
    // exist yet, and that is the whole point of the test. It exercises the fallback path
    // only, never a shape claimed to come from the producer.
    const acc = emptyInjectedPrefix();
    foldAttachment(acc, { type: 'some_future_kind_2027', content: 'x'.repeat(4000) });
    expect(acc.otherInjectedKinds).toContain('some_future_kind_2027');
    expect(acc.otherInjectedTokens).toBe(1000);
    // A residual of 0 for an unrecognised block would be indistinguishable from no block.
    expect(acc.otherInjectedTokens).not.toBe(0);
  });

  it('sizes the INJECTED field per kind, not the JSON envelope', () => {
    // Sizing JSON.stringify(attachment) prices field names and punctuation as user
    // config, and over-reports (11,313 vs 10,564 ch on one real skill_listing).
    const att = {
      type: 'skill_listing',
      content: 'c'.repeat(400),
      names: ['a', 'b', 'c'],
      skillCount: 3,
      isInitial: true,
    };
    expect(attachmentTokens(att)).toBe(countTokens('c'.repeat(400)));
    expect(attachmentTokens(att)).toBeLessThan(countTokens(JSON.stringify(att)));

    // Each kind's field is DIFFERENT — the mapping is a wire fact, not a convention.
    expect(attachmentTokens({ type: 'deferred_tools_delta', addedLines: ['ab', 'cd'] })).toBe(
      countTokens('ab\ncd'),
    );
    expect(attachmentTokens({ type: 'mcp_instructions_delta', addedBlocks: ['ab', 'cd'] })).toBe(
      countTokens('ab\ncd'),
    );
  });

  it('stops collecting at turn 1 — later attachments are not standing context', () => {
    // Task reminders, opened files and mid-session hook output are injected too, but they
    // are not the standing prefix. Every fixture ends AT its first assistant turn, so this
    // is asserted against the parser's window logic using a synthetic tail.
    const raw = readFileSync(join(FIXTURES, 'injected-prefix-big-hook.jsonl'), 'utf8');
    const withTail =
      raw.trimEnd() +
      '\n' +
      JSON.stringify({
        type: 'attachment',
        isSidechain: false,
        attachment: { type: 'skill_listing', content: 'z'.repeat(100_000), names: [], skillCount: 0 },
      }) +
      '\n';
    const before = parseTranscript('/tmp/a.jsonl', raw, 'f', new Set())!.injected!.skillListingTokens;
    const after = parseTranscript('/tmp/b.jsonl', withTail, 'f', new Set())!.injected!.skillListingTokens;
    expect(after).toBe(before);
  });
});

describe('injected prefix: reconciliation', () => {
  it('named components + residual + user message never exceed the measured prefix', () => {
    for (const name of ['big-hook', 'no-hook', 'residual']) {
      const s = load(name);
      const t = s.spans.find((sp) => !sp.isSidechain && sp.turns.length > 0)!.turns[0]!;
      const prefix =
        t.usage.input + t.usage.cacheWrite5m + t.usage.cacheWrite1h + t.usage.cacheRead;
      const inj = { ...s.injected!, measuredPrefixTokens: prefix };
      expect(reconcile(name, inj), `${name} did not reconcile`).toBeNull();
      expect(attributedTokens(inj)).toBeLessThanOrEqual(prefix);
      expect(fixedPrefixTokens(inj)!).toBeGreaterThanOrEqual(0);
    }
  });

  it('the fixed remainder is the MAJORITY of the floor on every fixture', () => {
    // The point of naming it. Without this line the breakdown reads as "delete all of
    // this" when the system prompt and tool schemas are most of what the user is paying
    // for and none of it is theirs to cut.
    for (const name of ['big-hook', 'no-hook', 'residual']) {
      const s = load(name);
      const t = s.spans.find((sp) => !sp.isSidechain && sp.turns.length > 0)!.turns[0]!;
      const prefix =
        t.usage.input + t.usage.cacheWrite5m + t.usage.cacheWrite1h + t.usage.cacheRead;
      const inj = { ...s.injected!, measuredPrefixTokens: prefix };
      expect(fixedPrefixTokens(inj)!).toBeGreaterThan(prefix / 2);
    }
  });

  it('a NEGATIVE remainder is surfaced, never clamped to zero', () => {
    // Clamping is how this defect class hides: the number stays plausible while the model
    // underneath is wrong. Synthetic on purpose — a real transcript that double-counts is
    // the bug, so it cannot be recorded.
    const inj = { ...emptyInjectedPrefix(), skillListingTokens: 9_000, measuredPrefixTokens: 1_000 };
    expect(fixedPrefixTokens(inj)).toBe(-8_000);
    const failure = reconcile('sess-1', inj);
    expect(failure).not.toBeNull();
    expect(failure!.fixedPrefixTokens).toBe(-8_000);
    // The failure must name the suspect, not just the total — otherwise the report says
    // "something is wrong" and nobody can act on it.
    expect(failure!.components.skillListing).toBe(9_000);
  });

  it('computeAlwaysOn surfaces per-session failures rather than dropping them', () => {
    const s = load('big-hook');
    // Force the violation by shrinking the measured prefix under the components.
    s.spans[0]!.turns[0]!.usage = { input: 10, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const a = computeAlwaysOn([s]);
    expect(a.reconciliationFailures.length).toBe(1);
    expect(a.fixedPrefixTokens!).toBeLessThan(0); // reported negative, NOT floored at 0
  });
});

describe('injected prefix: unknown is not zero', () => {
  it('a transcript with no attachment records reports null + a reason, not 0', () => {
    const raw = [
      { type: 'user', promptId: 'p1', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const s = parseTranscript('/tmp/old.jsonl', raw, 'p', new Set())!;
    expect(s.injected!.sawAnyAttachment).toBe(false);

    const a = computeAlwaysOn([s]);
    for (const f of ['skillListingTokens', 'hookOutputTokens', 'fixedPrefixTokens', 'skillCount'] as const) {
      expect(a[f], `${f} must be null, not 0`).toBeNull();
      expect(typeof a.unmeasured[f]).toBe('string');
    }
    // ...but standingContextTokens is still measured. The prefix TOTAL does not depend on
    // attachment records, and blanking it here would lose a number we genuinely have.
    expect(a.standingContextTokens).toBe(1000);
  });

  it('a MISSING kind in a session that has attachments is a real zero, not unknown', () => {
    // The distinction the whole change turns on. The no-hook fixture carries attachments
    // but no mcp_instructions_delta, so its MCP figure is a measurement of zero — and a
    // measured zero must NOT be reported as unknown, or "you have no MCP instructions"
    // becomes unsayable.
    const a = computeAlwaysOn([load('no-hook')]);
    expect(a.mcpInstructionTokens).toBe(0);
    expect(a.unmeasured.mcpInstructionTokens).toBeUndefined();
    expect(a.hookOutputTokens).toBe(0);
    expect(a.unmeasured.hookOutputTokens).toBeUndefined();
  });

  it('MCP deferral is read from the session, not from the auditing process env', () => {
    const deferred = computeAlwaysOn([load('big-hook')]);
    expect(deferred.mcpDeferred).toBe(true); // the fixture carries a deferred_tools_delta

    // The env of the process running the audit is a DIFFERENT process from the one that
    // ran the sessions, and used to be the only input. It must not override transcript
    // evidence now that the transcript can answer.
    const prev = process.env.ENABLE_TOOL_SEARCH;
    process.env.ENABLE_TOOL_SEARCH = 'false';
    try {
      expect(computeAlwaysOn([load('big-hook')]).mcpDeferred).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_TOOL_SEARCH;
      else process.env.ENABLE_TOOL_SEARCH = prev;
    }
  });
});
