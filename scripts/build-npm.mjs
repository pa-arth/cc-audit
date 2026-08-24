#!/usr/bin/env node
// Build the npm-publishable artifact for @promptster/cc-audit.
//
// The root package is `private: true`, so we never `npm publish` it directly.
// Instead we emit a self-contained, dependency-free package to bundles/npm/ —
// esbuild inlines the runtime deps (@clack/prompts + zod) into a single file, and
// we generate a clean package.json with no dependencies. This keeps
// `npx @promptster/cc-audit` instant (one file, zero transitive install).
//
// (Pre-split, this also inlined @promptster/config-cost, a workspace dep that
// doesn't exist on npm. That dep is now vendored into src/vendor/, so the bundle
// is no longer load-bearing for publish — but it stays because a single-file CLI
// is still the better npx experience.)
//
// Publish from the output dir:  npm publish ./bundles/npm --access public
// (the leading ./ matters — npm reads a bare `bundles/npm` as a GitHub shorthand)

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoRoot, 'bundles/npm');
const srcPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`\nbuild:npm: failed → ${cmd} ${args.join(' ')}`);
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

mkdirSync(outDir, { recursive: true });

// 1. Compile TS → dist/cli.js (esbuild bundles from there).
pm(['run', 'build']);

// 2. esbuild bundle → bundles/npm/cc-audit.mjs (inlines @clack/prompts + zod).
//    esbuild passes through the #!/usr/bin/env node shebang from the entry file.
//    --define bakes the version into the single file (src/version.ts) so the
//    published bundle reports it without shipping or reading a package.json.
pm(['exec',
  'esbuild', 'dist/cli.js',
  '--bundle', '--platform=node', '--format=esm', '--target=node18',
  `--define:__CC_AUDIT_VERSION__=${JSON.stringify(srcPkg.version)}`,
  '--outfile=bundles/npm/cc-audit.mjs',
]);
chmodSync(path.join(outDir, 'cc-audit.mjs'), 0o755);

// 3. Generate a clean, dependency-free package.json for the published artifact.
const outPkg = {
  name: srcPkg.name,
  version: srcPkg.version,
  description: srcPkg.description,
  license: srcPkg.license,
  type: 'module',
  bin: { 'cc-audit': 'cc-audit.mjs' },
  files: ['cc-audit.mjs', 'README.md', 'LICENSE'],
  engines: { node: '>=18' },
  keywords: ['claude-code', 'claude', 'anthropic', 'llm', 'cost', 'spend', 'audit', 'cli'],
  repository: { type: 'git', url: 'git+https://github.com/pa-arth/cc-audit.git' },
  publishConfig: { access: 'public' },
};
writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(outPkg, null, 2) + '\n');

// 4. Bring along README + LICENSE for the npm package page.
copyFileSync(path.join(repoRoot, 'README.md'), path.join(outDir, 'README.md'));
const rootLicense = path.join(repoRoot, 'LICENSE');
if (existsSync(rootLicense)) copyFileSync(rootLicense, path.join(outDir, 'LICENSE'));

console.log(`\nbuild:npm: done → ${outDir}`);
console.log('  smoke test:   node bundles/npm/cc-audit.mjs --help');
console.log('  dry-run:      npm publish ./bundles/npm --dry-run');
console.log('  publish:      npm publish ./bundles/npm --access public');
