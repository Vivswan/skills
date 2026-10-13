#!/usr/bin/env bun
/**
 * baseline.mts - pinned-content snapshots for landing verification.
 *
 * Replaces hand-minted substring tokens (which go falsely red when a reflow
 * splits a token across lines or a locale words things differently, and
 * falsely green when a bad merge resurrects a deleted line) with exact pinned
 * copies compared byte for byte and rendered as a unified diff, so every
 * change is a visible diff instead of a bare count.
 *
 * Usage:
 *   baseline pin <baseline-dir> <tree-root> <file...>
 *   baseline check <baseline-dir> <tree-root>
 *
 * stdout: one JSON summary object. stderr: human-readable findings + diffs.
 * Exit 0 = clean, 1 = drift found or ok:false, 2 = usage error.
 *
 * Baseline layout: <baseline-dir>/manifest.json plus exact copies under
 * <baseline-dir>/content/<relative-path>, so a pinned file named
 * manifest.json can never collide with the manifest itself.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

// --- Self-build: run as source, bundle into <skill>/.build/ and run the bundle; run as the bundle, do nothing.
// docs/authoring.md > Dependencies owns this block; the smoke test keeps every copy identical.

function buildPaths(source: string) {
  const scripts = dirname(source);
  const skill = dirname(scripts);
  const built = join(skill, ".build", `${basename(source, ".mts")}.js`);
  return { scripts, skill, built };
}

function buildIsStale(scripts: string, skill: string, built: string): boolean {
  if (!existsSync(built)) return true;
  // An entry imports its siblings, and a pin bump changes the bundle, so every script and the manifest count.
  const inputs = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mts"))
    .map((name) => join(scripts, name));
  inputs.push(join(skill, "package.json"));
  const newest = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  return statSync(built).mtimeMs < newest;
}

function runBun(args: string[]): boolean {
  const step = spawnSync("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.status !== 0) process.stderr.write(step.stderr);
  return step.status === 0;
}

function build(source: string, skill: string, built: string): void {
  // bun build resolves installed packages only: install the pins for the build's duration, then remove them.
  const ok =
    runBun(["install", "--production", "--no-save", "--cwd", skill]) &&
    runBun(["build", source, "--target", "bun", "--outfile", built]);
  rmSync(join(skill, "node_modules"), { recursive: true, force: true });
  if (!ok) process.exit(2);
}

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built)) build(source, skill, built);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

const MANIFEST_NAME = "manifest.json";
const CONTENT_DIR = "content";
// The verdict is the byte comparison; the unified diff only renders it. jsdiff's line diff is quadratic
// in the changed lines (5,000 lines rewritten end to end: about 8 s; 10,000: over 30 s), so without a
// bound a regenerated large file stalls the check for minutes. Past it the finding stays drifted and
// says the diff was abandoned.
const DIFF_TIMEOUT_MS = 10_000;

const USAGE = [
  "usage:",
  "  baseline pin <baseline-dir> <tree-root> <file...>",
  "      Copy the exact current content of each file (paths relative to",
  "      tree-root) into baseline-dir, preserving relative paths, and write",
  "      a manifest.json listing the pinned set. If anything fails, the",
  "      previous baseline is left untouched and every file is reported as",
  "      pinned or not.",
  "  baseline check <baseline-dir> <tree-root>",
  "      Compare every manifest entry against the tree byte for byte.",
  "      Reports per file: identical | drifted (with the unified diff)",
  "      | missing-in-tree | missing-baseline. Exits 1 unless all identical.",
].join("\n");

/** CLI misuse (bad subcommand, arity, or file argument). Rendered as exit 2. */
class UsageError extends Error {}

function usageError(message: string): never {
  throw new UsageError(message);
}

