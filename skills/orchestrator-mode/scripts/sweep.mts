#!/usr/bin/env bun
/**
 * Fleet sweep: one JSON line per worktree of <repo-root>, plus an optional
 * transcript-sensor line. Replaces the hand-rolled zsh sweep whose documented
 * failure modes (word-split collapsing per-pid counts, unmatched globs
 * aborting the script, no `timeout` binary on macOS, self-matching greps,
 * vanished worktrees rendering every count as 0) are impossible here by
 * construction: every external command runs through execFile with an explicit
 * timeout, per-pid work iterates TS arrays, process attribution is by lsof
 * cwd (never argv or shell pipelines), and a worktree where anything fails
 * yields an ok:false row instead of a zeros row.
 *
 * Usage: sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]
 *
 * --base <ref> measures every row's aheadBehind against <ref> (any
 * committish, e.g. origin/develop) instead of origin's default branch, for
 * sessions integrating into a non-default mainline. Omitted, the default
 * branch resolution below is unchanged.
 *
 * Output lines, in order:
 *   {"control":"FAILED","reason":...}          only when the sweep itself is
 *                                              broken (never a quiet fleet)
 *   {"lsof":{"ok":false,"error":...}}          only when process attribution
 *                                              is down (rows then carry [])
 *   {"lsof":{"ok":true,"degraded":true,...}}   lsof exited nonzero but still
 *                                              produced records; lists may
 *                                              omit unreadable processes
 *   {"defaultRef":{"ok":false,"error":...}}    only when origin's default
 *                                              branch cannot be resolved
 *                                              (rows carry aheadBehind:null)
 *   {"baseRef":{"ok":false,"error":...}}       only when an explicit --base
 *                                              ref is unresolvable or
 *                                              ambiguous (rows carry
 *                                              aheadBehind:null; never a
 *                                              fallback to the default
 *                                              branch)
 *   {"worktree":...,"ok":true,...}             one per worktree
 *   {"worktree":...,"ok":false,"error":...}    vanished dir or git failure
 *   {"transcripts":{...}}                      only with --transcripts
 *
 * Exit codes: 0 sweep ran (ok:false rows included), 1 control failure,
 * 2 usage error.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
// Upper bound on how far back the transcript sensor will scan for a parseable
// event line; keeps a pathological transcript from turning the sweep O(file).
const TRANSCRIPT_TAIL_MAX_BYTES = 8 * 1024 * 1024;

type RunResult =
  | { ok: true; stdout: Buffer; stderr: Buffer; degraded?: boolean }
  | { ok: false; error: string; code: number | null };

/**
 * A sweep launched from a git hook (or any git-managed context) inherits
 * GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE and friends pointed at the launching
 * repo, which would silently redirect every git call here to the wrong
 * repository - strip ALL of them, and pin the config files to /dev/null so
 * inherited global/system config cannot bend a probe either. The instrument
 * measures its argument, nothing else.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  // A probe must not take index.lock or refresh worktree indexes - that
  // contends with the very workers being observed (observer effect in a
  // read-only instrument). Set for every git spawn, not per-command flags.
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/**
 * Every external command funnels through here: explicit timeout option (no
 * `timeout` binary dependency), captured output, failure as a value. Output
 * is captured as raw bytes: filenames are byte strings, not UTF-8, and a
 * utf8 decode would fold invalid sequences to U+FFFD - making stats miss
 * real files and distinct porcelain outputs collide into one hash.
 */
