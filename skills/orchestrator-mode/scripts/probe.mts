#!/usr/bin/env bun
// Structured probe tool for fleet monitoring. Every result is either
// evidence-bearing or a loud error - never a bare number. A broken
// measurement (missing file, vanished worktree, bad table) must be
// impossible to mistake for a genuine pass, so probed paths are
// existence-validated before any zero is trusted, counts always carry
// the matched lines, and change sets union committed and dirty paths.
//
// Run with bun; node builtins only, no npm dependencies.
//
// Subcommands (one JSON object to stdout; exit 0 = ok, 1 = failed
// check or broken probe, 2 = usage):
//   probe count <file> <literal>
//   probe json-keys <file> [<other-file>]
//   probe set <repo-root> <base-ref>
//   probe tokens <table.json> <tree-root>

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

const USAGE = [
  "usage: probe <subcommand> ...",
  "  probe count <file> <literal>        count lines containing the literal, with evidence",
  "  probe json-keys <file> [<file2>]    parsed key paths; with two files, the key-set diff",
  "  probe set <repo-root> <base-ref>    changed files: committed (base..HEAD) + dirty union",
  "  probe tokens <table.json> <root>    run a token table against a tree",
].join("\n");

function emit(result: Record<string, unknown>, code: number): never {
  // process.stdout.write buffers asynchronously to pipes and process.exit
  // can truncate it mid-flush, mangling large evidence payloads into invalid
  // JSON. writeFileSync to fd 1 flushes fully before the exit.
  writeFileSync(1, `${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

function fail(error: string): never {
  emit({ ok: false, error }, 1);
}

function usage(error: string): never {
  emit({ ok: false, error: `${error}\n${USAGE}` }, 2);
}

// Only a genuinely absent path may read as missing. Permission errors,
// symlink loops, and broken parent components are broken measurements, not
// absent files - the errno must survive into the report so the two states
// stay distinguishable. The return type is Stats, not
// ReturnType<typeof statSync>: the latter includes undefined via the
// throwIfNoEntry overload and fails strict checks at every caller.
function statOrFail(path: string, missingMessage: string): Stats {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(`${path}: ${missingMessage}`);
    }
    fail(`${path}: stat failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Read a path that must be a regular file without ever blocking: a FIFO at
// the path would hang readFileSync forever, and a probe that never returns
// is as silent as one that reads 0. O_NONBLOCK makes the open itself
// non-blocking, and fstat on the fd classifies what was ACTUALLY opened,
// closing the stat-then-open race (O_NONBLOCK is a no-op for regular
// files, so the read is unaffected). Throws on open failure; `label` names
// the path in the not-a-regular-file report.
function readRegularFile(path: string, label: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) {
      fail(`${label}: not a regular file`);
    }
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

function readRequiredFile(path: string): string {
  try {
    return readRegularFile(path, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(`${path}: no such file`);
    }
    fail(`${path}: unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- fixed-string matching with token boundaries ---------------------------
//
// The literal is a fixed string (never a regex), but a raw substring test
// reproduces the longer-sibling trap: "release.yml" inside
// "update-release.yml" reads as a hit and reports false drift on a correct
// landing. So a match only counts when it is not embedded in a longer
// word/filename token. Word characters are [A-Za-z0-9_-]; a dot embeds only
// when it connects the match to another word character (".yml" style), so a
// sentence-final dot stays a boundary and cannot produce a false zero on
// prose.

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_-]/.test(c);
}

function embedsBefore(line: string, start: number, literal: string): boolean {
  const edge = literal[0];
  const prev = line[start - 1];
  if (isWordChar(edge)) {
    return isWordChar(prev) || (prev === "." && isWordChar(line[start - 2]));
  }
  if (edge === ".") {
    return isWordChar(prev);
  }
  return false;
}

function embedsAfter(line: string, end: number, literal: string): boolean {
  const edge = literal[literal.length - 1];
  const next = line[end];
  if (isWordChar(edge)) {
    return isWordChar(next) || (next === "." && isWordChar(line[end + 1]));
  }
  if (edge === ".") {
    return isWordChar(next);
  }
  return false;
}

function lineHasAnchoredMatch(line: string, literal: string): boolean {
  let from = 0;
  while (true) {
    const at = line.indexOf(literal, from);
    if (at === -1) {
      return false;
    }
    if (!embedsBefore(line, at, literal) && !embedsAfter(line, at + literal.length, literal)) {
      return true;
    }
    from = at + 1;
  }
}

interface Evidence {
  line: number;
  text: string;
}

function countMatchingLines(
  content: string,
  literal: string,
): { value: number; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text !== undefined && lineHasAnchoredMatch(text, literal)) {
      evidence.push({ line: i + 1, text });
    }
  }
  // The count IS the evidence: value === evidence.length by construction,
  // so a number can never travel without the lines that back it.
  return { value: evidence.length, evidence };
}

// --- count ------------------------------------------------------------------

function cmdCount(file: string, literal: string): never {
  if (literal.length === 0) {
    usage("count: literal must be non-empty");
  }
  const content = readRequiredFile(file);
  const { value, evidence } = countMatchingLines(content, literal);
  emit({ ok: true, file, literal, value, evidence }, 0);
}

// --- json-keys ----------------------------------------------------------------

// A plain key uses dot notation; any other key is bracket-quoted so that an
// object key that LOOKS like a path segment ("a[0]", "a.b") can never
// collide with a real array index or nested key and mask a key-set diff.
const PLAIN_KEY = /^[A-Za-z0-9_$-]+$/;

function childPath(prefix: string, key: string): string {
  if (PLAIN_KEY.test(key)) {
    return prefix === "" ? key : `${prefix}.${key}`;
  }
  return `${prefix}[${JSON.stringify(key)}]`;
}

function collectKeyPaths(node: unknown, prefix: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const path = `${prefix}[${i}]`;
      out.push(path);
      collectKeyPaths(node[i], path, out);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      const path = childPath(prefix, key);
      out.push(path);
      collectKeyPaths(child, path, out);
    }
  }
}

function parseKeyPaths(file: string): string[] {
  const raw = readRequiredFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const paths: string[] = [];
  collectKeyPaths(parsed, "", paths);
  return paths.sort();
}

function cmdJsonKeys(file: string, other: string | undefined): never {
  const first = parseKeyPaths(file);
  if (other === undefined) {
    emit({ ok: true, file, value: first }, 0);
  }
  const second = parseKeyPaths(other);
  const firstSet = new Set(first);
  const secondSet = new Set(second);
  const onlyInFirst = first.filter((k) => !secondSet.has(k));
  const onlyInSecond = second.filter((k) => !firstSet.has(k));
  const ok = onlyInFirst.length === 0 && onlyInSecond.length === 0;
  emit(
    {
      ok,
      value: {
        first: { file, keyCount: first.length },
        second: { file: other, keyCount: second.length },
        onlyInFirst,
        onlyInSecond,
      },
    },
    ok ? 0 : 1,
  );
}

// --- set ---------------------------------------------------------------------

function git(root: string, args: string[]): { stdout: string; stderr: string } {
  // The probe targets exactly the repo named by <repo-root> and must measure
  // it identically regardless of the caller's git context. Hooks and nested
  // git operations export repo-local GIT_* vars - including internal ones
  // outside the documented `git rev-parse --local-env-vars` set, such as
  // GIT_INTERNAL_SUPER_PREFIX - that would redirect or break the
  // measurement, and user/system config can reshape output. Strip ALL GIT_*
  // and pin config to /dev/null; every behavior the probe depends on is
  // requested by explicit flags instead.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", env });
  if (result.error) {
    fail(`git ${args.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed in ${root}: ${result.stderr.trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function splitNul(raw: string): string[] {
  return raw.split("\0").filter((entry) => entry.length > 0);
}

// `git status --porcelain -z` emits `XY <path>` records; rename/copy records
// (index-side "R "/"C " or worktree-side " R"/" C") carry the origin path as
// an extra NUL-terminated field, which must be consumed as part of the same
// record or every following path is misread.
function parsePorcelain(raw: string): string[] {
  const records = raw.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.length === 0) {
      continue;
    }
    const xy = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/.test(xy)) {
      i += 1;
      const origin = records[i];
      if (origin !== undefined && origin.length > 0) {
        paths.push(origin);
      }
    }
  }
  return paths;
}

function cmdSet(root: string, baseRef: string): never {
  const stats = statOrFail(root, "no such directory");
  if (!stats.isDirectory()) {
    fail(`${root}: not a directory`);
  }
  // A check reading only one of these goes blind: committed files leave the
  // dirty set, dirty files are invisible to the diff. The value is the union.
  // --no-renames keeps BOTH endpoints of a committed rename in the set (with
  // rename detection the origin path silently disappears), and pinning HEAD
  // before the diff and re-reading it after the status makes a commit landing
  // mid-measurement a loud error instead of a silently incomplete set.
  const headBefore = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const committed = splitNul(
    git(root, ["diff", "--name-only", "--no-renames", "-z", `${baseRef}..${headBefore}`]).stdout,
  );
  // status flags keep the dirty set complete and configuration-independent:
  // --untracked-files=all stops git from collapsing nested untracked files
  // to "dir/" (or omitting them under status.showUntrackedFiles=no), and
  // --no-renames stops copy/rename detection from listing an UNCHANGED
  // source file as dirty; raw add/delete pairs keep both endpoints anyway.
  const dirty = parsePorcelain(
    git(root, ["status", "--porcelain", "--untracked-files=all", "--no-renames", "-z"]).stdout,
  );
  const headAfter = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  if (headBefore !== headAfter) {
    fail(`${root}: HEAD moved during measurement (${headBefore} -> ${headAfter}); re-run`);
  }
  const union = [...new Set([...committed, ...dirty])].sort();
  emit(
    {
      ok: true,
      value: union,
      sources: { committed: [...new Set(committed)].sort(), dirty: [...new Set(dirty)].sort() },
    },
    0,
  );
}

// --- tokens --------------------------------------------------------------------

type Expectation = ">=1" | number;

interface TokenSpec {
  text: string;
  expect: Expectation;
}

interface TokenResult {
  file: string;
  token: string;
  expected: Expectation;
  actual: number | null;
  pass: boolean;
  evidence: Evidence[];
  error?: string;
}

function validateTable(tablePath: string, parsed: unknown): Record<string, TokenSpec[]> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${tablePath}: table must be an object mapping relative files to token lists`);
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    // An empty table produces zero checks and zero evidence; letting it
    // report ok:true would let a damaged table masquerade as a pass.
    fail(`${tablePath}: table is empty - a probe with no tokens cannot pass`);
  }
  for (const [file, specs] of entries) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      fail(`${tablePath}: entry "${file}" must be a relative path inside the tree root`);
    }
    if (!Array.isArray(specs) || specs.length === 0) {
      fail(`${tablePath}: entry for "${file}" must be a non-empty array of tokens`);
    }
    for (const spec of specs) {
      if (
        spec === null ||
        typeof spec !== "object" ||
        typeof spec.text !== "string" ||
        spec.text.length === 0
      ) {
        fail(`${tablePath}: every token for "${file}" needs a non-empty "text"`);
      }
      const expect: unknown = spec.expect;
      const valid =
        expect === ">=1" || (typeof expect === "number" && Number.isInteger(expect) && expect >= 0);
      if (!valid) {
        fail(
          `${tablePath}: token "${spec.text}" in "${file}" needs "expect" of ">=1" or a non-negative integer`,
        );
      }
    }
  }
  return parsed as Record<string, TokenSpec[]>;
}

function cmdTokens(tablePath: string, treeRoot: string): never {
  const raw = readRequiredFile(tablePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${tablePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const table = validateTable(tablePath, parsed);
  const rootStats = statOrFail(treeRoot, "no such directory");
  if (!rootStats.isDirectory()) {
    fail(`${treeRoot}: not a directory`);
  }

  const results: TokenResult[] = [];
  // Canonicalize both sides: the lexical ".." check in validateTable cannot
  // see symlinks, so a link.md entry could resolve outside the tree and the
  // probe would read external (possibly stale) content as if it were the
  // tree's. realpath the root once and require every entry's realpath to
  // stay inside it.
  const rootReal = realpathSync(treeRoot);
  // A tree root that canonicalizes to the filesystem root already ends with
  // the separator; naively appending sep would demand a "//" prefix and
  // reject every valid descendant.
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  for (const [file, specs] of Object.entries(table)) {
    let content: string | null = null;
    let readError: string | null = null;
    try {
      const real = realpathSync(join(treeRoot, file));
      if (real !== rootReal && !real.startsWith(rootPrefix)) {
        fail(`${file}: resolves outside tree root`);
      }
      content = readRegularFile(real, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      readError =
        code === "ENOENT"
          ? `${file}: no such file under ${treeRoot}`
          : `${file}: unreadable under ${treeRoot}: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const spec of specs) {
      if (content === null) {
        // A vanished file fails EVERY token loudly. A negative token must
        // never read the missing file as 0 occurrences and silently pass.
        results.push({
          file,
          token: spec.text,
          expected: spec.expect,
          actual: null,
          pass: false,
          evidence: [],
          error: readError ?? `${file}: unreadable under ${treeRoot}`,
        });
        continue;
      }
      const { value, evidence } = countMatchingLines(content, spec.text);
      const pass = spec.expect === ">=1" ? value >= 1 : value === spec.expect;
      results.push({
        file,
        token: spec.text,
        expected: spec.expect,
        actual: value,
        pass,
        evidence,
      });
    }
  }
  const failures = results.filter((result) => !result.pass).length;
  emit({ ok: failures === 0, failures, value: results }, failures === 0 ? 0 : 1);
}

// --- dispatch --------------------------------------------------------------------

function main(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "count": {
      const [file, literal] = rest;
      if (rest.length !== 2 || file === undefined || literal === undefined) {
        usage("count needs <file> <literal>");
      }
      cmdCount(file, literal);
      break;
    }
    case "json-keys": {
      const [file, other] = rest;
      if (rest.length < 1 || rest.length > 2 || file === undefined) {
        usage("json-keys needs <file> [<other-file>]");
      }
      cmdJsonKeys(file, other);
      break;
    }
    case "set": {
      const [root, baseRef] = rest;
      if (rest.length !== 2 || root === undefined || baseRef === undefined) {
        usage("set needs <repo-root> <base-ref>");
      }
      cmdSet(root, baseRef);
      break;
    }
    case "tokens": {
      const [tablePath, treeRoot] = rest;
      if (rest.length !== 2 || tablePath === undefined || treeRoot === undefined) {
        usage("tokens needs <table.json> <tree-root>");
      }
      cmdTokens(tablePath, treeRoot);
      break;
    }
    default:
      usage(subcommand === undefined ? "missing subcommand" : `unknown subcommand: ${subcommand}`);
  }
}

// The one-JSON-object contract must hold even for surprises (permission
// errors, races between stat and read): anything uncaught becomes a loud
// structured error, never a stack trace where a parser expects JSON.
try {
  main(process.argv.slice(2));
} catch (error) {
  fail(`unexpected: ${error instanceof Error ? error.message : String(error)}`);
}
