// The readings retire-branch.mts judges: every git and lsof call, returned as
// data. A reading that cannot be taken exits BROKEN here, because "the
// question was never answered" is a fact about the read, not about the branch.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXIT_BROKEN = 3;
// Every spawn is bounded: an unbounded child would leave the run with no verdict.
export const FETCH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

export interface Options {
  branch: string;
  repoRoot: string;
  remote: string;
  mainline: string;
  originalTip: string | null;
  wantWriterCheck: boolean;
  execute: boolean;
}

// Every exit path drops the private ref this run created.
let teardownRoot: string | null = null;

export function runTeardown(): void {
  const root = teardownRoot;
  if (root === null) return;
  teardownRoot = null;
  const dropped = spawn(["git", "-C", root, "update-ref", "-d", "--no-deref", privateRef()]);
  if (dropped.status !== 0) emit(2, `note: ${privateRef()} was left behind in ${root}`);
}

export function armTeardown(root: string): void {
  teardownRoot = root;
}

export function emit(stream: 1 | 2, message: string): void {
  writeFileSync(stream, `${message}\n`);
}

export function exitWith(code: number, message: string): never {
  runTeardown();
  emit(2, message);
  process.exit(code);
}

// Explicit function types: TypeScript narrows after a `never` call only when the
// callee's type is declared, not inferred.
export type Exit = (message: string) => never;
export const broken: Exit = (message) => exitWith(EXIT_BROKEN, `BROKEN: ${message}`);
export const short = (sha: string): string => sha.slice(0, 12);

// Repository-selecting GIT_* variables are exported to hooks, and a hook-spawned
// run would retarget every command; only transport variables pass through.
const GIT_TRANSPORT = new Set(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_PROXY_COMMAND"]);

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && (!upper.startsWith("GIT_") || GIT_TRANSPORT.has(upper))) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

interface Run {
  readonly status: number;
  readonly out: Buffer;
  readonly text: string;
  readonly err: string;
}