function run(
  cmd: string,
  args: string[],
  opts: { acceptStdoutOnError?: boolean; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "buffer",
        env: { ...sanitizedEnv(), ...opts.env },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ ok: true, stdout, stderr });
          return;
        }
        // lsof and ps exit nonzero when some processes are unreadable or
        // exited mid-sweep while still printing everything they could see;
        // that partial view is the data. Only a genuine nonzero EXIT
        // qualifies: a timeout kill or an overflowed output buffer also
        // leaves partial stdout, and treating those as success would let an
        // incomplete process list read as a quiet fleet.
        const genuineNonzeroExit =
          !error.killed && error.signal == null && typeof error.code === "number";
        if (opts.acceptStdoutOnError && genuineNonzeroExit && stdout.length > 0) {
          resolvePromise({ ok: true, stdout, stderr, degraded: true });
          return;
        }
        const detail = stderr.toString("utf8").trim().split("\n")[0] ?? "";
        resolvePromise({
          ok: false,
          error: `${cmd} ${args.join(" ")}: ${error.message}${detail ? ` [${detail}]` : ""}`,
          // The exit code, when the failure IS a plain nonzero exit; null for
          // timeouts/signals. Callers that treat a specific exit code as a
          // legitimate state (symbolic-ref exits 1 on a detached HEAD) must
          // check this rather than reading every failure as that state.
          code: genuineNonzeroExit ? (error.code as number) : null,
        });
      },
    );
  });
}

/** Split a buffer on NUL bytes without ever decoding the pieces. */
function splitNul(buffer: Buffer): Buffer[] {
  const tokens: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nul = buffer.indexOf(0, start);
    if (nul === -1) {
      if (start < buffer.length) tokens.push(buffer.subarray(start));
      return tokens;
    }
    tokens.push(buffer.subarray(start, nul));
    start = nul + 1;
  }
}

function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

// --- worktree discovery -----------------------------------------------------

/**
 * Parse `git worktree list --porcelain -z` (NUL-terminated attribute records)
 * into worktree paths. Only the paths are trusted from discovery: headSha and
 * branch are read per-row through the pinned gitdir so they are bracketed
 * against mid-sweep commits and checkouts rather than frozen at discovery.
 */
function parseWorktreeList(porcelain: string): string[] {
  const paths: string[] = [];
  for (const record of porcelain.split("\0")) {
    if (record.startsWith("worktree ")) paths.push(record.slice("worktree ".length));
  }
  return paths;
}

// --- git status parsing -----------------------------------------------------

interface StatusSummary {
  dirtyPaths: Buffer[];
  untrackedPaths: Buffer[];
  statusHash: string;
}

/**
 * Parse `git status --porcelain -z --untracked-files=all`: NUL-terminated
 * "XY PATH" entries, verbatim paths (no C-quoting), and for rename/copy
 * entries the ORIG_PATH follows as its own NUL-terminated token. Paths stay
 * raw Buffers end to end - they are only ever handed back to the filesystem,
 * never displayed - so a filename that is not valid UTF-8 is still the exact
 * byte string the filesystem knows.
 */
function parseStatus(porcelain: Buffer): StatusSummary {
  const dirtyPaths: Buffer[] = [];
  const untrackedPaths: Buffer[] = [];
  const tokens = splitNul(porcelain);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as Buffer;
    if (entry.length < 4 || entry[2] !== 0x20) continue;
    const xy = entry.subarray(0, 2).toString("latin1"); // status codes are ASCII
    const path = entry.subarray(3);
    if (xy === "??") {
      untrackedPaths.push(path);
    } else {
      dirtyPaths.push(path);
      if (xy.includes("R") || xy.includes("C")) i++; // skip the ORIG_PATH token
    }
  }
  return {
    dirtyPaths,
    untrackedPaths,
    statusHash: createHash("sha256").update(porcelain).digest("hex").slice(0, 16),
  };
}

/**
 * Newest mtime among the porcelain-listed dirty and untracked paths only -
 * never the git index (frozen for minutes while a worker writes) and never a
 * whole-tree walk (collapses under wave-start I/O). lstat, not stat: a
 * symlink's own mtime is the worker's write, and a dangling target must not
 * abort the row. Stats take the raw path bytes, so non-UTF-8 filenames
 * resolve. Unstat-able paths are skipped; they still count in
 * dirtyCount/untrackedCount.
 */
function newestDirtyMtime(worktree: string, paths: Buffer[]): string | null {
  const prefix = Buffer.from(`${worktree}/`, "utf8");
  let newest = -1;
  for (const path of paths) {
    try {
      const stat = lstatSync(Buffer.concat([prefix, path]), { throwIfNoEntry: false });
      if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // e.g. ELOOP or a permission failure on one path: skip it
    }
  }
  return newest >= 0 ? new Date(newest).toISOString() : null;
}

