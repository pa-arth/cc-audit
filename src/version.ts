// Single source of the running cc-audit version.
//
// At bundle time esbuild and `bun --compile` replace the bare identifier
// __CC_AUDIT_VERSION__ with a string literal (see scripts/bundle.mjs and
// scripts/build-npm.mjs — the `--define` flag). In a raw `tsc` dev run there's
// no define step, so the identifier stays undefined and we fall back to reading
// the package.json that sits one level up from dist/. Either way VERSION is a
// plain string and nothing here touches the network.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Injected by the bundler; declared (not defined) so tsc compiles the dev build.
declare const __CC_AUDIT_VERSION__: string | undefined;

function injected(): string | undefined {
  // `typeof` on an undeclared identifier is safe (yields 'undefined') — this is
  // exactly the dev/tsc path where no define ran. After the bundler's define,
  // this whole branch folds to the literal.
  return typeof __CC_AUDIT_VERSION__ === 'string' ? __CC_AUDIT_VERSION__ : undefined;
}

function fromPackageJson(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = injected() ?? fromPackageJson();
