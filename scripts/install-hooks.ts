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
 * Ordering invariant: every abort condition is checked BEFORE anything is
 * mutated, so a refused install leaves the previous hook wiring fully
 * intact - never a state where husky is unwired but the dispatcher is not
 * yet installed. The install never destroys what it does not own: only the
 * known husky hooksPath is migrated, any other value in any scope aborts,
 * and a pre-existing hooks/pre-commit (file, symlink, or anything else) not
 * written by this script is left untouched.
 *
 * Outside a git repository (an exported tarball, say) there is nothing to
 * wire, and installs must not fail there - but a directory that HAS a .git
 * entry which git cannot read is a broken checkout, not a tarball, and
 * skipping it would recreate the silent no-hook state.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function fail(message: string): never {
  console.error(`install-hooks: ${message}`);
  process.exit(1);
}

/** Untrimmed, line-exact output values: only the OUTPUT TERMINATOR (the
 * empty element a trailing newline leaves after split) is dropped - an empty
 * line before it is a real, EMPTY configuration value and must be judged
 * like any other. Trimming would launder " .husky/_" into the recognized
 * form. */
function lines(raw: string): string[] {
  const result = raw.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

// --- Checks: nothing below this line mutates anything until they all pass.

if (git("rev-parse", "--git-dir").code !== 0) {
  // No repository is fine (tarball install); a .git entry git cannot read
  // is a broken checkout and must not silently end up hook-less.
  if (statSync(join(process.cwd(), ".git"), { throwIfNoEntry: false })) {
    fail(
      "a .git entry exists but git cannot read the repository; fix the checkout, then rerun 'bun install'.",
    );
  }
  console.error("install-hooks: not inside a git repository; skipping hook installation.");
  process.exit(0);
}

// Local hooksPath: only the known husky shapes are ours to migrate - the
// exact relative ".husky/_" or an ABSOLUTE path ending "/.husky/_" (husky
// writes both). Anything else, including an empty value, is someone's
// intentional configuration and aborts.
const local = git("config", "--local", "--get-all", "core.hooksPath");
if (local.code !== 0 && local.code !== 1) {
  fail(`could not read local core.hooksPath (git exited ${local.code}).`);
}
const localValues = local.code === 0 ? lines(local.raw) : [];
const isHusky = (value: string) =>
  value === ".husky/_" || (isAbsolute(value) && value.endsWith("/.husky/_"));
if (local.code === 0 && (localValues.length === 0 || !localValues.every(isHusky))) {
  fail(
    `local core.hooksPath is set to something this repo did not write:\n  ${localValues.join("\n  ")}\n` +
      "Migrate it yourself (git config --local --unset-all core.hooksPath), then rerun 'bun install'.",
  );
}

// hooksPath in any OTHER scope (global/system/include/worktree) aborts, and
// it aborts BEFORE the local unset: the default hooks directory would be
// shadowed at commit time, and writing into the configured location could
// clobber a user-wide hook. Exit 1 is "no such key"; anything above it is an
// unreadable configuration, which fails closed instead of reading as unset.
const scoped = git("config", "--show-scope", "--get-all", "core.hooksPath");
if (scoped.code !== 0 && scoped.code !== 1) {
  fail(`could not enumerate core.hooksPath scopes (git exited ${scoped.code}).`);
}
const outer = (scoped.code === 0 ? lines(scoped.raw) : []).filter(
  (line) => !line.startsWith("local\t"),
);
if (outer.length > 0) {
  fail(
    `core.hooksPath is still set outside the repository scope:\n  ${outer.join("\n  ")}\n` +
      "Remove it (git config --unset in that scope), then rerun 'bun install'.",
  );
}

// The common hooks directory, resolved independently of configuration
// (`--git-path hooks` would honor a hooksPath; `--git-common-dir` cannot).
const commonDir = git("rev-parse", "--git-common-dir");
if (commonDir.code !== 0) {
  fail(`could not resolve the common git directory (git exited ${commonDir.code}).`);
}
const hooksDir = join(
  isAbsolute(commonDir.stdout) ? commonDir.stdout : resolve(commonDir.stdout),
  "hooks",
);
const target = join(hooksDir, "pre-commit");

// Overwrite only our own previous installs (recognized by the dispatcher's
// self-description). lstat, not stat: a symlink here - even a dangling one -
// is someone else's wiring, and following it would judge (and later write)
// a file OUTSIDE the hooks directory.
const existing = lstatSync(target, { throwIfNoEntry: false });
if (existing && !existing.isFile()) {
  fail(
    `${target} exists and is not a regular file (symlink or otherwise); refusing to touch it.\n` +
      "Move it aside (or merge it into .githooks/pre-commit.mts), then rerun 'bun install'.",
  );
}
if (existing?.isFile() && !readFileSync(target, "utf-8").includes("scripts/install-hooks.ts")) {
  fail(
    `${target} already exists and was not installed by this repo; refusing to overwrite it.\n` +
      "Move it aside (or merge it into .githooks/pre-commit.mts), then rerun 'bun install'.",
  );
}

// --- Mutations: every abort condition has passed.

if (local.code === 0) {
  const unset = git("config", "--local", "--unset-all", "core.hooksPath");
  if (unset.code !== 0) {
    fail(`could not remove the husky core.hooksPath (git exited ${unset.code}).`);
  }
}

// Atomic replacement: a plain copy TRUNCATES the live shared hook first, so
// a commit racing the install would execute an empty file and pass
// unchecked. Write-then-rename swaps complete content for complete content.
mkdirSync(hooksDir, { recursive: true });
const staging = join(hooksDir, `.pre-commit.installing.${process.pid}`);
try {
  writeFileSync(staging, readFileSync(join(ROOT, ".githooks", "pre-commit")));
  chmodSync(staging, 0o755);
  renameSync(staging, target);
} finally {
  rmSync(staging, { force: true });
}