// --- process attribution ----------------------------------------------------

interface ProcessRow {
  pid: number;
  command: string;
  state: string;
}

interface CwdEntry {
  pid: number;
  command: string;
  cwd: string;
}

/**
 * Parse `lsof -a -d cwd -F pcn0` field output: NUL-terminated fields marked
 * p<pid>, c<command>, n<path>. The NUL terminator (the trailing 0 in -F) is
 * what makes a cwd path containing literal newlines one intact field instead
 * of lines that would corrupt a newline-oriented parse; lsof still inserts
 * cosmetic newlines between field sets, so each token strips leading ones.
 */
function parseLsofFields(output: string): CwdEntry[] {
  const entries: CwdEntry[] = [];
  let pid = -1;
  let command = "";
  for (const rawToken of output.split("\0")) {
    const token = rawToken.replace(/^\n+/, "");
    if (token.startsWith("p")) {
      pid = Number.parseInt(token.slice(1), 10);
      command = "";
    } else if (token.startsWith("c")) {
      command = token.slice(1);
    } else if (token.startsWith("n") && pid > 0) {
      entries.push({ pid, command, cwd: token.slice(1) });
    }
  }
  return entries;
}

/**
 * Attribute each cwd to the LONGEST matching worktree path: this repo nests
 * worktrees inside the main checkout (.claude/worktrees/), so a plain prefix
 * match would credit every nested worker to the main checkout as well.
 */
function attributeByCwd(
  entries: CwdEntry[],
  realPathByWorktree: Map<string, string>,
): Map<string, CwdEntry[]> {
  const attributed = new Map<string, CwdEntry[]>();
  for (const [worktree] of realPathByWorktree) attributed.set(worktree, []);
  for (const entry of entries) {
    let bestWorktree: string | null = null;
    let bestLength = -1;
    for (const [worktree, realPath] of realPathByWorktree) {
      const matches = entry.cwd === realPath || entry.cwd.startsWith(`${realPath}/`);
      if (matches && realPath.length > bestLength) {
        bestWorktree = worktree;
        bestLength = realPath.length;
      }
    }
    if (bestWorktree !== null) attributed.get(bestWorktree)?.push(entry);
  }
  return attributed;
}

/** One `ps` for all attributed pids; per-pid iteration stays in TS arrays. */
async function processStates(pids: number[]): Promise<Map<number, string>> {
  const states = new Map<number, string>();
  if (pids.length === 0) return states;
  const result = await run("ps", ["-o", "pid=,stat=", "-p", pids.join(",")], {
    acceptStdoutOnError: true, // ps exits 1 when some pids exited mid-sweep
  });
  if (!result.ok) return states;
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)/);
    if (match) states.set(Number.parseInt(match[1] as string, 10), match[2] as string);
  }
  return states;
}

// --- transcript sensor ------------------------------------------------------

function readTail(fd: number, sizeBytes: number, windowBytes: number): string {
  const start = Math.max(0, sizeBytes - windowBytes);
  const buffer = Buffer.alloc(sizeBytes - start);
  const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
  return buffer.toString("utf8", 0, bytesRead);
}

type LastEvent = { found: true; type: string | null } | { found: false };

/**
 * The final line's "type", falling back line-by-line toward the front of the
 * tail so a mid-write truncated last line reads as the previous event rather
 * than as a parse failure. found:false means no line in the tail parsed at
 * all (e.g. one truncated line larger than the whole window).
 */
function lastEventInTail(tail: string): LastEvent {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event === "object" && event !== null) {
        const type = (event as Record<string, unknown>).type;
        return { found: true, type: typeof type === "string" ? type : null };
      }
    } catch {
      // truncated or malformed line: keep walking back
    }
  }
  return { found: false };
}

/**
 * Widen the tail window until some line parses, so a single truncated event
 * larger than the base window cannot quietly erase the previous event. The
 * window is still capped: a transcript with megabytes of unparseable tail
 * honestly reads null rather than turning the sweep O(file).
 */
