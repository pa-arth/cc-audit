#!/usr/bin/env node
// Record an injected-prefix test fixture from a REAL transcript.
//
// WHY A RECORDER AND NOT A HAND-WRITTEN FIXTURE. A hand-authored fixture encodes what we
// BELIEVE the producer emits, and a belief is exactly what this area of the code got
// wrong: the injected text lives in a different field per attachment kind (`content`,
// `addedLines`, `addedBlocks`, `snippet`), two kinds carry no text at all, and the kind
// list is thirteen long where the design doc said five. A fixture written from that
// design doc would have passed while the parser was wrong. So fixtures are RECORDED.
//
// WHAT IS PRESERVED, EXACTLY: every row up to and including the Nth main-chain assistant
// TURN (N defaults to 1), in order; every `type` and `attachment.type`; every field NAME;
// every string LENGTH; all usage numbers verbatim; and the distinctness of every id.
//
// WHAT IS REPLACED: the content of every string. Hook output on this machine contains
// other sessions' prompts and prompts contain work in progress, and neither belongs in a
// repo. Each string becomes filler of the SAME length.
//
// WHY SAME-LENGTH FILLER IS SOUND HERE, AND THE CAVEAT: cc-audit's tokenizer is
// `CharCountTokenizer` — `Math.ceil(text.length / 4)` — so a same-length replacement
// yields byte-identical token counts. THIS WOULD NOT HOLD under a real BPE tokenizer,
// where token count depends on the characters and not only how many there are. If
// cc-audit ever adopts a real tokenizer, these fixtures stop being size-faithful and must
// be re-recorded with a tokenizer-aware redaction — or the assertions moved off exact
// counts. Recorded here rather than left for someone to discover.
//
// Usage: node scripts/record-injected-fixture.mjs <transcript.jsonl> <out.jsonl>

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [src, dest, turnsArg] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: record-injected-fixture.mjs <transcript.jsonl> <out.jsonl> [mainTurns=1]');
  process.exit(1);
}
/** How many main-chain assistant turns to keep. 1 (the default) records the turn-1
 *  prefix, which is all the original fixtures needed. 2 is required for the
 *  resumed-transcript case: it needs a SECOND turn for the dedup to leave behind. */
const stopAfterTurns = turnsArg ? Number(turnsArg) : 1;
if (!Number.isInteger(stopAfterTurns) || stopAfterTurns < 1) {
  console.error('mainTurns must be a positive integer');
  process.exit(1);
}
const mainTurnIds = new Set();

// Deterministic, obviously-synthetic filler. Not random: a fixture that changes on every
// recording makes a diff unreadable and invites `-u`-ing a real regression green.
const filler = (n) => {
  let s = '';
  const unit = 'redacted-fixture-content ';
  while (s.length < n) s += unit;
  return s.slice(0, n);
};

// Keys whose values are structural, not content — kept verbatim so the parser sees the
// real shape. Everything else that is a string gets filled.
const STRUCTURAL = new Set([
  'type',
  'hookEvent',
  'reminderType',
  'isSidechain',
  'isMeta',
  'userType',
  'entrypoint',
  'role',
  'stop_reason',
  'version',
  'gitBranch',
  // mode/permissionMode DRIVE the parser (curMode, plan-mode resolution). Filling them
  // produced a fixture whose mode read 'redact' — a shape Claude Code cannot emit, which
  // is precisely the failure recording fixtures is supposed to prevent.
  'mode',
  'permissionMode',
  'promptSource',
  'origin',
  'model',
  'name',
  'service_tier',
  'speed',
]);

// Identity keys. These do NOT get flat filler, and the reason is a bug this script
// shipped: `message.id` was filled to a constant, so every assistant row in a recording
// carried the SAME id — and the parser merges same-id rows into one turn. A two-turn
// recording came back as one turn with one prefix, which is a shape Claude Code cannot
// emit. (The old comment here said ids "key nothing across fixtures". They key the
// cross-file `seen` dedup and the streamed-row merge, which is most of what this parser
// does.)
//
// So identity is replaced by a BIJECTION: each distinct real value gets one distinct
// synthetic value, memoized, so rows that shared an id still share one and rows that did
// not still differ. Carries no real value, preserves every property the parser reads.
// `tool_use_id` is here because it is one HALF of a join: a `tool_result` block names the
// `tool_use` block's `id`, and the adapter folds is_error/timestamp back onto the issuing
// turn through `turnByToolId`. Redacting one side and not the other severs it — and worse
// than severing, because filler is length-preserving: two DISTINCT tool_use_ids of equal
// length collapse to the SAME filler, so a fixture can fold two results onto one call. The
// first recording did exactly that (both reading `redacted-fixture-content redac`), which
// is again a shape the producer cannot emit — a tool_result pointing at no tool_use.
const IDENTITY = new Set([
  'id',
  'requestId',
  'uuid',
  'parentUuid',
  'leafUuid',
  'toolUseID',
  'tool_use_id',
]);
const idMap = new Map();
const synthId = (real) => {
  let s = idMap.get(real);
  if (!s) {
    s = `fixture-id-${String(idMap.size + 1).padStart(4, '0')}`;
    idMap.set(real, s);
  }
  return s;
};

function redact(v, key) {
  if (typeof v === 'string') {
    if (STRUCTURAL.has(key)) return v;
    if (IDENTITY.has(key)) return synthId(v);
    return filler(v.length);
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = redact(val, k);
    return o;
  }
  return v;
}

const rows = [];
const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    continue;
  }
  const isMainAssistant = d.type === 'assistant' && !d.isSidechain && d.message?.usage;
  // Count TURNS, not rows. One streamed assistant message spans several rows sharing a
  // message.id and the parser merges them, so counting rows records fewer turns than it
  // reports — the first attempt at a two-turn fixture was one turn in two rows.
  const msgId = d.message?.id ?? d.requestId ?? d.uuid ?? '';
  if (isMainAssistant && !mainTurnIds.has(msgId)) mainTurnIds.add(msgId);
  const mainAssistantsSeen = mainTurnIds.size;
  const isFirstAssistant = isMainAssistant && mainAssistantsSeen === 1;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    // cwd and paths identify the machine and the work; drop them to a stable stand-in.
    if (k === 'cwd') {
      out[k] = '/fixture/project';
      continue;
    }
    // usage is the whole point of the reconciliation — never touched. Kept on EVERY
    // main-chain assistant turn, not only the first: the resumed-transcript fixture needs
    // turn 2's usage to be real, because the defect it reproduces is precisely that
    // turn 2's prefix is larger than turn 1's.
    if (k === 'message' && isMainAssistant) {
      out[k] = { ...redact(v, k), usage: v.usage };
      continue;
    }
    out[k] = redact(v, k);
  }
  rows.push(out);
  if (mainAssistantsSeen >= stopAfterTurns) break;
}
writeFileSync(dest, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.error(`wrote ${rows.length} rows -> ${dest}`);
