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
 * refuses the commit when the checkout carries no hook logic.
 *
 * The install never destroys configuration or hooks it does not own: only
 * the known husky hooksPath is migrated away, any other local value or any
 * value in an outer scope (global, system, include, worktree) aborts the
 * install loudly, and a pre-existing hooks/pre-commit file not written by
 * this script is left untouched (also aborting the install).
 *
 * Outside a git repository (an exported tarball, say) there is nothing to
 * wire, and installs must not fail there.
 */

import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ROOT } from "./lib";

// The repository is the one containing the working directory (`bun install`
// runs prepare at the package root); the dispatcher source always comes from
// this checkout. git spawns get a minimal GIT_* surface: EVERY GIT_*
// variable is dropped except the two real-config file selectors, which the
// survivor check must see (and which tests inject fixtures through).
// Unknown GIT_* variables default to scrubbed (fail-safe), not inherited
// (fail-open): an inherited GIT_CONFIG once blinded the survivor check by
// retargeting `git config` at an arbitrary file, GIT_CONFIG_NOSYSTEM could
// hide a system hooksPath, GIT_CONFIG_COUNT/KEY_n/VALUE_n and
// GIT_CONFIG_PARAMETERS inject transient entries, GIT_DIR redirects the
// repository itself - a blocklist loses this game one variable at a time.
const KEEP = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  const upper = key.toUpperCase();
  if (upper.startsWith("GIT_") && !KEEP.has(upper)) continue;
  env[key] = value;
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const raw = result.stdout.toString();
  return { code: result.exitCode, stdout: raw.trim(), raw };
}

if (git("rev-parse", "--git-dir").code !== 0) {
  console.error("install-hooks: not inside a git repository; skipping hook installation.");
  process.exit(0);
}

// Migrate ONLY the known husky hooksPath (".husky/_", relative or absolute).
// Any other local value is someone's intentional configuration: abort
// instead of silently deleting it. The edit is pinned to the LOCAL scope so
// no environment or option can retarget it.
const local = git("config", "--local", "--get-all", "core.hooksPath");
if (local.code === 0) {
  // Untrimmed, line-exact values: trimming would launder " .husky/_" into
  // the recognized form, and only the OUTPUT TERMINATOR is dropped - an
  // empty line before it is a real, EMPTY hooksPath value, which is not
  // husky's and must abort like any other foreign value (filtering all
  // empties would let it pass the every() vacuously and be deleted).
  const values = local.raw.split("\n");
  if (values.at(-1) === "") values.pop();
  const isHusky = (value: string) =>
    value === ".husky/_" || (isAbsolute(value) && value.endsWith("/.husky/_"));
  if (values.length === 0 || !values.every(isHusky)) {
    console.error(
      `install-hooks: local core.hooksPath is set to something this repo did not write:\n  ${values.join("\n  ")}\n` +
        "Migrate it yourself (git config --local --unset-all core.hooksPath), then rerun 'bun install'.",
    );
    process.exit(1);
  }
  const unset = git("config", "--local", "--unset-all", "core.hooksPath");
  if (unset.code !== 0) {
    console.error(
      `install-hooks: could not remove the husky core.hooksPath (git exited ${unset.code}).`,
    );
    process.exit(1);
  }
} else if (local.code !== 1) {
  console.error(`install-hooks: could not read local core.hooksPath (git exited ${local.code}).`);
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
const target = join(hooksDir, "pre-commit");

// Overwrite only our own previous installs (recognized by the dispatcher's
// self-description); a pre-existing hook this script did not write is
// user- or tool-managed and must not be destroyed.
const existing = statSync(target, { throwIfNoEntry: false })?.isFile()
  ? readFileSync(target, "utf-8")
  : undefined;
if (existing !== undefined && !existing.includes("scripts/install-hooks.ts")) {
  console.error(
    `install-hooks: ${target} already exists and was not installed by this repo; refusing to overwrite it.\n` +
      "Move it aside (or merge it into .githooks/pre-commit.mts), then rerun 'bun install'.",
  );
  process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });
copyFileSync(join(ROOT, ".githooks", "pre-commit"), target);
chmodSync(target, 0o755);