function emitSummary(summary: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a path cannot be used relative to a root, or null if it is fine.
 * Rejects anything that could resolve outside the root (absolute paths,
 * ..-traversal), so pin and check only ever touch the directories they
 * were given.
 */
function relPathProblem(path: string): string | null {
  if (path === "") return "empty path";
  if (isAbsolute(path)) return "absolute path (must be relative to the root)";
  if (path.includes("\\")) return "backslash in path (use '/' separators)";
  // Windows drive-relative form: not absolute, no backslash, no "..", yet
  // resolve() sends it to the drive's working directory outside the root.
  if (/^[A-Za-z]:/.test(path)) return "drive-prefixed path (must be relative to the root)";
  if (path.split("/").includes("..")) return "path traversal via '..'";
  return null;
}

interface DiffResult {
  readonly identical: boolean;
  readonly diff: string;
}

// git's own text-or-binary rule (buffer_is_binary): a NUL within the first 8000 bytes. Decoding validity
// is not the rule, so a Latin-1 file still renders as a patch and a NUL-bearing pair never does.
const BINARY_PROBE_BYTES = 8000;
// ignoreBOM keeps a leading U+FEFF in the string: the default strips it, and a pinned copy that differs
// from the tree only by its BOM would then render as a drift with an empty diff.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/**
 * Both sides fall back to latin1 together, never one each: a file re-encoded
 * from Latin-1 to UTF-8 would otherwise decode to equal strings and render
 * a drift with an empty diff.
 */
function decodeTexts(pinned: Buffer, current: Buffer): [string, string] {
  try {
    return [UTF8.decode(pinned), UTF8.decode(current)];
  } catch {
    return [pinned.toString("latin1"), current.toString("latin1")];
  }
}

function compareFiles(baselineFile: string, treeFile: string): DiffResult {
  const pinned = readFileSync(baselineFile);
  const current = readFileSync(treeFile);
  if (pinned.equals(current)) return { identical: true, diff: "" };
  if (isBinary(pinned) || isBinary(current)) {
    return {
      identical: false,
      diff: `binary files differ: ${pinned.length} bytes pinned, ${current.length} bytes in the tree`,
    };
  }
  const [pinnedText, currentText] = decodeTexts(pinned, current);
  const patch = createTwoFilesPatch(
    baselineFile,
    treeFile,
    pinnedText,
    currentText,
    undefined,
    undefined,
    { context: 3, timeout: DIFF_TIMEOUT_MS, headerOptions: FILE_HEADERS_ONLY },
  );
  return {
    identical: false,
    diff:
      patch ??
      `files differ (${pinned.length} bytes pinned, ${current.length} bytes in the tree); ` +
        `the unified diff was abandoned after ${DIFF_TIMEOUT_MS}ms`,
  };
}

interface PinReport {
  readonly path: string;
  readonly pinned: boolean;
  readonly reason: string;
}

function failedPin(
  baselineDir: string,
  treeRoot: string,
  error: string,
  reports: readonly PinReport[],
): number {
  for (const report of reports) note(`not pinned: ${report.path} (${report.reason})`);
  note(`pin failed: ${error}`);
  emitSummary({ ok: false, action: "pin", baselineDir, treeRoot, error, files: reports });
  return 1;
}

/**
 * Canonicalize the deepest existing ancestor of a path (resolving symlinks
 * and on-disk casing), then re-append the not-yet-existing tail. Purely
 * lexical comparison would let a casing variant on a case-insensitive
 * filesystem (or a symlink) dodge the pin containment guard.
 */
function canonicalize(path: string): string {
  let prefix = path;
  let suffix = "";
  for (;;) {
    try {
      return join(realpathSync.native(prefix), suffix);
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) return path;
      suffix = suffix === "" ? basename(prefix) : join(basename(prefix), suffix);
      prefix = parent;
    }
  }
}

/**
 * True when a path.relative(base, target) result means target sits at or
 * below base. relative() emits ".." segments with the host separator, so
 * both "../" and "..\\" parent prefixes must be recognized as escapes.
 */
export function relativeStaysWithin(relPath: string): boolean {
  return (
    relPath === "" ||
    (!isAbsolute(relPath) &&
      relPath !== ".." &&
      !relPath.startsWith("../") &&
      !relPath.startsWith("..\\"))
  );
}

/**
 * Refuse a tree root at or under the baseline dir before doing anything:
 * pin's install step would delete the very tree being pinned, and check
 * would compare pinned files with themselves and report a false clean.
 */
