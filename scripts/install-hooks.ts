#!/usr/bin/env bun
/**
 * Wire the git-native pre-commit hook; runs as the package "prepare" script
 * on every `bun install`.
 *
 * The dispatcher (.githooks/pre-commit) is COPIED into the repository's
 * hooks directory - shared by all linked worktrees - instead of setting
 * core.hooksPath: a hooksPath pointing at a checkout-relative directory
 * silently runs NO hook in any checkout that lacks the directory (a sibling
 * worktree on an older branch, or the same checkout after switching to one).
 * The installed dispatcher fails closed instead: it refuses the commit when
 * the checkout carries no hook logic. Any stale core.hooksPath from earlier
 * wiring is removed so the default hooks directory applies everywhere.
 *
 * Outside a git repository (an exported tarball, say) there is nothing to
 * wire, and installs must not fail there.
 */

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ROOT } from "./lib";

// The repository is the one containing the working directory (`bun install`
// runs prepare at the package root); the dispatcher source always comes from
// this checkout. git spawns get a GIT_*-free env so a leaked GIT_DIR cannot
// redirect the installation at some other repository.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString().trim() };
}

if (git("rev-parse", "--git-dir").code !== 0) {
  console.error("install-hooks: not inside a git repository; skipping hook installation.");
  process.exit(0);
}

// The stale hooksPath must go FIRST: `--git-path hooks` honors core.hooksPath,
// so resolving the hooks directory before the unset would install the
// dispatcher into the stale location and then abandon it - leaving the
// default hooks directory empty, the silent no-hook state this script exists
// to prevent. Exit 5 means "nothing to unset"; anything else is a failure.
const unset = git("config", "--unset-all", "core.hooksPath");
if (unset.code !== 0 && unset.code !== 5) {
  console.error(`install-hooks: could not remove stale core.hooksPath (git exited ${unset.code}).`);
  process.exit(1);
}

const hooksPath = git("rev-parse", "--git-path", "hooks");
if (hooksPath.code !== 0) {
  console.error(
    `install-hooks: could not resolve the hooks directory (git exited ${hooksPath.code}).`,
  );
  process.exit(1);
}
const hooksDir = isAbsolute(hooksPath.stdout) ? hooksPath.stdout : resolve(hooksPath.stdout);

mkdirSync(hooksDir, { recursive: true });
copyFileSync(join(ROOT, ".githooks", "pre-commit"), join(hooksDir, "pre-commit"));
chmodSync(join(hooksDir, "pre-commit"), 0o755);