function lastEventType(fd: number, sizeBytes: number): string | null {
  let window = TRANSCRIPT_TAIL_BYTES;
  for (;;) {
    const result = lastEventInTail(readTail(fd, sizeBytes, window));
    if (result.found) return result.type;
    if (window >= sizeBytes || window >= TRANSCRIPT_TAIL_MAX_BYTES) return null;
    window = Math.min(window * 4, TRANSCRIPT_TAIL_MAX_BYTES);
  }
}

function transcriptReport(dir: string): unknown {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return { transcripts: { ok: false, error: `cannot read ${dir}: ${String(error)}` } };
  }
  const agents = [];
  for (const name of names.sort()) {
    const match = name.match(/^agent-(.+)\.jsonl$/);
    if (!match) continue;
    const path = join(dir, name);
    // A FIFO (or device) named like a transcript would hang the synchronous
    // tail read forever. The check is on the HANDLE, not the path: an
    // isFile-then-open pair could still open a FIFO swapped in between the
    // two calls. O_NONBLOCK makes even that open non-blocking (and is a
    // no-op for regular files); fstat on the fd then decides.
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        agents.push({ agent: match[1], ok: false, error: "not a regular file" });
        continue;
      }
      agents.push({
        agent: match[1],
        mtime: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        // Age from file mtime: JSONL events are not guaranteed to carry
        // timestamps, and mtime moves on every appended event.
        lastEventAgeSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)),
        lastEventType: lastEventType(fd, stat.size),
      });
    } catch (error) {
      agents.push({ agent: match[1], ok: false, error: String(error) });
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return { transcripts: { ok: true, dir, agents } };
}

// --- per-worktree row -------------------------------------------------------

type BaseRef = { ref: string; sha: string } | { ref: null; error: string };

/**
 * Resolve an operator-supplied --base ref to a pinned sha. Any committish is
 * accepted (origin/develop, a local branch, a tag, a sha); --end-of-options
 * keeps a hostile ref string from being read as a git option, and ^{commit}
 * rejects non-commit objects. The sha is pinned once for the whole sweep for
 * the same reason as the default-branch sha below: a concurrent fetch moving
 * the ref mid-sweep would otherwise hand different rows different bases. An
 * explicitly requested base that cannot be resolved is a loud error - never
 * a silent fallback to the default branch, whose counts would be exactly the
 * wrong-branch readings the flag exists to prevent.
 */
async function resolveBaseRef(repoRoot: string, ref: string): Promise<BaseRef> {
  // No --quiet here, unlike the default-branch probes: --quiet would also
  // suppress the "refname is ambiguous" warning this probe must read. A
  // missing ref therefore fails through rev-parse's ordinary nonzero exit,
  // carrying git's own message.
  const probe = await run(
    "git",
    [
      "-C",
      repoRoot,
      // A repo-local core.warnAmbiguousRefs=false would suppress the very
      // warning the check below reads; force it on for this probe.
      "-c",
      "core.warnAmbiguousRefs=true",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ],
    // Pin the locale for this probe only, so a translated warning cannot
    // slip past the text check.
    { env: { LC_ALL: "C" } },
  );
  if (!probe.ok) {
    return { ref: null, error: `cannot resolve --base ref ${ref}: ${probe.error}` };
  }
  // rev-parse exits 0 on an AMBIGUOUS name (say, a tag and a branch both
  // named develop), silently resolving it by its own precedence rules with
  // only a stderr warning; a sweep must never guess which mainline the
  // operator meant.
  if (probe.stderr.toString("utf8").includes("is ambiguous")) {
    return { ref: null, error: `cannot resolve --base ref ${ref}: refname is ambiguous` };
  }
  return { ref, sha: probe.stdout.toString("utf8").trim() };
}

