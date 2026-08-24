#!/usr/bin/env node
// Refuses `npm install` / `yarn` / `bun install` in this repo, so nobody
// silently re-inflates a private node_modules beside the pnpm store.
//
// Local on purpose. The usual recipe is `npx --yes only-allow pnpm`, which
// downloads and executes an unpinned package from the registry with installer
// privileges on EVERY install — outside the lockfile's integrity pins, so a
// compromised release lands here without a commit. This file is ~20 lines and
// fetches nothing.
//
// npm sets npm_config_user_agent for every package manager that runs a
// lifecycle script: "pnpm/10.4.1 npm/? node/v22.11.0 darwin arm64".
const ua = process.env.npm_config_user_agent ?? "";
const pm = ua.split(" ")[0].split("/")[0];

// No user agent means we were not run by a package manager (a direct `node
// scripts/only-pnpm.mjs`, some CI shims). Unknown is not a violation.
if (pm === "" || pm === "pnpm") process.exit(0);

process.stderr.write(
  `\nThis repo uses pnpm. You ran ${pm}.\n\n` +
    `  corepack enable        # once, pins the version from package.json\n` +
    `  pnpm install\n\n` +
    `npm/yarn would write a second, unshared node_modules and a lockfile this\n` +
    `repo does not track. See the "Contributing" section of README.md.\n\n`,
);
process.exit(1);
