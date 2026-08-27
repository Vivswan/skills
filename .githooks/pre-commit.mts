#!/usr/bin/env bun
/**
 * Pre-commit hook logic, run by the .githooks/pre-commit shim with the
 * repository root as the working directory (githooks(5): pre-commit runs at
 * the top of the working tree).
 *
 * The old .husky/pre-commit additionally guarded .git/config against
 * mutation by leaky tests; that guard is gone because tests/preload.ts now
 * makes the real repository unreachable from every test by construction.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

// Manual invocation from a subdirectory would run the checks in the wrong
// place; git itself always provides the repository root as the cwd.
if (!existsSync(join(root, ".git"))) {
  console.error(
    `pre-commit: ${root} is not a repository root; run from the top of the working tree.`,
  );
  process.exit(1);
}

// Refuse to mutate the repo during commits. Dependencies should already exist.
if (!existsSync(join(root, "node_modules"))) {
  console.error("Dependencies are missing. Run 'bun install' before committing.");
  process.exit(1);
}

// Incident class: leaked git hook environment. git exports GIT_DIR,
// GIT_INDEX_FILE, and other GIT_* variables to hooks; everything spawned
// below inherits them, and an inherited GIT_DIR redirects any fixture git
// operation at THIS repository. Nothing below needs any GIT_* variable - the
// checks run at the repository root, so git rediscovers the repository from
// the working directory - scrub them all.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
}

// The full gates CI also runs; catch failures before they leave the machine.
const check = Bun.spawnSync(["bun", "run", "check"], {
  cwd: root,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(check.exitCode ?? 1);