function refuseOverlappingRoots(baselineDir: string, treeRoot: string): void {
  if (relativeStaysWithin(relative(canonicalize(baselineDir), canonicalize(treeRoot)))) {
    usageError(`tree-root ${treeRoot} must not be inside baseline-dir ${baselineDir}`);
  }
}

function pin(baselineDir: string, treeRoot: string, files: readonly string[]): number {
  refuseOverlappingRoots(baselineDir, treeRoot);
  const paths = [...new Set(files)].sort();
  for (const path of paths) {
    const problem = relPathProblem(path);
    if (problem) usageError(`invalid file argument ${JSON.stringify(path)}: ${problem}`);
  }

  // Validate every source before copying anything: a missing or unreadable
  // file must never leave a silently partial baseline behind, and every
  // preflight problem is reported per file.
  const sourceProblems = new Map<string, string>();
  for (const path of paths) {
    const source = resolve(treeRoot, path);
    try {
      if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
        sourceProblems.set(path, `source missing: ${source}`);
      }
    } catch (error) {
      sourceProblems.set(path, `source unreadable: ${source} (${errorMessage(error)})`);
    }
  }
  if (sourceProblems.size > 0) {
    const reports = paths.map((path) => ({
      path,
      pinned: false,
      reason:
        sourceProblems.get(path) ?? "aborted because another source file is missing or unreadable",
    }));
    return failedPin(
      baselineDir,
      treeRoot,
      `unusable source file(s): ${[...sourceProblems.keys()].join(", ")}; nothing was pinned`,
      reports,
    );
  }

  // Stage the whole new baseline in a sibling temp directory and swap it in
  // only once every copy and the manifest have been written. The previous
  // baseline is moved aside (never deleted first), so any failure restores
  // it instead of leaving it half-updated or gone.
  let staging: string | undefined;
  let backup: string | undefined;
  try {
    mkdirSync(dirname(baselineDir), { recursive: true });
    staging = mkdtempSync(`${baselineDir}.pin-staging-`);
    for (const path of paths) {
      const destination = join(staging, CONTENT_DIR, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(treeRoot, path), destination);
    }
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify({ files: paths }, null, 2)}\n`);
    if (statSync(baselineDir, { throwIfNoEntry: false })) {
      const backupPath = `${staging}.previous`;
      renameSync(baselineDir, backupPath);
      backup = backupPath;
    }
    renameSync(staging, baselineDir);
    staging = undefined;
  } catch (error) {
    const problems = [`staging failed, nothing was pinned: ${errorMessage(error)}`];
    if (backup) {
      try {
        renameSync(backup, baselineDir);
      } catch (restoreError) {
        problems.push(
          `restoring the previous baseline failed (${errorMessage(restoreError)}); ` +
            `it is preserved at ${backup}`,
        );
      }
    }
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch (cleanupError) {
        problems.push(`staging dir ${staging} was left behind (${errorMessage(cleanupError)})`);
      }
    }
    const reports = paths.map((path) => ({
      path,
      pinned: false,
      reason: "pin aborted before installing the new baseline; see error",
    }));
    return failedPin(baselineDir, treeRoot, problems.join("; "), reports);
  }
  if (backup) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (cleanupError) {
      // The new baseline is fully installed; a stuck backup is only litter.
      note(
        `warning: could not remove old baseline backup ${backup}: ${errorMessage(cleanupError)}`,
      );
    }
  }

  const reports = paths.map((path) => ({
    path,
    pinned: true,
    reason: `copied from ${resolve(treeRoot, path)}`,
  }));
  for (const report of reports) note(`pinned: ${report.path}`);
  const manifestPath = join(baselineDir, MANIFEST_NAME);
  note(`manifest written: ${manifestPath}`);
  emitSummary({
    ok: true,
    action: "pin",
    baselineDir,
    treeRoot,
    manifest: manifestPath,
    files: reports,
  });
  return 0;
}

type CheckStatus = "identical" | "drifted" | "missing-in-tree" | "missing-baseline";

interface CheckFinding {
  readonly path: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** The manifest's file list, or a string describing why it is unusable. */
function readManifest(baselineDir: string): string[] | string {
  const manifestPath = join(baselineDir, MANIFEST_NAME);
  if (!isFile(manifestPath)) {
    return `no manifest at ${manifestPath}; run \`baseline pin\` first`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    return `unreadable manifest at ${manifestPath}: ${errorMessage(error)}`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `invalid manifest at ${manifestPath}: root must be an object`;
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || !files.every((entry) => typeof entry === "string")) {
    return `invalid manifest at ${manifestPath}: "files" must be an array of strings`;
  }
  if (files.length === 0) {
    return (
      `invalid manifest at ${manifestPath}: "files" is empty; ` +
      "an empty baseline can never prove a tree clean (pin writes at least one file)"
    );
  }
  for (const entry of files) {
    const problem = relPathProblem(entry);
    if (problem) {
      return `invalid manifest at ${manifestPath}: entry ${JSON.stringify(entry)}: ${problem}`;
    }
  }
  return files;
}

