#!/usr/bin/env bun
/**
 * Wire the git-native pre-commit hook; runs as the package "prepare" script
 * on every `bun install`.
 *
 * The dispatcher (.githooks/pre-commit) is COPIED into the repository's
 * common hooks directory - shared by all linked worktrees - instead of
 * setting core.hooksPath: a hooksPath pointing at a checkout-relative
 * directory silently runs NO hook in any checkout that lacks the directory
 * (a sibling worktree on an older branch, or the same checkout after
 * switching to one). The installed dispatcher fails closed instead: it
 * refuses the commit when the checkout carries no hook logic. A stale local
 * core.hooksPath from earlier wiring is removed; a hooksPath that survives
 * in any other scope (global, system, include, worktree) aborts the install
 * loudly - installing anyway would either be shadowed at commit time or,
 * worse, overwrite a user-wide hook location.
 *
 * Outside a git repository (an exported tarball, say) there is nothing to
 * wire, and installs must not fail there.
 */

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ROOT } from "./lib";

// The repository is the one containing the working directory (`bun install`
// runs prepare at the package root); the dispatcher source always comes from
// this checkout. Only the repo-REDIRECTING variables are dropped for git
// spawns (a leaked GIT_DIR must not point the installation at some other
// repository); GIT_CONFIG_* stay visible, because the same config that
// applies here decides where hooks resolve at commit time.
const REDIRECTING = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !REDIRECTING.has(key.toUpperCase())) env[key] = value;
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString().trim() };
}

if (git("rev-parse", "--git-dir").code !== 0) {
  console.error("install-hooks: not inside a git repository; skipping hook installation.");
  process.exit(0);
}

// Remove the stale LOCAL hooksPath from earlier wiring. Exit 5 means
// "nothing to unset"; anything else is a failure.
const unset = git("config", "--unset-all", "core.hooksPath");
if (unset.code !== 0 && unset.code !== 5) {
  console.error(`install-hooks: could not remove stale core.hooksPath (git exited ${unset.code}).`);
  process.exit(1);
}

// If an EFFECTIVE hooksPath survives (global/system/include/worktree scope),
// refuse: the default hooks directory would be shadowed at commit time, and
// writing into the configured location could clobber a user-wide hook.
const effective = git("config", "--show-scope", "--get-all", "core.hooksPath");
if (effective.code === 0) {
  console.error(
    `install-hooks: core.hooksPath is still set outside the repository scope:\n  ${effective.stdout}\n` +
      "Remove it (git config --unset in that scope), then rerun 'bun install'.",
  );
  process.exit(1);
}

// The common hooks directory, resolved independently of configuration
// (`--git-path hooks` would honor a hooksPath; `--git-common-dir` cannot).
const commonDir = git("rev-parse", "--git-common-dir");
if (commonDir.code !== 0) {
  console.error(
    `install-hooks: could not resolve the common git directory (git exited ${commonDir.code}).`,
  );
  process.exit(1);
}
const hooksDir = join(
  isAbsolute(commonDir.stdout) ? commonDir.stdout : resolve(commonDir.stdout),
  "hooks",
);

mkdirSync(hooksDir, { recursive: true });
copyFileSync(join(ROOT, ".githooks", "pre-commit"), join(hooksDir, "pre-commit"));
chmodSync(join(hooksDir, "pre-commit"), 0o755);
