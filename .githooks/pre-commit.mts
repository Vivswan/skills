#!/usr/bin/env bun
/**
 * Pre-commit hook logic, invoked by the dispatcher that
 * scripts/install-hooks.ts installs into the shared hooks directory. The
 * dispatcher runs with the repository root as the working directory
 * (githooks(5): pre-commit runs at the top of the working tree).
 *
 * The previous hook additionally guarded .git/config against mutation by
 * leaky tests; that guard is gone because the hermetic test environment
 * (scripts/hermetic-git-env.ts) makes the real repository unreachable from
 * every test by construction.
 */

import { statSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const root = process.cwd();

function entry(path: string) {
  return statSync(path, { throwIfNoEntry: false });
}

// Manual invocation from a subdirectory would run the checks in the wrong
// place; git itself always provides the repository root as the cwd. A .git
// directory is the main checkout, a .git file a linked worktree - both are
// repository roots.
const dotGit = entry(join(root, ".git"));
if (!dotGit?.isDirectory() && !dotGit?.isFile()) {
  console.error(
    `pre-commit: ${root} is not a repository root; run from the top of the working tree.`,
  );
  process.exit(1);
}

// Refuse to mutate the repo during commits. Dependencies should already exist.
if (!entry(join(root, "node_modules"))?.isDirectory()) {
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
if (check.exitCode !== null) process.exit(check.exitCode);
// Shell-style status when the check dies by signal (e.g. 143 for SIGTERM).
const signalNumber = check.signalCode ? constants.signals[check.signalCode] : undefined;
process.exit(signalNumber !== undefined ? 128 + signalNumber : 1);