function check(baselineDir: string, treeRoot: string): number {
  refuseOverlappingRoots(baselineDir, treeRoot);
  const manifest = readManifest(baselineDir);
  if (typeof manifest === "string") {
    note(`check failed: ${manifest}`);
    emitSummary({ ok: false, action: "check", baselineDir, treeRoot, error: manifest, files: [] });
    return 1;
  }
  const findings: CheckFinding[] = [];
  for (const path of manifest) {
    const baselineFile = join(baselineDir, CONTENT_DIR, path);
    const treeFile = resolve(treeRoot, path);
    if (!isFile(baselineFile)) {
      findings.push({
        path,
        status: "missing-baseline",
        detail:
          `listed in the manifest but the pinned copy at ${baselineFile} is gone` +
          `${isFile(treeFile) ? "" : " (and the tree file is also missing)"}`,
      });
    } else if (!isFile(treeFile)) {
      findings.push({
        path,
        status: "missing-in-tree",
        detail: `pinned at ${baselineFile} but absent from the tree at ${treeFile}`,
      });
    } else {
      // readFileSync follows a symlinked tree file to its target, so the
      // comparison is of the content pin copied, never of the link value.
      const result = compareFiles(baselineFile, treeFile);
      findings.push(
        result.identical
          ? { path, status: "identical", detail: `matches pinned copy at ${baselineFile}` }
          : { path, status: "drifted", detail: result.diff },
      );
    }
  }
  for (const finding of findings) {
    if (finding.status === "drifted") {
      note(`drifted: ${finding.path}`);
      note(finding.detail);
    } else {
      note(`${finding.status}: ${finding.path} (${finding.detail})`);
    }
  }
  const ok = findings.every((finding) => finding.status === "identical");
  emitSummary({ ok, action: "check", baselineDir, treeRoot, files: findings });
  return ok ? 0 : 1;
}

function main(): number {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "pin") {
    const [baselineDir, treeRoot, ...files] = rest;
    if (!baselineDir || !treeRoot || files.length === 0) {
      usageError("pin requires <baseline-dir> <tree-root> <file...>");
    }
    return pin(resolve(baselineDir), resolve(treeRoot), files);
  }
  if (command === "check") {
    const [baselineDir, treeRoot] = rest;
    if (!baselineDir || !treeRoot || rest.length !== 2) {
      usageError("check requires <baseline-dir> <tree-root>");
    }
    return check(resolve(baselineDir), resolve(treeRoot));
  }
  usageError(command ? `unknown subcommand: ${command}` : "missing subcommand");
}

// Set exitCode instead of calling process.exit() so stdout/stderr always
// drain fully before the process ends, even for very large diffs. Guarded so
// importing the exported helpers (unit tests) runs nothing.
if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof UsageError) {
      note(`error: ${error.message}`);
      note(USAGE);
      emitSummary({ ok: false, error: `usage error: ${error.message}` });
      process.exitCode = 2;
    } else {
      const message = errorMessage(error);
      note(`baseline: unexpected failure: ${message}`);
      emitSummary({ ok: false, error: `unexpected failure: ${message}` });
      process.exitCode = 1;
    }
  }
}
