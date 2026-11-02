// codex's copy mode: a snapshot of the repository the review runs in when codex's bubblewrap sandbox
// cannot start, so a write the prompt forbade lands in the copy and never in the checkout.
// run-review.mts decides when the mode applies.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

const REVISION_FILES = [
  "ORIG_HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
];

interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
}

/** Runs one git command and returns its stdout. A failure throws, naming the
 * command and what git said; with `absentOk`, exit 1 is git's "nothing to
 * say" (`config --get` of an unset key) and returns null. Node passes `input`
 * only through a piped stdin (an ignored one drops it; bun passes it either
 * way). */
function git(args: string[], options?: GitOptions & { absentOk?: false }): Buffer;
function git(args: string[], options: GitOptions & { absentOk: true }): Buffer | null;
function git(args: string[], options: GitOptions & { absentOk?: boolean } = {}): Buffer | null {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: Number.MAX_SAFE_INTEGER,
  });
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && options.absentOk === true) return null;
  const detail = result.error?.message ?? result.stderr.toString().trim();
  throw new Error(`git ${args.join(" ")}: ${detail}`);
}

/** `GIT_DIR` and its siblings name the real repository by absolute path, and
 * `GIT_CONFIG_COUNT` with a `core.worktree` entry does the same by another
 * route, so a reviewer inheriting any `GIT_*` variable could read the live
 * index from inside the copy. Discovery from the copy's cwd is what the
 * snapshot is for, so none of them travel. */
export function withoutGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith("GIT_")) stripped[name] = value;
  }
  return stripped;
}

/** The remote's effective fetch URL (the first of several, `insteadOf`
 * applied), made absolute when it is a relative local path, since the copy
 * lives elsewhere. git reads such a path from the top level, and its local
 * transport is a chdir into the path and a discovery there, so the same
 * chdir asks git for the repository it finds (symlinks and `..` as the
 * kernel reads them). A `~` path git expands itself, in the copy too, and a
 * path with no repository is left as it is. */
function absoluteRemoteUrl(remote: string): string {
  const url = git(["ls-remote", "--get-url", remote]).toString().trim();
  const isLocalPath = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^[^/]+:/.test(url);
  if (!isLocalPath || isAbsolute(url) || url.startsWith("~")) return url;
  const top = git(["rev-parse", "--show-toplevel"]).toString().trim();
  const discover = [
    "-C",
    top,
    "-C",
    url,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ];
  try {
    return git(discover, { env: withoutGitEnv(process.env) })
      .toString()
      .trim();
  } catch {
    return url;
  }
}

/** The config that makes the copy fetch from the checkout's promisor remotes
 * as the checkout would (a partial clone reads a blob it lacks from them on
 * first use): each promisor remote's flag, its effective fetch URL, and its
 * partial-clone filter. git answers every question, so its boolean spellings
 * and URL rewrites hold. */
function promisorConfig(): [string, string][] {
  const config: [string, string][] = [];
  for (const remote of git(["remote"]).toString().split("\n").filter(Boolean)) {
    const promisorKey = `remote.${remote}.promisor`;
    const promisor = git(["config", "--type=bool", "--get", promisorKey], { absentOk: true });
    if (promisor?.toString().trim() !== "true") continue;
    config.push([promisorKey, "true"]);
    config.push([`remote.${remote}.url`, absoluteRemoteUrl(remote)]);
    const filterKey = `remote.${remote}.partialclonefilter`;
    const filter = git(["config", "--get", filterKey], { absentOk: true });
    if (filter !== null) config.push([filterKey, filter.toString().trim()]);
  }
  return config;
}

/** Reads of the checkout run where the launcher runs, with its environment:
 * a `GIT_DIR` there, relative or absolute, may be how the caller names the
 * repository. Every write into the copy drops the `GIT_*` variables, or it
 * would land in the checkout. */
