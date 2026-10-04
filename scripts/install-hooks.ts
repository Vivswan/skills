#!/usr/bin/env bun
/**
 * Wire the git-native pre-commit hook; runs as the package "prepare" script on every `bun install`.
 *
 * The dispatcher (.githooks/pre-commit) is COPIED into the common hooks directory, shared by every
 * linked worktree, instead of setting core.hooksPath, because a checkout-relative hooksPath fails
 * open in a checkout that lacks the directory (a sibling worktree on an older branch, or this one
 * after switching to such a branch):
 *   core.hooksPath     -> NO hook runs there, silently
 *   copied dispatcher  -> refuses the commit there, since the checkout carries no hook logic
 *
 * Every precondition is checked before anything is mutated, so a refused install leaves the previous
 * wiring intact. The mutations publish the dispatcher first and unwire husky last, so no failure in
 * either step, or in the re-read after the unset, leaves fewer commits checked than before.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ROOT } from "./lib";

// git here sees NO GIT_* variable: the hooksPath checks below must read the configuration an
// unmasked `git commit` will read, and several GIT_* variables redirect that read transiently. The
// whole prefix is scrubbed rather than a blocklist, since a blocklist loses one new variable at a time.
// Inherited unscrubbed, each of these would bend those checks:
//   GIT_CONFIG_GLOBAL=/dev/null bun install           -> the check passes, dispatcher shadowed at every later commit
//   GIT_DIR, GIT_CONFIG, GIT_CONFIG_COUNT/KEY_n/VALUE_n -> another repository, another file, injected entries
// Tests isolate the global scope through HOME/XDG_CONFIG_HOME instead, which git reads unmasked.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (key.toUpperCase().startsWith("GIT_")) continue;
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

/** Value-exact splitting of `git config -z` output: values are
 * NUL-terminated, and NUL - unlike newline - can never appear inside a
 * config value, so a value CONTAINING a newline arrives as one entry instead
 * of laundering into two plausible-looking lines. Only the output
 * terminator's trailing empty element is dropped - an empty value is a real,
 * EMPTY configuration value and must be judged like any other. */
function nulValues(raw: string): string[] {
  const result = raw.split("\0");
  if (result.at(-1) === "") result.pop();
  return result;
}

// --- Checks: nothing below this line mutates anything until they all pass.

if (git("rev-parse", "--git-dir").code !== 0) {
  // No repository is fine (tarball install); a .git entry git cannot read
  // is a broken checkout and must not silently end up hook-less. lstat, not
  // stat: a DANGLING .git symlink is such a broken entry, and stat would
  // follow it into "no entry here".
  if (lstatSync(join(process.cwd(), ".git"), { throwIfNoEntry: false })) {
    fail(
      "a .git entry exists but git cannot read the repository; fix the checkout, then rerun 'bun install'.",
    );
  }
  console.error("install-hooks: not inside a git repository; skipping hook installation.");
  process.exit(0);
}

// Discovery also succeeds from a package directory merely NESTED inside an
// unrelated repository (a tarball or git-dependency install of this package
// into a consumer project); installing there would write the dispatcher
// into the consumer's hooks directory. Proceed only when the repository's
// top level IS this working directory - a mismatch (or a bare repository,
// where --show-toplevel fails) takes the skip path. realpath both sides:
// macOS tempdirs reach the same directory through /var and /private/var.
const toplevel = git("rev-parse", "--show-toplevel");
if (toplevel.code !== 0 || realpathSync(toplevel.stdout) !== realpathSync(process.cwd())) {
  console.error(
    "install-hooks: this directory is not the repository's top level (nested install?); skipping hook installation.",
  );
  process.exit(0);
}

// Local hooksPath: only the known husky shapes are ours to migrate - the
// exact relative ".husky/_" or an ABSOLUTE path ending "/.husky/_" (husky
// writes both). Anything else, including an empty value, is someone's
// intentional configuration and aborts. --includes: scoped reads skip
// include.path files by default, but commit-time git follows them, so an
// included foreign hooksPath would otherwise slip past validation (the
// all-scope check below labels included values "local" too, which this
// validation must therefore cover).
const local = git("config", "-z", "--local", "--includes", "--get-all", "core.hooksPath");
if (local.code !== 0 && local.code !== 1) {
  fail(`could not read local core.hooksPath (git exited ${local.code}).`);
}
const localValues = local.code === 0 ? nulValues(local.raw) : [];
const isHusky = (value: string) =>
  value === ".husky/_" || (isAbsolute(value) && value.endsWith("/.husky/_"));
if (local.code === 0 && (localValues.length === 0 || !localValues.every(isHusky))) {
  fail(
    `local core.hooksPath is set to something this repo did not write:\n  ${localValues.map((value) => JSON.stringify(value)).join("\n  ")}\n` +
      "Migrate it yourself (git config --local --unset-all core.hooksPath), then rerun 'bun install'.",
  );
}

