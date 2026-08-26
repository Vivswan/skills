#!/usr/bin/env bun
/**
 * baseline.mts - pinned-content snapshots for landing verification.
 *
 * Replaces hand-minted substring tokens (which go falsely red when a reflow
 * splits a token across lines or a locale words things differently, and
 * falsely green when a bad merge resurrects a deleted line) with exact pinned
 * copies compared via `git diff --no-index`, so every change is a visible
 * diff instead of a bare count.
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
 *
 * Zero npm dependencies: node builtins only, run with bun.
 */

import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = "manifest.json";
const CONTENT_DIR = "content";

const USAGE = [
  "usage:",
  "  baseline pin <baseline-dir> <tree-root> <file...>",
  "      Copy the exact current content of each file (paths relative to",
  "      tree-root) into baseline-dir, preserving relative paths, and write",
  "      a manifest.json listing the pinned set. If anything fails, the",
  "      previous baseline is left untouched and every file is reported as",
  "      pinned or not.",
  "  baseline check <baseline-dir> <tree-root>",
  "      Compare every manifest entry against the tree via git diff",
  "      --no-index. Reports per file: identical | drifted (with the diff)",
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
  if (path.split("/").includes("..")) return "path traversal via '..'";
  return null;
}

interface DiffResult {
  readonly identical: boolean;
  readonly diff: string;
}

/**
 * Environment for the git call with every GIT_* variable dropped and config
 * files disabled: an inherited GIT_EXTERNAL_DIFF or a diff.external setting
 * could silently corrupt the diff, and this tool's product is trustworthy
 * verification. The prefix match is case-insensitive because Windows
 * environment names are (git_config_count would otherwise survive and Git
 * would honor it there).
 */
export function scrubbedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

async function gitDiffNoIndex(baselineFile: string, treeFile: string): Promise<DiffResult> {
  try {
    await execFileAsync(
      "git",
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", baselineFile, treeFile],
      { maxBuffer: 64 * 1024 * 1024, env: scrubbedGitEnv() },
    );
    return { identical: true, diff: "" };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    // git diff exits 1 when the files differ; that is the drift signal,
    // not an operational failure.
    if (failure.code === 1 && typeof failure.stdout === "string") {
      return { identical: false, diff: failure.stdout };
    }
    throw new Error(
      `git diff --no-index failed for ${baselineFile} vs ${treeFile}: ` +
        `${failure.stderr ?? String(error)}`,
    );
  }
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

function pin(baselineDir: string, treeRoot: string, files: readonly string[]): number {
  // A tree root at or under the baseline dir would let the install step
  // delete the very tree being pinned; refuse before any mutation.
  if (relativeStaysWithin(relative(canonicalize(baselineDir), canonicalize(treeRoot)))) {
    usageError(`tree-root ${treeRoot} must not be inside baseline-dir ${baselineDir}`);
  }
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

async function check(baselineDir: string, treeRoot: string): Promise<number> {
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
      // Dereference both sides: pin snapshots the CONTENT a symlink points
      // at, but git diff --no-index compares the link value itself (mode
      // 120000), which would false-drift every symlinked tree file.
      const result = await gitDiffNoIndex(realpathSync(baselineFile), realpathSync(treeFile));
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

async function main(): Promise<number> {
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
    process.exitCode = await main();
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