async function resolveDefaultRef(repoRoot: string): Promise<BaseRef> {
  const candidates: string[] = [];
  const head = await run("git", [
    "-C",
    repoRoot,
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (head.ok) {
    const ref = head.stdout.toString("utf8").trim();
    if (ref.startsWith("refs/remotes/")) candidates.push(ref.slice("refs/remotes/".length));
  } else if (head.code !== 1) {
    // Only exit 1 means "origin/HEAD is absent or not symbolic" - a timeout,
    // signal, or fatal error must not fall through to the main/master guess:
    // when the real default is another branch, the guess would silently hand
    // every row the wrong ahead/behind base.
    return { ref: null, error: `cannot resolve origin's default branch: ${head.error}` };
  }
  for (const fallback of ["origin/main", "origin/master"]) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  // Every candidate is verified to exist - including the symbolic-ref target,
  // which can dangle after a default-branch rename; taking it on faith would
  // fail every worktree row against a ref that is not there. The verifying
  // rev-parse also PINS the ref to a sha, taken once for the whole sweep: a
  // concurrent fetch moving origin's tip mid-sweep would otherwise hand
  // different rows different ahead/behind bases.
  for (const candidate of candidates) {
    const probe = await run("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${candidate}`,
    ]);
    if (probe.ok) return { ref: candidate, sha: probe.stdout.toString("utf8").trim() };
    // Same discrimination as above: exit 1 is the documented "ref does not
    // exist" signature under --verify --quiet; anything else is a broken
    // probe, and guessing onward would base every row on the wrong ref.
    if (probe.code !== 1) {
      return { ref: null, error: `cannot resolve origin's default branch: ${probe.error}` };
    }
  }
  return {
    ref: null,
    error:
      "cannot resolve origin's default branch: no verifiable refs/remotes/origin/HEAD " +
      "target, origin/main, or origin/master",
  };
}

/**
 * The checked-out branch through the pinned gitdir. Detached HEAD is a
 * legitimate state, not a failure - but only the DOCUMENTED detached
 * signature (`symbolic-ref --quiet` exiting 1) reads as detached; any other
 * failure (broken gitdir, timeout) is a real error, otherwise a dead probe
 * would silently report a healthy detached row.
 */
async function readBranch(
  pinned: string[],
): Promise<{ ok: true; branch: string | null } | { ok: false; error: string }> {
  const result = await run("git", [...pinned, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.ok) return { ok: true, branch: result.stdout.toString("utf8").trim() };
  if (result.code === 1) return { ok: true, branch: null };
  return { ok: false, error: result.error };
}

/** Strip exactly the trailing newline git appends to a single-value output. */
function gitValue(stdout: Buffer): string {
  return stdout.toString("utf8").replace(/\n$/, "");
}

async function worktreeRow(
  path: string,
  baseSha: string | null,
  processes: ProcessRow[],
): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return { worktree: path, ok: false, error: "worktree directory no longer exists" };
  }

  // A worktree dir that lost its .git file still exists, but `git -C` then
  // discovers an enclosing checkout (this repo nests worktrees inside the
  // main one) and every git reading below would describe the WRONG repo.
  // Discovery happens ONCE, here; every later git call is pinned to the
  // verified --git-dir/--work-tree so a .git file vanishing mid-sweep cannot
  // make a later call re-discover the parent and report its numbers. The
  // invariant: ALL identity reads for a row agree, verified by a final
  // re-read. Each value comes from its own single-value call (never one call
  // split on newline - a path containing a literal newline would shear the
  // split), and because the two reads are separate they are bracketed
  // against EACH OTHER: gitdir, then toplevel, then gitdir again, which must
  // match before the pin is trusted. The end-of-row re-read closes the
  // bracket around the row's readings the same way.
  const gitDirResult = await run("git", ["-C", path, "rev-parse", "--absolute-git-dir"]);
  if (!gitDirResult.ok) return { worktree: path, ok: false, error: gitDirResult.error };
  const gitDir = gitValue(gitDirResult.stdout);
  if (gitDir.length === 0) {
    return { worktree: path, ok: false, error: "rev-parse returned an empty git dir" };
  }
  const toplevelResult = await run("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  if (!toplevelResult.ok) return { worktree: path, ok: false, error: toplevelResult.error };
  try {
    const found = realpathSync(gitValue(toplevelResult.stdout));
    const expected = realpathSync(path);
    if (found !== expected) {
      return {
        worktree: path,
        ok: false,
        error: `git discovery escaped the worktree: found toplevel ${found}`,
      };
    }
  } catch (error) {
    return { worktree: path, ok: false, error: `cannot verify toplevel: ${String(error)}` };
  }
  const gitDirVerify = await run("git", ["-C", path, "rev-parse", "--absolute-git-dir"]);
  if (!gitDirVerify.ok) return { worktree: path, ok: false, error: gitDirVerify.error };
  if (gitValue(gitDirVerify.stdout) !== gitDir) {
    return {
      worktree: path,
      ok: false,
      error: `gitdir moved during discovery (${gitDir} -> ${gitValue(gitDirVerify.stdout)})`,
    };
  }
  const pinned = ["--git-dir", gitDir, "--work-tree", path];

  // headSha and branch come from the pinned gitdir, read HERE and re-read
  // after the other probes: discovery-time values could predate a mid-sweep
  // commit or checkout, and a row mixing old identity with new counts would
  // carry a contradiction.
  const headBefore = await run("git", [...pinned, "rev-parse", "HEAD"]);
  if (!headBefore.ok) return { worktree: path, ok: false, error: headBefore.error };
  const headSha = headBefore.stdout.toString("utf8").trim();
  const branchBefore = await readBranch(pinned);
  if (!branchBefore.ok) return { worktree: path, ok: false, error: branchBefore.error };
  const branch = branchBefore.branch;

  // --untracked-files=all: the default collapses a nested untracked tree to
  // one "dir/" entry whose mtime does not move on edits inside it, so active
  // work would read as stalled.
  const status = await run("git", [
    ...pinned,
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.ok) return { worktree: path, ok: false, error: status.error };

  // Tree size at HEAD: HEAD sha, ahead/behind, dirty count, and mtimes all
  // read normal for a commit stacked on top of a repo-wiping commit - only
  // the file count at HEAD vs the base separates "committed its work" from
  // "committed on top of deleting the repo".
  const tree = await run("git", [...pinned, "ls-tree", "-r", "-z", "--name-only", "HEAD"]);
  if (!tree.ok) return { worktree: path, ok: false, error: tree.error };
  const treeFileCount = splitNul(tree.stdout).filter((name) => name.length > 0).length;

  let aheadBehind: { ahead: number; behind: number } | null = null;
  if (baseSha !== null) {
    // The base is the sweep-wide PINNED sha of the base ref (origin's
    // default branch, or the --base ref), not the mutable ref name: a
    // concurrent fetch moving the ref mid-sweep would otherwise give
    // different rows different bases.
    const counts = await run("git", [
      ...pinned,
      "rev-list",
      "--left-right",
      "--count",
      `${baseSha}...HEAD`,
    ]);
    if (!counts.ok) return { worktree: path, ok: false, error: counts.error };
    const [behind, ahead] = counts.stdout.toString("utf8").trim().split(/\s+/);
    aheadBehind = {
      ahead: Number.parseInt(ahead ?? "", 10),
      behind: Number.parseInt(behind ?? "", 10),
    };
    if (Number.isNaN(aheadBehind.ahead) || Number.isNaN(aheadBehind.behind)) {
      return {
        worktree: path,
        ok: false,
        error: `unparseable rev-list count: ${counts.stdout.toString("utf8")}`,
      };
    }
  }

  // Close the bracket: if HEAD or the branch moved while status/ls-tree/
  // rev-list ran, the readings above describe a mix of two states - refuse
  // the row rather than report an internally inconsistent one; the next
  // sweep re-measures.
  const headAfter = await run("git", [...pinned, "rev-parse", "HEAD"]);
  if (!headAfter.ok) return { worktree: path, ok: false, error: headAfter.error };
  const headShaAfter = headAfter.stdout.toString("utf8").trim();
  if (headShaAfter !== headSha) {
    return {
      worktree: path,
      ok: false,
      error: `HEAD moved mid-row (${headSha} -> ${headShaAfter}); readings are inconsistent`,
    };
  }
  const branchAfter = await readBranch(pinned);
  if (!branchAfter.ok) return { worktree: path, ok: false, error: branchAfter.error };
  if (branchAfter.branch !== branch) {
    return {
      worktree: path,
      ok: false,
      error: `branch moved mid-row (${branch} -> ${branchAfter.branch}); readings are inconsistent`,
    };
  }
  // Re-discover the gitdir and require it unchanged: this closes the window
  // between the toplevel and gitdir reads above (a .git swap between them
  // could pin the wrong repo) and catches any mid-row identity change the
  // pinned reads themselves cannot see.
  const gitDirAfter = await run("git", ["-C", path, "rev-parse", "--absolute-git-dir"]);
  if (!gitDirAfter.ok) return { worktree: path, ok: false, error: gitDirAfter.error };
  if (gitValue(gitDirAfter.stdout) !== gitDir) {
    return {
      worktree: path,
      ok: false,
      error: `gitdir moved mid-row (${gitDir} -> ${gitValue(gitDirAfter.stdout)}); readings are inconsistent`,
    };
  }

  const { dirtyPaths, untrackedPaths, statusHash } = parseStatus(status.stdout);
  return {
    worktree: path,
    branch,
    ok: true,
    headSha,
    aheadBehind,
    treeFileCount,
    dirtyCount: dirtyPaths.length,
    untrackedCount: untrackedPaths.length,
    newestDirtyMtime: newestDirtyMtime(path, [...dirtyPaths, ...untrackedPaths]),
    statusHash,
    processes,
  };
}

// The main checkout is the positive control: it must resolve a HEAD sha or
// hold a process (this sweep), and its tree at HEAD is the baseline worktree
// rows are compared against, so a zero there voids the comparison.
function controlFailureReason(control: Record<string, unknown>): string | null {
  const name = basename(String(control.worktree));
  const hasHead = typeof control.headSha === "string" && control.headSha.length > 0;
  const hasProcesses = Array.isArray(control.processes) && control.processes.length > 0;
  if (control.ok !== true || !(hasHead || hasProcesses)) {
    return `main checkout row (${name}) has no headSha and no processes: ${JSON.stringify(control)}`;
  }
  if (control.treeFileCount === 0) {
    return `main checkout row (${name}) has treeFileCount 0 at HEAD ${String(control.headSha)}; an empty tree on the main checkout invalidates the positive control, and worktree rows cannot be compared against a zero baseline`;
  }
  return null;
}

// --- main -------------------------------------------------------------------

function usage(): number {
  console.error("usage: sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]");
  return 2;
}

/**
 * Returns the process exit code; the caller assigns process.exitCode and the
 * process ends on its own once stdio drains. process.exit() after emitting
 * rows would discard still-buffered piped stdout on a large fleet - the
 * report would be silently truncated exactly when it matters most.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let repoRoot: string | null = null;
  let transcriptsDir: string | null = null;
  let baseRefArg: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--base") {
      const value = args[++i];
      // A refname can never start with "-", so a "-"-prefixed value is a
      // missing value with the NEXT option consumed by mistake ("--base
      // --transcripts"): a usage error, not a baseRef diagnostic.
      if (value === undefined || value.startsWith("-")) return usage();
      baseRefArg = value;
    } else if (arg === "--transcripts") {
      const value = args[++i];
      if (value === undefined) return usage();
      transcriptsDir = resolve(value);
    } else if (arg.startsWith("-")) {
      return usage();
    } else if (repoRoot === null) {
      repoRoot = resolve(arg);
    } else {
      return usage();
    }
  }
  if (repoRoot === null) return usage();

  const listResult = await run("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"]);
  if (!listResult.ok) {
    emit({ control: "FAILED", reason: `worktree discovery failed: ${listResult.error}` });
    return 1;
  }
  // Worktree paths become JSON row keys and lsof match targets, so they are
  // decoded; a non-UTF-8 WORKTREE path (unlike a filename inside one) is not
  // supported and such rows will read ok:false rather than lie.
  const worktreePaths = parseWorktreeList(listResult.stdout.toString("utf8")).filter(isAbsolute);
  if (worktreePaths.length === 0) {
    emit({ control: "FAILED", reason: "git worktree list returned no worktrees" });
    return 1;
  }

  // lsof paths are symlink-resolved (macOS /var -> /private/var), so match
  // against realpaths while reporting git's own worktree paths.
  const realPathByWorktree = new Map<string, string>();
  for (const worktreePath of worktreePaths) {
    if (!existsSync(worktreePath)) continue;
    try {
      realPathByWorktree.set(worktreePath, realpathSync(worktreePath));
    } catch {
      // raced deletion between existsSync and realpathSync: row goes ok:false
    }
  }

  const lsofResult = await run("lsof", ["-a", "-d", "cwd", "-F", "pcn0"], {
    acceptStdoutOnError: true,
  });
  let attributed = new Map<string, CwdEntry[]>();
  let lsofLine: Record<string, unknown> | null = lsofResult.ok
    ? null
    : { lsof: { ok: false, error: lsofResult.error } };
  if (lsofResult.ok) {
    const entries = parseLsofFields(lsofResult.stdout.toString("utf8"));
    if (entries.length === 0) {
      // Zero cwd records is IMPOSSIBLE for a working probe regardless of
      // exit code: this sweep's own process holds a cwd and is in the
      // scanned set. Empty stdout on a clean exit and parser drift both
      // land here - a broken instrument, never an idle fleet.
      const shape = lsofResult.stdout.length === 0 ? "empty" : "nonempty";
      const exit = lsofResult.degraded === true ? "nonzero" : "zero";
      lsofLine = {
        lsof: {
          ok: false,
          error: `lsof parsed zero cwd records from ${shape} output (${exit} exit)`,
        },
      };
    } else {
      attributed = attributeByCwd(entries, realPathByWorktree);
      if (lsofResult.degraded === true) {
        // Partial visibility (lsof exited nonzero but produced records) is
        // its routine mode on multi-user systems, so it is not a failure -
        // but an unreadable process is invisible to attribution, and a
        // silent processes:[] must not be mistaken for a verified absence.
        lsofLine = {
          lsof: {
            ok: true,
            degraded: true,
            note: "lsof exited nonzero; process lists may omit unreadable processes",
          },
        };
      }
    }
  }
  const allPids = [...attributed.values()].flat().map((entry) => entry.pid);
  const states = await processStates(allPids);
  const processesByWorktree = new Map<string, ProcessRow[]>();
  for (const [worktree, entries] of attributed) {
    processesByWorktree.set(
      worktree,
      entries.map((entry) => ({
        pid: entry.pid,
        command: entry.command,
        state: states.get(entry.pid) ?? "unknown",
      })),
    );
  }

  const base =
    baseRefArg === null
      ? await resolveDefaultRef(repoRoot)
      : await resolveBaseRef(repoRoot, baseRefArg);
  const rows: Record<string, unknown>[] = [];
  for (const worktreePath of worktreePaths) {
    rows.push(
      await worktreeRow(
        worktreePath,
        base.ref === null ? null : base.sha,
        processesByWorktree.get(worktreePath) ?? [],
      ),
    );
  }

  // Positive control: the first porcelain entry is the main checkout. An
  // impossible control row means the instrument is broken - report that,
  // never a quiet fleet.
  const controlFailure = controlFailureReason(rows[0] as Record<string, unknown>);
  if (controlFailure !== null) emit({ control: "FAILED", reason: controlFailure });

  if (lsofLine !== null) emit(lsofLine);
  if (base.ref === null) {
    emit(
      baseRefArg === null
        ? { defaultRef: { ok: false, error: base.error } }
        : { baseRef: { ok: false, error: base.error } },
    );
  }
  for (const row of rows) emit(row);
  if (transcriptsDir !== null) emit(transcriptReport(transcriptsDir));
  return controlFailure === null ? 0 : 1;
}

process.exitCode = await main();
