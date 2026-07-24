#!/usr/bin/env node
// Re-sync src/vendor/pricing.ts from the canonical @promptster/config-cost source
// in the promptster-backend monorepo. The vendored file is a verbatim mirror of the
// upstream body with this repo's vendor-provenance header prepended.
//
// Usage:
//   node scripts/sync-pricing.mjs                 # probe ../promptster-backend sibling
//   node scripts/sync-pricing.mjs --from <path>   # explicit path to config-cost pricing.ts
//   node scripts/sync-pricing.mjs --force         # overwrite local hand-edits anyway
//
// The header records a sha256 of the upstream body it copied. On the next run the
// script re-hashes the vendored body and REFUSES to write if it no longer matches —
// i.e. someone hand-edited the mirror. Without that check the copy silently reverts
// local fixes, which is not hypothetical: the vendored Anthropic lookup carried a
// longest-key-first prefix sort that upstream lacked, and a plain re-copy would have
// dropped it with no diff to notice. A fix that matters belongs upstream; this makes
// the script say so instead of quietly undoing it.
//
// After running: review the diff, run `npm test` (the litellm drift guard in
// src/__tests__/pricingDrift.test.ts cross-checks the new table), and update the
// offline regression pins there if models were added/removed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(repoRoot, 'src', 'vendor', 'pricing.ts');
const SIBLING = join(repoRoot, '..', 'promptster-backend', 'packages', 'config-cost', 'src', 'pricing.ts');

function fail(msg) {
  console.error(`sync-pricing: ${msg}`);
  process.exit(1);
}

// ── Resolve source ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let src = null;
const fromIdx = args.indexOf('--from');
if (fromIdx !== -1) {
  src = args[fromIdx + 1];
  if (!src) fail('--from requires a path');
  src = resolve(src);
  if (!existsSync(src)) fail(`--from path not found: ${src}`);
} else if (existsSync(SIBLING)) {
  src = SIBLING;
} else {
  fail(
    `no sibling backend checkout at ${SIBLING}\n` +
      'Pass --from <path/to/promptster-backend>/packages/config-cost/src/pricing.ts',
  );
}

// ── Strip the upstream header banner, keep the body verbatim ────────────────
// config-cost's pricing.ts opens with a `// ---` … `// ---` comment banner that
// describes its place in the monorepo; the vendored copy replaces it with the
// vendor-provenance header below.
const raw = readFileSync(src, 'utf8');
const lines = raw.split('\n');
const isRule = (l) => /^\/\/ -{10,}$/.test(l.trimEnd());
let bodyStart = 0;
if (isRule(lines[0] ?? '')) {
  const close = lines.findIndex((l, i) => i > 0 && isRule(l));
  if (close === -1) fail('unterminated header banner in source — refusing to guess');
  bodyStart = close + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart += 1;
}
const body = lines.slice(bodyStart).join('\n');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const today = new Date().toISOString().slice(0, 10);
const header = `// ---------------------------------------------------------------------------
// VENDORED from @promptster/config-cost (packages/config-cost/src/pricing.ts).
// Last synced: ${today} via scripts/sync-pricing.mjs — do not hand-edit; re-run
// the script against a fresh backend checkout instead.
//
// ⚠️  DRIFT RISK — this is a hand-copied mirror, not a package dependency.
// When this repo was split out of the promptster-backend monorepo, config-cost
// was a \`workspace:*\` dependency that doesn't exist on npm, which forced the old
// esbuild bundle-hack to publish. Vendoring the tables unblocked the split.
//
// The PROPER fix is publishing @promptster/config-cost as a standalone npm
// package during pricing centralization, then depending on it here and deleting
// this file (follow-up — see README "Vendored pricing").
//
// Until then: if Anthropic/OpenAI pricing changes, update this file AND the
// upstream config-cost table together. Two guards keep them in lockstep:
//   - src/__tests__/pricingDrift.test.ts — the litellm-drift test (ported from
//     config-cost) cross-checks these tables against LiteLLM's pricing DB in CI.
//   - scripts/sync-pricing.mjs — re-copies this file from a sibling backend
//     checkout (see MAINTAINING.md "Vendored pricing").
//
// Mirrored verbatim (no edits) so a future re-sync is a straight file copy. The
// sha256 below is of the upstream body as copied; sync-pricing.mjs re-checks it and
// refuses to overwrite a hand-edited mirror. Fix pricing bugs UPSTREAM in config-cost
// and re-sync — an edit made only here is reverted by the next sync.
// Upstream-body-sha256: ${sha(body)}
// ---------------------------------------------------------------------------

`;
const next = header + body;

// ── Diff summary ────────────────────────────────────────────────────────────
const prev = existsSync(DEST) ? readFileSync(DEST, 'utf8') : '';
const stripHeader = (s) => {
  const ls = s.split('\n');
  if (!isRule(ls[0] ?? '')) return s;
  const close = ls.findIndex((l, i) => i > 0 && isRule(l));
  return close === -1 ? s : ls.slice(close + 1).join('\n').replace(/^\n+/, '');
};
const modelKeys = (s, table) => {
  const m = s.match(new RegExp(`export const ${table}[^=]*= \\{([\\s\\S]*?)\\n\\};`));
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/^\s{2}'([^']+)':/gm)].map((x) => x[1]));
};

const prevRecorded = prev.match(/^\/\/ Upstream-body-sha256: ([0-9a-f]{64})$/m)?.[1];
// In sync only when the body matches AND the provenance hash is already recorded —
// otherwise fall through and rewrite so the guard below has something to check next
// time (this is what re-stamps a mirror that pre-dates the hash line).
if (stripHeader(prev) === stripHeader(next) && prevRecorded === sha(body)) {
  console.log(`sync-pricing: already in sync with ${src} — nothing to do`);
  process.exit(0);
}

// ── Refuse to clobber hand-edits ────────────────────────────────────────────
// The recorded hash is of the upstream body at the LAST sync. If the current
// vendored body no longer hashes to it, someone edited the mirror in place and a
// straight copy would delete that work silently.
const recorded = prevRecorded;
if (recorded && !args.includes('--force')) {
  const actual = sha(stripHeader(prev));
  if (actual !== recorded) {
    fail(
      'the vendored file has been hand-edited since the last sync — refusing to overwrite.\n' +
        `  recorded upstream body: ${recorded.slice(0, 12)}…\n` +
        `  current vendored body:  ${actual.slice(0, 12)}…\n` +
        '  Inspect with: git log -p -- src/vendor/pricing.ts\n' +
        '  Land the local change in @promptster/config-cost upstream, then re-sync.\n' +
        '  To discard the local edit anyway: node scripts/sync-pricing.mjs --force',
    );
  }
} else if (!recorded) {
  console.warn(
    'sync-pricing: no Upstream-body-sha256 in the current vendored file (pre-dates the\n' +
      '  hand-edit guard) — cannot verify it is unmodified. Review the diff carefully.',
  );
}

writeFileSync(DEST, next);
console.log(`sync-pricing: wrote ${DEST}\n  from ${src}\n`);
for (const table of ['ANTHROPIC_PRICING', 'OPENAI_PRICING']) {
  const before = modelKeys(prev, table);
  const after = modelKeys(next, table);
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  if (added.length) console.log(`  ${table} added:   ${added.join(', ')}`);
  if (removed.length) console.log(`  ${table} removed: ${removed.join(', ')}`);
}
const d = (s) => stripHeader(s).split('\n').length;
console.log(`  body lines: ${d(prev)} -> ${d(next)}`);
console.log('\nNext: review `git diff src/vendor/pricing.ts`, then `npm test` (drift guard).');
