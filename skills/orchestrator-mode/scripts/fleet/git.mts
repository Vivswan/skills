// The git half of a fleet reading: worktree discovery, one bracketed row per worktree, the base
// ref pinned once per sweep. Every reading that fails is a value, never a row of zeros.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ProcessRow } from "./processes.mts";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export type RunResult =
  | { ok: true; stdout: Buffer; stderr: Buffer; code: number }
  | { ok: false; error: string; code: number | null };

/**
 * A sweep launched from a git hook (or any git-managed context) inherits
 * GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE and friends pointed at the launching
 * repo, which would silently redirect every git call here to the wrong
 * repository - strip ALL of them, and pin the config files to /dev/null so
 * inherited global/system config cannot bend a probe either. The instrument
 * measures its argument, nothing else.
 */
export function sanitizedEnv(): NodeJS.ProcessEnv {
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
export function run(
  cmd: string,
  args: string[],
  opts: { acceptStdoutOnError?: boolean; env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "buffer",
        cwd: opts.cwd,
        env: { ...sanitizedEnv(), ...opts.env },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ ok: true, stdout, stderr, code: 0 });
          return;
        }
        // lsof and ps exit nonzero when some processes are unreadable or
        // exited mid-sweep while still printing everything they could see;
        // that partial view is the data, and the exit code travels with it
        // for the caller to read. Only a genuine nonzero EXIT qualifies: a
        // timeout kill or an overflowed output buffer also leaves partial
        // stdout, and treating those as success would let an incomplete
        // process list read as a quiet fleet.
        const genuineNonzeroExit =
          !error.killed && error.signal == null && typeof error.code === "number";
        if (opts.acceptStdoutOnError && genuineNonzeroExit && stdout.length > 0) {
          resolvePromise({ ok: true, stdout, stderr, code: error.code as number });
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
export function splitNul(buffer: Buffer): Buffer[] {
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

// --- worktree discovery -----------------------------------------------------

/**
 * Parse `git worktree list --porcelain -z` (NUL-terminated attribute records)
 * into worktree paths. Only the paths are trusted from discovery: headSha and
 * branch are read per-row through the pinned gitdir so they are bracketed
 * against mid-sweep commits and checkouts rather than frozen at discovery.
 */
export function parseWorktreeList(porcelain: string): string[] {
  const paths: string[] = [];
  for (const record of porcelain.split("\0")) {
    if (record.startsWith("worktree ")) paths.push(record.slice("worktree ".length));
  }
  return paths;
}

/**
 * The repository's worktree paths, the main checkout first. A failed or empty listing is the
 * reason a sweep reports as its control failure.
 */
export async function discoverWorktrees(
  repoRoot: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const listResult = await run("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"]);
  if (!listResult.ok) {
    return { ok: false, reason: `worktree discovery failed: ${listResult.error}` };
  }
  // Worktree paths become JSON row keys and lsof match targets, so they are
  // decoded; a non-UTF-8 WORKTREE path (unlike a filename inside one) is not
  // supported and such rows will read ok:false rather than lie.
  const paths = parseWorktreeList(listResult.stdout.toString("utf8")).filter(isAbsolute);
  if (paths.length === 0) return { ok: false, reason: "git worktree list returned no worktrees" };
  return { ok: true, paths };
}

// --- git status parsing -----------------------------------------------------

export interface StatusSummary {
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
export function parseStatus(porcelain: Buffer): StatusSummary {
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
export function newestDirtyMtime(worktree: string, paths: Buffer[]): string | null {
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

// --- the base ref -----------------------------------------------------------

export type BaseRef = { ref: string; sha: string } | { ref: null; error: string };

/** A git call pinned to one worktree's verified gitdir, work tree, AND cwd. */
type PinnedGit = (args: string[]) => Promise<RunResult>;

/**
 * Resolve the operator's --base ref to a sha pinned once for the whole sweep (same reason as in
 * resolveDefaultRef: a fetch moving the ref mid-sweep would hand rows different bases). An
 * unresolvable base is a loud error, never a fallback to the default branch, whose counts are
 * exactly the wrong-branch readings the flag exists to prevent.
 *   --end-of-options  -> a hostile ref string cannot be read as a git option
 *   ^{commit}         -> a non-commit object (a tree, a blob) is refused
 */
export async function resolveBaseRef(repoRoot: string, ref: string): Promise<BaseRef> {
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

export async function resolveDefaultRef(repoRoot: string): Promise<BaseRef> {
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

// --- per-worktree row -------------------------------------------------------

/**
 * The checked-out branch through the pinned gitdir. Detached HEAD is a
 * legitimate state, not a failure - but only the DOCUMENTED detached
 * signature (`symbolic-ref --quiet` exiting 1) reads as detached; any other
 * failure (broken gitdir, timeout) is a real error, otherwise a dead probe
 * would silently report a healthy detached row.
 */
export async function readBranch(
  pinnedGit: PinnedGit,
): Promise<{ ok: true; branch: string | null } | { ok: false; error: string }> {
  const result = await pinnedGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.ok) return { ok: true, branch: result.stdout.toString("utf8").trim() };
  if (result.code === 1) return { ok: true, branch: null };
  return { ok: false, error: result.error };
}

/** Strip exactly the trailing newline git appends to a single-value output. */
function gitValue(stdout: Buffer): string {
  return stdout.toString("utf8").replace(/\n$/, "");
}

export type WorktreeRow =
  | {
      worktree: string;
      branch: string | null;
      ok: true;
      headSha: string;
      aheadBehind: { ahead: number; behind: number } | null;
      treeFileCount: number;
      dirtyCount: number;
      untrackedCount: number;
      newestDirtyMtime: string | null;
      statusHash: string;
      processes: ProcessRow[];
    }
  | { worktree: string; ok: false; error: string };

export async function worktreeRow(
  path: string,
  baseSha: string | null,
  processes: ProcessRow[],
): Promise<WorktreeRow> {
  if (!existsSync(path)) {
    return { worktree: path, ok: false, error: "worktree directory no longer exists" };
  }

  // A worktree dir that lost its .git file still exists, but `git -C` then discovers the ENCLOSING
  // checkout (this repo nests worktrees inside the main one) and every reading would describe the
  // wrong repo. So discovery runs once, bracketed, and every later call is pinned to the verified
  // gitdir and work tree; the end-of-row re-read closes the same bracket around the readings.
  //   gitdir -> toplevel (must be this path) -> gitdir again (must match the first) -> pin trusted
  // One single-value call per value, never one call split on newline: a path holding a newline would shear the split.
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
  // cwd is pinned too: git reads a cwd INSIDE a work tree as a pathspec
  // prefix, so a sweep launched from a nested worktree (this repo keeps them
  // under the main checkout) would list the main checkout's tree relative to
  // that subdirectory. A vanished dir fails the spawn and the row goes
  // ok:false, as it should.
  const pinnedGit: PinnedGit = (args) =>
    run("git", ["--git-dir", gitDir, "--work-tree", path, ...args], { cwd: path });

  // headSha and branch come from the pinned gitdir, read HERE and re-read
  // after the other probes: discovery-time values could predate a mid-sweep
  // commit or checkout, and a row mixing old identity with new counts would
  // carry a contradiction.
  const headBefore = await pinnedGit(["rev-parse", "HEAD"]);
  if (!headBefore.ok) return { worktree: path, ok: false, error: headBefore.error };
  const headSha = headBefore.stdout.toString("utf8").trim();
  const branchBefore = await readBranch(pinnedGit);
  if (!branchBefore.ok) return { worktree: path, ok: false, error: branchBefore.error };
  const branch = branchBefore.branch;

  // --untracked-files=all: the default collapses a nested untracked tree to
  // one "dir/" entry whose mtime does not move on edits inside it, so active
  // work would read as stalled.
  const status = await pinnedGit(["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!status.ok) return { worktree: path, ok: false, error: status.error };

  // Tree size at HEAD: HEAD sha, ahead/behind, dirty count, and mtimes all
  // read normal for a commit stacked on top of a repo-wiping commit - only
  // the file count at HEAD vs the base separates "committed its work" from
  // "committed on top of deleting the repo". --full-tree: ls-tree is the one
  // reading here whose default output is cwd-prefix-relative; say so at the
  // call rather than rely on the cwd pin alone.
  const tree = await pinnedGit(["ls-tree", "-r", "-z", "--full-tree", "--name-only", "HEAD"]);
  if (!tree.ok) return { worktree: path, ok: false, error: tree.error };
  const treeFileCount = splitNul(tree.stdout).filter((name) => name.length > 0).length;

  let aheadBehind: { ahead: number; behind: number } | null = null;
  if (baseSha !== null) {
    // The base is the sweep-wide PINNED sha of the base ref (origin's
    // default branch, or the --base ref), not the mutable ref name: a
    // concurrent fetch moving the ref mid-sweep would otherwise give
    // different rows different bases.
    const counts = await pinnedGit(["rev-list", "--left-right", "--count", `${baseSha}...HEAD`]);
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
        error: `unparsable rev-list count: ${counts.stdout.toString("utf8")}`,
      };
    }
  }

  // Close the bracket: if HEAD or the branch moved while status/ls-tree/
  // rev-list ran, the readings above describe a mix of two states - refuse
  // the row rather than report an internally inconsistent one; the next
  // sweep re-measures.
  const headAfter = await pinnedGit(["rev-parse", "HEAD"]);
  if (!headAfter.ok) return { worktree: path, ok: false, error: headAfter.error };
  const headShaAfter = headAfter.stdout.toString("utf8").trim();
  if (headShaAfter !== headSha) {
    return {
      worktree: path,
      ok: false,
      error: `HEAD moved mid-row (${headSha} -> ${headShaAfter}); readings are inconsistent`,
    };
  }
  const branchAfter = await readBranch(pinnedGit);
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
export function controlFailureReason(control: WorktreeRow): string | null {
  const name = basename(control.worktree);
  const hasHead = control.ok && control.headSha.length > 0;
  const hasProcesses = control.ok && control.processes.length > 0;
  if (!control.ok || !(hasHead || hasProcesses)) {
    return `main checkout row (${name}) has no headSha and no processes: ${JSON.stringify(control)}`;
  }
  if (control.treeFileCount === 0) {
    return `main checkout row (${name}) has treeFileCount 0 at HEAD ${control.headSha}; an empty tree on the main checkout invalidates the positive control, and worktree rows cannot be compared against a zero baseline`;
  }
  return null;
}