function buildSnapshot(copy: string): void {
  const read = (...args: string[]) => git(args).toString().trim();
  const copyEnv = withoutGitEnv(process.env);
  const write = (args: string[], input?: Buffer) => git(args, { cwd: copy, env: copyEnv, input });

  const objectFormat = read("rev-parse", "--show-object-format");
  const objects = read("rev-parse", "--path-format=absolute", "--git-path", "objects");
  const shallow = read("rev-parse", "--path-format=absolute", "--git-path", "shallow");
  const index = read("rev-parse", "--path-format=absolute", "--git-path", "index");
  const gitDir = read("rev-parse", "--absolute-git-dir");
  const refs = git(["for-each-ref", "--format=update %(refname) %(objectname)"]);
  // Empty for a detached HEAD; an unborn branch has a name and no commit.
  const branch = read("branch", "--show-current");

  mkdirSync(copy);
  write(["init", "-q", `--object-format=${objectFormat}`]);
  writeFileSync(join(copy, ".git", "objects", "info", "alternates"), `${objects}\n`);
  // A shallow clone's boundary travels too, or a walk of the history in the
  // copy dies at the first missing parent.
  if (existsSync(shallow)) copyFileSync(shallow, join(copy, ".git", "shallow"));
  write(["update-ref", "--stdin"], refs);
  if (branch === "") {
    write(["update-ref", "--no-deref", "HEAD", read("rev-parse", "--verify", "HEAD")]);
  } else {
    write(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }
  // A branch diff in the copy may need a blob the checkout never read (a base
  // blob of a partial clone): with the promisor remotes along, the copy fetches
  // it as the checkout would, into its own store.
  for (const [key, value] of promisorConfig()) {
    write(["config", key, value]);
  }
  // Outside refs/, yet a prompt may name one as a diff base: the tip before a reset or rebase, the last fetch, the heads of an operation in progress.
  for (const name of REVISION_FILES) {
    if (existsSync(join(gitDir, name))) copyFileSync(join(gitDir, name), join(copy, ".git", name));
  }
  // The index file itself, so an intent-to-add, skip-worktree, or unmerged
  // entry keeps its flags (a listing of the entries would stage an
  // intent-to-add file outright); a split index's shared halves sit beside it.
  if (existsSync(index)) copyFileSync(index, join(copy, ".git", "index"));
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith("sharedindex.")) copyFileSync(join(gitDir, name), join(copy, ".git", name));
  }
  // The working tree as the checkout's own: a skip-worktree entry stays
  // absent, as under sparse checkout, where a partial clone may not even hold
  // its blob. `-u` points the copied stat data at the files just written, or
  // every status re-hashes them. Large-file pointers stay pointers: a smudge
  // filter would fetch what a review never reads.
  git(["checkout-index", "-a", "-u"], { cwd: copy, env: { ...copyEnv, GIT_LFS_SKIP_SMUDGE: "1" } });
}

function makeDirectoriesWritable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) makeDirectoriesWritable(join(path, entry.name));
  }
}

/** `force` skips what is missing, not what a tree's own modes refuse (a
 * populated 0555 directory copied as-is), so a refusal gets one retry with
 * every directory in the tree made writable by its owner first. What still
 * refuses is reported through `warn` and must never take the verdict or the
 * failure with it. */
export function removeTree(path: string, warn: (line: string) => void): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    // retried below with the modes repaired
  }
  try {
    makeDirectoriesWritable(path);
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    warn(`not removed ${path}: ${String(error)}`);
  }
}

/** The real path of `copy/subdir` when it is a directory inside the copy,
 * else null: a missing path, a path under a file (ENOTDIR), or one a staged
 * symlink on the way (the leaf or an ancestor) resolves out of the copy, into
 * the live checkout. The resolved path decides, never the lexical one. */
function directoryInside(copy: string, subdir: string): string | null {
  try {
    const root = realpathSync(copy);
    const real = realpathSync(join(copy, subdir));
    const inside = real === root || real.startsWith(`${root}${sep}`);
    return inside && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The copy is what git has committed or would commit, its object store
 * shared with the checkout through an alternates link, so `git diff --cached`
 * and `git diff <base>...HEAD` there show the change the prompt names. A
 * `cp -a` of the toplevel also carried the ignored trees (virtualenvs, nested
 * worktrees) and failed midway on a checkout of gigabytes; a linked worktree
 * is no copy, its `.git` points into the repository. SKILL.md names what
 * travels and what stays behind. */
export function snapshotRepository(
  launch: { root: string; subdir: string },
  scratchDir: string,
  warn: (line: string) => void,
) {
  const copy = join(scratchDir, "repo");
  try {
    buildSnapshot(copy);
  } catch (error) {
    // A copy that failed midway is still a copy: it goes with the failure,
    // not into a capture dir that is kept for a day.
    removeTree(copy, warn);
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false as const, reason: `snapshot of ${launch.root} failed: ${detail}` };
  }
  // The cwd's twin is a directory inside the copy when the cwd holds something
  // tracked; from an untracked or ignored directory, or one a staged file or
  // symlink replaced (itself or an ancestor), the reviewer starts at the
  // copy's root.
  return { ok: true as const, copy, cwd: directoryInside(copy, launch.subdir) ?? copy };
}
