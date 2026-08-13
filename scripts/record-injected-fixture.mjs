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
// WHAT IS PRESERVED, EXACTLY: every row up to and including the first main-chain
// assistant turn, in order; every `type` and `attachment.type`; every field NAME; every
// string LENGTH; and all usage numbers verbatim.
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

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: record-injected-fixture.mjs <transcript.jsonl> <out.jsonl>');
  process.exit(1);
}

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

function redact(v, key) {
  if (typeof v === 'string') {
    if (STRUCTURAL.has(key)) return v;
    // uuids/ids: keep the shape, drop the value. They key nothing across fixtures.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return v;
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
  const isFirstAssistant = d.type === 'assistant' && !d.isSidechain && d.message?.usage;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    // cwd and paths identify the machine and the work; drop them to a stable stand-in.
    if (k === 'cwd') {
      out[k] = '/fixture/project';
      continue;
    }
    // usage is the whole point of the reconciliation — never touched.
    if (k === 'message' && isFirstAssistant) {
      out[k] = { ...redact(v, k), usage: v.usage };
      continue;
    }
    out[k] = redact(v, k);
  }
  rows.push(out);
  if (isFirstAssistant) break;
}
writeFileSync(dest, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.error(`wrote ${rows.length} rows -> ${dest}`);
