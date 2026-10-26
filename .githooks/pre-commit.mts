#!/usr/bin/env bun
/**
 * Pre-commit hook logic, invoked by the dispatcher that
 * scripts/install-hooks.mts installs into the shared hooks directory. The
 * dispatcher runs with the repository root as the working directory
 * (githooks(5): pre-commit runs at the top of the working tree).
 *
 * The previous hook additionally guarded .git/config against mutation by
 * leaky tests; that guard is gone because the hermetic test environment
 * (scripts/hermetic-git-env.mts) blocks accidental (cwd- or env-based)
 * discovery of the real repository from tests - not deliberate targeting.
 */

import { statSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const root = process.cwd();

function entry(path: string) {
  return statSync(path, { throwIfNoEntry: false });
}

// A manual run from a subdirectory would check the wrong tree (git itself runs hooks at the root); a .git file is a linked worktree's root, a directory the main checkout's.
const dotGit = entry(join(root, ".git"));

if (!dotGit?.isDirectory() && !dotGit?.isFile()) {
  console.error(
    `pre-commit: ${root} is not a repository root; run from the top of the working tree.`,
  );
  process.exit(1);
}

// Read BEFORE the scrub below: `git commit <pathspec>` and `git commit -a` stage into a temporary index that only GIT_INDEX_FILE names.
const staged = Bun.spawnSync(
  ["git", "diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"],
  { cwd: root, stdout: "pipe", stderr: "inherit" },
);

if (staged.exitCode !== 0) {
  console.error("pre-commit: could not read the staged files.");
  process.exit(1);
}

// Empty when nothing is staged; the gate then reads the index itself (scripts/check-staged.mts).
const stagedPaths = staged.stdout.toString().split("\0").filter(Boolean);

// Incident class: git exports GIT_DIR, GIT_INDEX_FILE and other GIT_* variables to hooks, and an inherited GIT_DIR redirects any fixture git operation at THIS repository; nothing below needs them.
const env: Record<string, string> = {};

for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
}

// The targeted gate (scripts/check-staged.mts); the full `bun run check` is CI's.
const check = Bun.spawnSync(["bun", "run", "check:staged", ...stagedPaths], {
  cwd: root,
  env,
  stdout: "inherit",
  stderr: "inherit",
});

if (check.exitCode !== null) process.exit(check.exitCode);

// Shell-style status when the check dies by signal (e.g. 143 for SIGTERM).
const signalNumber = check.signalCode ? constants.signals[check.signalCode] : undefined;

process.exit(signalNumber === undefined ? 1 : 128 + signalNumber);
