#!/usr/bin/env node
// Reproducible build of the cc-audit distribution artifacts:
//   - self-contained single-file binaries (bun --compile, no Node needed)
//   - a Node ESM fallback (esbuild bundle of dist/cli.js)
// Output: bundles/ (gitignored). These are uploaded as the
// pa-arth/cc-audit-releases release assets.
//
// Prereq: `bun` on PATH or at ~/.bun/bin/bun (binary compile). esbuild is a
// devDependency (the .mjs fallback).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoRoot, 'bundles');
const cli = path.join(repoRoot, 'dist/cli.js');
mkdirSync(outDir, { recursive: true });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`\nbundle: failed → ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

// 1. Compile TS (the bundlers consume dist/cli.js).
run('npm', ['run', 'build']);

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
  run(bun, ['build', cli, '--compile', `--target=${target}`, `--outfile=${path.join(outDir, name)}`]);
}

// 3. Node ESM fallback via esbuild.
console.log('\nbundle: esbuild Node fallback (cc-audit.mjs)…');
run('npx', [
  'esbuild', 'dist/cli.js',
  '--bundle', '--platform=node', '--format=esm', '--target=node18',
  '--outfile=bundles/cc-audit.mjs',
]);

console.log(`\nbundle: done → ${outDir}`);
