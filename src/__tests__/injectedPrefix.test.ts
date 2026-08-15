import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript } from '../adapters/claudeCode.js';
import { computeAlwaysOn, MAX_UPLOADED_STRING_CHARS, UNMEASURED_REASONS } from '../alwaysOn.js';
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

describe('unmeasured reasons stay inside the upload bound', () => {
  // These sentences are the FIRST strings in the aggregate that can approach the
  // solo-capture endpoint's per-string ceiling. Everything before v10 was a model id or
  // a hash — 25 chars at the longest — so the bound had no plausible way to bite.
  //
  // What a breach costs is why this is a test and not a comment: the server screens
  // every string leaf and 400s the WHOLE capture on a breach, and `sendCapture()`
  // ignores the response by design so a local run can never be broken by telemetry. So
  // the failure mode is the entire record silently not arriving, for every user, from
  // the release that reworded a sentence. Nothing downstream can detect that; the
  // corpus just thins.
  it('every reason is short enough and single-line', () => {
    for (const [key, reason] of Object.entries(UNMEASURED_REASONS)) {
      expect(reason.length, `${key} is ${reason.length} chars`).toBeLessThanOrEqual(
        MAX_UPLOADED_STRING_CHARS,
      );
      // A line break is rejected at ANY length — the screen reads a newline as
      // "this is text, not an identifier", which is exactly right and exactly what a
      // wrapped multi-line template literal would produce.
      expect(reason, `${key} contains a line break`).not.toMatch(/[\n\r]/);
    }
  });

  it('the reasons a real run emits come from that enumerated set', () => {
    // The bound above is worth nothing if a call site writes its own literal instead.
    // An empty-corpus run is the case that populates every field's reason at once.
    const tax = computeAlwaysOn([]);
    const reasons = Object.values(tax.unmeasured);
    expect(reasons.length).toBeGreaterThan(0);
    const known = new Set<string>(Object.values(UNMEASURED_REASONS));
    for (const r of reasons) expect(known.has(r), `unenumerated reason: ${r}`).toBe(true);
  });
});

describe('resumed transcripts: attachments and usage must describe the same turn', () => {
  // THE CASE THIS GUARDS HAS ZERO INSTANCES IN THE AUTHORING CORPUS — 0 of 483 sessions
  // with attachments, out of 926. So it cannot be recorded, and it cannot be observed
  // regression-testing the CLI end to end: the guard is inert on real local data and a
  // suite that only runs real data would stay green with the guard deleted.
  //
  // It is still built from RECORDED bytes rather than hand-authored, because the failure
  // is a property of the cross-file `seen` dedup and not of any field's shape. A resumed
  // replay is exactly "rows this parse has already seen, followed by rows it has not".
  // Seeding `seen` from a PREFIX of a recorded transcript and then parsing the WHOLE of
  // that same transcript reproduces that precisely — no invented rows, only a chosen
  // split point.
  const rawOf = (name: string) =>
    readFileSync(join(FIXTURES, `injected-prefix-${name}.jsonl`), 'utf8');

  /** Parse `raw` after seeding `seen` with everything up to and including the first
   *  main-chain assistant row — i.e. the same transcript arriving as a resumption. */
  function parseAsResumed(name: string) {
    const raw = rawOf(name);
    const lines = raw.split('\n').filter(Boolean);
    const firstAssistant = lines.findIndex((l) => {
      const d = JSON.parse(l) as { type?: string; isSidechain?: boolean; message?: { usage?: unknown } };
      return d.type === 'assistant' && !d.isSidechain && d.message?.usage != null;
    });
    expect(firstAssistant, 'fixture must contain a main-chain assistant turn').toBeGreaterThan(-1);
    // Everything through that turn is "owned by the earlier file".
    const seen = new Set<string>();
    parseTranscript(`/tmp/${name}-earlier.jsonl`, lines.slice(0, firstAssistant + 1).join('\n'), 'fixture', seen);
    return parseTranscript(`/tmp/${name}-resumed.jsonl`, raw, 'fixture', seen);
  }

  it('the fixture still has teeth: turn 2 carries a bigger prefix than turn 1', () => {
    // Everything below rests on this. If `two-turn` is ever re-recorded from a transcript
    // whose two turns happen to carry the SAME prefix, both tests below keep passing while
    // proving nothing — the guard could be deleted and nothing would go red. That is the
    // corpus-bounded-guard failure, so the precondition is asserted, not assumed.
    const prefixes: number[] = [];
    const seenIds = new Set<string>();
    for (const line of rawOf('two-turn').split('\n').filter(Boolean)) {
      const d = JSON.parse(line) as {
        type?: string;
        isSidechain?: boolean;
        message?: {
          id?: string;
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation?: {
              ephemeral_5m_input_tokens?: number;
              ephemeral_1h_input_tokens?: number;
            };
          };
        };
      };
      if (d.type !== 'assistant' || d.isSidechain || !d.message?.usage) continue;
      const id = d.message.id ?? '';
      if (seenIds.has(id)) continue; // streamed rows share one id and are ONE turn
      seenIds.add(id);
      const u = d.message.usage;
      prefixes.push(
        (u.input_tokens ?? 0) +
          (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
          (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
      );
    }
    expect(prefixes.length, 'fixture must hold two DISTINCT main-chain turns').toBe(2);
    // Turn 2 reads turn 1's exchange back out of cache, so it is strictly larger, and the
    // gap IS the inflation this guard prevents — 61,014 -> 61,863 (+849) as recorded.
    expect(prefixes[1]!).toBeGreaterThan(prefixes[0]!);
  });

  it('flags the session when the prefix turn was replayed from an earlier file', () => {
    const fresh = parseTranscript(`/tmp/two-turn.jsonl`, rawOf('two-turn'), 'fixture', new Set());
    expect(fresh?.injected.prefixTurnIsFirst).toBe(true);

    const resumed = parseAsResumed('two-turn');
    // The attachments are still collected — they are genuinely turn 1's.
    expect(resumed?.injected.sawAnyAttachment).toBe(true);
    expect(resumed?.injected.skillListingTokens).toBe(fresh?.injected.skillListingTokens);
    // But the turn `firstMain` will pick is NOT the one they preceded.
    expect(resumed?.injected.prefixTurnIsFirst).toBe(false);
  });

  it('excludes a resumed session from the medians instead of inflating fixedPrefix', () => {
    // Why exclusion rather than a best-effort number: the mismatch inflates, and
    // `reconcile()` only fires on a NEGATIVE remainder, so an inflated fixedPrefix is
    // indistinguishable from a correct one at every downstream reader.
    const resumed = parseAsResumed('two-turn');
    expect(resumed).not.toBeNull();
    const tax = computeAlwaysOn([resumed as Session]);
    expect(tax.skillListingTokens).toBeNull();
    expect(tax.hookOutputTokens).toBeNull();
    expect(tax.fixedPrefixTokens).toBeNull();
    // Named cause, and specifically NOT the no-attachments one — this corpus HAS
    // attachments, and reporting the generic reason would send a reader to look for a
    // transcript-format problem they do not have.
    expect(tax.unmeasured.skillListingTokens).toBe(UNMEASURED_REASONS.allResumed);

    // The OBSERVED prefix is deliberately still reported: a resumed turn really did
    // carry that much. Only the BREAKDOWN is unanswerable.
    expect(tax.standingContextTokens).toBeGreaterThan(0);
  });
});