// Raw stdout: a path listing need not be valid UTF-8. A null status is a child
// killed by a signal (the timeout path) and must not read as an exit code.
function spawn(argv: string[], timeoutMs = PROBE_TIMEOUT_MS): Run {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, {
    env: childEnv(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) broken(`${argv.join(" ")}: ${result.error.message}`);
  if (result.status === null) broken(`${argv.join(" ")}: killed by ${result.signal ?? "?"}`);
  const out = result.stdout ?? Buffer.alloc(0);
  const err = (result.stderr ?? Buffer.alloc(0)).toString("utf-8").trim();
  return { status: result.status, out, text: out.toString("utf-8"), err };
}

export function git(root: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Run {
  return spawn(["git", "-C", root, ...args], timeoutMs);
}

export function gitOrBroken(root: string, args: string[]): string {
  const run = git(root, args);
  if (run.status !== 0) broken(`git ${args.join(" ")} failed (exit ${run.status}): ${run.err}`);
  return run.text;
}

export function nulSplit(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= buffer.length; i += 1) {
    if (i === buffer.length || buffer[i] === 0) {
      if (i > start) parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

// --- refs ---------------------------------------------------------------------

export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// "Not there" and "could not be asked" are different answers: ABSENT reads as a
// lost lease at the deletion and as a confirmed deletion at the postcondition.
type Resolved =
  | { kind: "resolved"; sha: string }
  | { kind: "absent" }
  | { kind: "broken"; reason: string };

export function resolveRef(root: string, ref: string): Resolved {
  const bad = (reason: string): Resolved => ({ kind: "broken", reason });
  const run = git(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  const sha = run.text.trim();
  if (run.status === 0) {
    return COMMIT_ID.test(sha) ? { kind: "resolved", sha } : bad(`rev-parse ${ref} printed ${sha}`);
  }
  if (run.status !== 1) return bad(`rev-parse ${ref} exited ${run.status}: ${run.err}`);
  // A DANGLING symref reads as missing to rev-parse while the name is still there
  // (verified); reading it as absent prints LANDED over a branch that exists.
  const symref = git(root, ["symbolic-ref", "-q", "--", ref]);
  if (symref.status === 0) return bad(`${ref} is a dangling symbolic ref -> ${symref.text.trim()}`);
  if (symref.status !== 1)
    return bad(`symbolic-ref could not say whether ${ref} exists: ${symref.err}`);
  return { kind: "absent" };
}

export function resolveCommit(root: string, ref: string): string | null {
  const resolved = resolveRef(root, ref);
  return resolved.kind === "resolved" ? resolved.sha : null;
}

// FETCH_HEAD is one slot every fetch in the worktree rewrites, and these
// repositories are shared; a pid-namespaced ref this run owns removes the slot.
function privateRef(): string {
  return `refs/retire-branch/${process.pid}/mainline`;
}

export function fetchMainline(root: string, options: Options): string {
  // --no-deref: a fetch force-updating a SYMBOLIC ref writes its target (verified:
  // main lost a commit), so whatever sits at this name is removed as itself first.
  const cleared = git(root, ["update-ref", "-d", "--no-deref", privateRef()]);
  if (cleared.status !== 0)
    broken(`${privateRef()} could not be cleared before fetching: ${cleared.err}`);
  const refspec = `+refs/heads/${options.mainline}:${privateRef()}`;
  const args = ["fetch", "--no-tags", "--force", "--end-of-options", options.remote, refspec];
  const fetched = git(root, args, FETCH_TIMEOUT_MS);
  if (fetched.status !== 0)
    broken(`git fetch ${options.remote} ${options.mainline}: ${fetched.err}`);
  const tip = resolveRef(root, privateRef());
  if (tip.kind !== "resolved") broken(`the fetch left no usable ${options.mainline} tip`);
  return tip.sha;
}

// --- landing reads ---------------------------------------------------------------

// THE ARGUMENT ORDER IS THE WHOLE GATE: the swapped call asks whether the
// mainline is inside the branch, exits 0 on exactly the unlanded work this
// protects, and agrees with the right order after any fast-forward merge.
export function isContainedIn(root: string, args: { subject: string; reference: string }): number {
  const order = [args.subject, args.reference];
  return git(root, ["merge-base", "--is-ancestor", "--end-of-options", ...order]).status;
}

// `--no-renames` lists both halves of a rename so a surviving source cannot hide;
// no diff.relative or diff.ignoreSubmodules config may narrow the listing.
export const NAME_ONLY_DIFF = ["diff", "--no-renames", "--no-relative", "--ignore-submodules=none"];

// The merge result as `merge-tree --write-tree --name-only -z` prints it:
// <tree>NUL, then on a conflict each conflicted path NUL-terminated, and after
// an empty field the informational messages, which are cut at that double NUL.
// A conflict may name no path at all (a directory rename split), so the
// verdict is the exit status, never the path count.
type MergeResult =
  | { readonly kind: "clean"; readonly tree: string }
  | { readonly kind: "conflict"; readonly conflicted: Buffer[] };

export function mergeInto(
  root: string,
  reference: string,
  subject: string,
  why: string,
): MergeResult {
  // merge-tree prints conflicted paths relative to the cwd, and `root` may be a
  // nested --repo-root; the refusal names repository paths, so it runs from the top.
  const top = gitOrBroken(root, ["rev-parse", "--show-toplevel"]).replace(/\n$/, "");
  const args = ["merge-tree", "--write-tree", "--name-only", "-z", "--end-of-options"];
  const run = git(top, [...args, reference, subject], FETCH_TIMEOUT_MS);
  const command = `git merge-tree --write-tree ${short(reference)} ${short(subject)}`;
  // Exit 1 is also "not something we can merge", printed with no tree; only a
  // tree id in front makes a 1 a conflict. `--write-tree` arrived in git 2.38,
  // and an older git rejects the option with 129; any other exit (128 for
  // unrelated histories) is git's own message, not a version problem.
  if (run.status !== 0 && run.status !== 1) {
    const version =
      run.status === 129
        ? ` (${git(root, ["--version"]).text.trim() || "git version unknown"}; 2.38 or newer is required)`
        : "";
    broken(`${why} ${command} exited ${run.status}${version}: ${run.err}`);
  }
  const messages = run.out.indexOf(Buffer.from([0, 0]));
  const [tree = Buffer.alloc(0), ...conflicted] = nulSplit(
    messages === -1 ? run.out : run.out.subarray(0, messages),
  );
  const id = tree.toString("utf-8");
  if (!COMMIT_ID.test(id))
    broken(`${why} ${command} printed no tree (exit ${run.status}): ${run.err}`);
  return run.status === 1 ? { kind: "conflict", conflicted } : { kind: "clean", tree: id };
}

export function isShallow(root: string): boolean {
  const answer = gitOrBroken(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (answer !== "true" && answer !== "false") broken(`--is-shallow-repository printed ${answer}`);
  return answer === "true";
}

// --- worktree state ---------------------------------------------------------------

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  locked: string | null;
  isMain: boolean;
}

export function listWorktrees(root: string): Worktree[] {
  const trees: Worktree[] = [];
  for (const line of gitOrBroken(root, ["worktree", "list", "--porcelain"]).split("\n")) {
    const [key = "", ...rest] = line.split(" ");
    const value = rest.join(" ");
    const current = trees.at(-1);
    if (key === "worktree") {
      // git C-quotes a path with control or non-UTF-8 bytes; a guessed unquoting
      // would aim a removal at the wrong directory.
      if (value.startsWith('"')) broken(`git worktree list printed a quoted path: ${value}`);
      trees.push({
        path: value,
        head: null,
        branch: null,
        locked: null,
        isMain: trees.length === 0,
      });
    } else if (current !== undefined && key === "HEAD") current.head = value;
    else if (current !== undefined && key === "branch") current.branch = value;
    else if (current !== undefined && key === "locked")
      current.locked = value || "(no reason given)";
  }
  return trees;
}

const IN_PROGRESS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

// Read against the WORKTREE's own path: a status read through the parent would
// clear a worktree full of unsaved work. -uall overrides a
// status.showUntrackedFiles=no config that would hide the evidence.
export function captureWorktree(tree: Worktree): { refusals: string[]; ignoredCount: number } {
  if (!existsSync(tree.path))
    return {
      refusals: [`${tree.path} no longer exists (run: git worktree prune)`],
      ignoredCount: 0,
    };
  const refusals = tree.locked === null ? [] : [`the worktree is locked: ${tree.locked}`];
  const entries = gitOrBroken(tree.path, ["status", "--porcelain", "-uall"])
    .split("\n")
    .filter(Boolean);
  if (entries.length > 0)
    refusals.push(`${entries.length} uncommitted change(s): ${entries.slice(0, 10).join("; ")}`);
  // Ignored files die with the tree; a count that failed to be taken is not zero.
  const ignored = gitOrBroken(tree.path, ["status", "--porcelain", "-uall", "--ignored"]).split(
    "\n",
  );
  const gitDir = gitOrBroken(tree.path, ["rev-parse", "--absolute-git-dir"]).trim();
  for (const marker of IN_PROGRESS) {
    if (existsSync(join(gitDir, marker)))
      refusals.push(`an operation is in progress (${marker} present)`);
  }
  return { refusals, ignoredCount: ignored.filter((line) => line.startsWith("!!")).length };
}

// A stash survives the retirement in the shared refs/stash; it blocks because it
// is unfinished work belonging to the branch. Two signals: the reflog subject
// names the branch, or the stash sits at the branch tip (survives a rename).
export function stashesOnBranch(root: string, branch: string, branchTip: string): string[] {
  const listed = git(root, ["stash", "list", "--format=%gd%x1f%H%x1f%gs"]);
  const unread = "a stash list that failed to be read is not an empty stash list";
  if (listed.status !== 0) broken(`git stash list failed: ${listed.err} - ${unread}`);
  const entries: string[] = [];
  for (const line of listed.text.split("\n").filter(Boolean)) {
    const [selector = "", sha = "", subject = ""] = line.split("\x1f");
    const base = resolveRef(root, `${sha}^1`);
    if (base.kind !== "resolved") broken(`stash ${selector} has no readable parent - ${unread}`);
    const named = subject.startsWith(`WIP on ${branch}:`) || subject.startsWith(`On ${branch}:`);
    if (named || base.sha === branchTip) entries.push(`${selector}: ${subject}`);
  }
  return entries;
}

// The invoking shell usually stands in the worktree being retired, so ancestry
// tells it from a stranger; an ancestor is assumed to be WAITING for this run,
// which holds for a foreground invocation only.
function ancestorPids(): Set<string> {
  const parent = new Map<string, string>();
  for (const line of spawn(["ps", "-A", "-o", "pid=,ppid="]).text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) parent.set(match[1], match[2]);
  }
  const ancestors = new Set<string>();
  let pid = parent.get(String(process.pid));
  while (pid !== undefined && pid !== "0" && !ancestors.has(pid)) {
    ancestors.add(pid);
    pid = parent.get(pid);
  }
  return ancestors;
}

interface Writer {
  readonly description: string;
  readonly isAncestor: boolean;
}

// One global pass over cwd descriptors, filtered in-process; a non-zero exit is a
// PARTIAL scan and zero records means the instrument failed (this process alone
// has a cwd), and neither is an all-clear.
export function liveWriters(treePath: string): Writer[] {
  // Run from "/": this process usually stands in the tree it judges, and Linux
  // lsof forks a helper that would inherit that cwd and report itself as a writer.
  const result = spawnSync("lsof", ["-w", "-d", "cwd", "-F", "pcn"], {
    cwd: "/",
    encoding: "utf-8",
    env: childEnv(),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const probe = `the live-writer probe on ${treePath} could not run`;
  const remedy =
    "re-run where lsof works, or pass --no-writer-check to proceed without this evidence";
  if (result.error || result.stdout === null) broken(`${probe} (lsof did not run); ${remedy}`);
  if (result.status !== 0)
    broken(
      `${probe} (lsof exited ${result.status}: a partial scan is not an all-clear); ${remedy}`,
    );
  const prefix = treePath.endsWith("/") ? treePath : `${treePath}/`;
  const ownPid = String(process.pid);
  const ancestors = ancestorPids();
  const writers: Writer[] = [];
  let records = 0;
  let pid = "";
  let command = "";
  for (const line of result.stdout.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = value;
    else if (line.startsWith("c")) command = value;
    else if (line.startsWith("n")) {
      records += 1;
      if ((value === treePath || value.startsWith(prefix)) && pid !== ownPid) {
        writers.push({
          description: `pid ${pid} (${command}) cwd ${value}`,
          isAncestor: ancestors.has(pid),
        });
      }
    }
  }
  if (records === 0)
    broken(`${probe} (lsof returned zero cwd records: broken probe, not a quiet host); ${remedy}`);
  return writers;
}
