#!/usr/bin/env node
// Reproducible build of the cc-audit distribution artifacts:
//   - self-contained single-file binaries (bun --compile, no Node needed)
//   - a Node ESM fallback (esbuild bundle of dist/cli.js)
// Output: bundles/ (gitignored). On a v* tag push, the publish workflow
// attaches these to the GitHub Release for the tag (see .github/workflows/publish.yml).
//
// Prereq: `bun` on PATH or at ~/.bun/bin/bun (binary compile). esbuild is a
// devDependency (the .mjs fallback).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoRoot, 'bundles');
const cli = path.join(repoRoot, 'dist/cli.js');
// Bake the version into the bundle (src/version.ts) so a bun-compiled binary —
// which ships no package.json — still reports and update-checks correctly.
const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
// esbuild wants `--define:KEY=VALUE` (colon); bun wants `--define KEY=VALUE` (space, two
// args). Passing the colon form to bun is silently ignored — the identifier survives and the
// binary reports 0.0.0. Keep the two spellings separate.
const esbuildDefine = `--define:__CC_AUDIT_VERSION__=${JSON.stringify(version)}`;
const bunDefine = ['--define', `__CC_AUDIT_VERSION__=${JSON.stringify(version)}`];
mkdirSync(outDir, { recursive: true });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`\nbundle: failed → ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

// Re-enter the SAME package manager that invoked us. `npm_execpath` is set by
// npm/pnpm/yarn alike and points at that manager's own JS entry point.
// Spawning a bare `pnpm` instead picks up whatever is on PATH, and under
// corepack that trips pnpm's version-switch guard:
//   "Corepack invoked pnpm with this version, and pnpm does not switch
//    versions when running under corepack."
// Observed for real while migrating this repo to pnpm.
function pm(args) {
  const execpath = process.env.npm_execpath;
  if (execpath) run(process.execPath, [execpath, ...args]);
  else run('pnpm', args);
}

// 1. Compile TS (the bundlers consume dist/cli.js).
pm(['run', 'build']);

// 2. Self-contained binaries via bun --compile.
const bunPath = path.join(homedir(), '.bun/bin/bun');
const bun = existsSync(bunPath) ? bunPath : 'bun';
const targets = [
  ['bun-darwin-arm64', 'cc-audit-darwin-arm64'],
  ['bun-darwin-x64', 'cc-audit-darwin-x64'],
  ['bun-linux-x64-modern', 'cc-audit-linux-x64'],
];
for (const [target, name] of targets) {
  console.log(`\nbundle: compiling ${name} (${target})…`);
  run(bun, ['build', cli, '--compile', ...bunDefine, `--target=${target}`, `--outfile=${path.join(outDir, name)}`]);
}

// 3. Node ESM fallback via esbuild.
console.log('\nbundle: esbuild Node fallback (cc-audit.mjs)…');
pm(['exec',
  'esbuild', 'dist/cli.js',
  '--bundle', '--platform=node', '--format=esm', '--target=node18',
  esbuildDefine,
  '--outfile=bundles/cc-audit.mjs',
]);

console.log(`\nbundle: done → ${outDir}`);