// hooksPath in any OTHER scope (global/system/include/worktree) aborts, and
// it aborts BEFORE the local unset: the default hooks directory would be
// shadowed at commit time, and writing into the configured location could
// clobber a user-wide hook. Exit 1 is "no such key"; anything above it is an
// unreadable configuration, which fails closed instead of reading as unset.
const scoped = git("config", "-z", "--show-scope", "--get-all", "core.hooksPath");
if (scoped.code !== 0 && scoped.code !== 1) {
  fail(`could not enumerate core.hooksPath scopes (git exited ${scoped.code}).`);
}
// With -z, --show-scope emits alternating NUL-terminated fields: scope,
// value, scope, value... An unpaired field means the output shape changed;
// fail closed rather than guess which field is which.
const scopedFields = scoped.code === 0 ? nulValues(scoped.raw) : [];
if (scopedFields.length % 2 !== 0) {
  fail("could not parse core.hooksPath scopes (unpaired scope/value fields from git config -z).");
}
const outer: string[] = [];
for (let i = 0; i < scopedFields.length; i += 2) {
  const scope = scopedFields[i] as string;
  const value = scopedFields[i + 1] as string;
  if (scope !== "local") outer.push(`${scope}\t${JSON.stringify(value)}`);
}
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

// Overwrite only our own previous installs, recognized by the dispatcher's
// managed-by marker: the COMPLETE line, matched as a whole line - neither a
// mention of this script's path nor a quotation of the marker inside some
// other line is ownership (a user hook that invokes or documents this
// machinery must survive). The source is self-checked for the marker so the
// two cannot drift apart. lstat, not stat: a symlink here - even a dangling
// one - is someone else's wiring, and following it would judge (and later
// write) a file OUTSIDE the hooks directory.
const MARKER =
  "# managed-by: Vivswan/skills scripts/install-hooks.ts - do not edit the installed copy";
const hasMarkerLine = (content: string) => content.split("\n").includes(MARKER);
const dispatcherSource = readFileSync(join(ROOT, ".githooks", "pre-commit"), "utf-8");
if (!hasMarkerLine(dispatcherSource)) {
  fail(".githooks/pre-commit lost its managed-by marker line; restore it before installing.");
}
const existing = lstatSync(target, { throwIfNoEntry: false });
if (existing && !existing.isFile()) {
  fail(
    `${target} exists and is not a regular file (symlink or otherwise); refusing to touch it.\n` +
      "Move it aside (or merge it into .githooks/pre-commit.mts), then rerun 'bun install'.",
  );
}
if (existing?.isFile() && !hasMarkerLine(readFileSync(target, "utf-8"))) {
  fail(
    `${target} already exists and was not installed by this repo; refusing to overwrite it.\n` +
      "Move it aside (or merge it into .githooks/pre-commit.mts), then rerun 'bun install'.",
  );
}

// --- Mutations: every abort condition has passed. Publish first, unwire
// last: if any installation step fails (read-only hooks dir, full disk),
// the husky hooksPath is still in place and commits stay checked - never a
// state with husky unwired and no dispatcher installed. Until the unset
// lands, the freshly installed dispatcher is merely shadowed by husky.

// Atomic replacement: a plain copy TRUNCATES the live shared hook first, so
// a commit racing the install would execute an empty file and pass
// unchecked. Write-then-rename swaps complete content for complete content.
mkdirSync(hooksDir, { recursive: true });
const staging = join(hooksDir, `.pre-commit.installing.${process.pid}`);
try {
  // Exclusive create ("wx") after clearing any stale entry: writing through
  // a pre-positioned symlink at the staging path would land the content
  // outside the hooks directory before the rename.
  rmSync(staging, { force: true });
  writeFileSync(staging, dispatcherSource, { flag: "wx" });
  chmodSync(staging, 0o755);
  renameSync(staging, target);
} finally {
  rmSync(staging, { force: true });
}

if (local.code === 0) {
  const unset = git("config", "--local", "--unset-all", "core.hooksPath");
  // Exit 5 is "nothing to unset": every husky value came in through an
  // include, which the unset cannot touch; the verification below reports it.
  if (unset.code !== 0 && unset.code !== 5) {
    fail(`could not remove the husky core.hooksPath (git exited ${unset.code}).`);
  }
  // Verify-after-mutate: a husky value living in an include.path file
  // survives --unset-all (which edits only the main local file), and with a
  // direct value alongside it the unset even exits 0 - the one state the
  // pre-checks cannot rule out. The dispatcher is already published, so
  // failing here leaves the surviving husky path wired and commits checked.
  const remaining = git("config", "-z", "--local", "--includes", "--get-all", "core.hooksPath");
  if (remaining.code !== 1) {
    fail(
      `core.hooksPath still resolves in the local scope after migration (an include.path file?):\n  ${nulValues(
        remaining.raw,
      )
        .map((value) => JSON.stringify(value))
        .join("\n  ")}\nRemove it from the included file, then rerun 'bun install'.`,
    );
  }
}
