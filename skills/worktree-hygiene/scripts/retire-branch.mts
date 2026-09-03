#!/usr/bin/env bun
// Retire a landed branch as one program: fetch, prove the landing, judge the
// worktree, remove it, delete the ref pinned to the judged sha. Every
// destructive call is unreachable from a failed gate.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_BROKEN = 3;
// Every spawn is bounded: an unbounded child would leave the run with no verdict.
const FETCH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

const USAGE = [
  "usage: retire-branch.mts --branch <name> [options]",
  "",
  "  --branch <name>       the branch to retire (required)",
  "  --repo-root <path>    repository to operate in (default: cwd)",
  "  --remote <name>       remote to fetch the mainline from (default: origin)",
  "  --mainline <name>     branch the work must have landed on (default: main)",
  "  --original-tip <sha>  pre-rebase tip to also prove landed",
  "  --no-writer-check     skip the lsof live-writer probe (hosts without a usable lsof)",
  "  --execute             actually remove the worktree and delete the branch",
  "",
  "exit codes: 0 every requested step passed; 1 a gate refused on the evidence;",
  "            2 usage error; 3 broken measurement (the question was never answered)",
].join("\n");

interface Options {
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

function runTeardown(): void {
  const root = teardownRoot;
  if (root === null) return;
  teardownRoot = null;
  const dropped = spawn(["git", "-C", root, "update-ref", "-d", "--no-deref", privateRef()]);
  if (dropped.status !== 0) emit(2, `note: ${privateRef()} was left behind in ${root}`);
}

function emit(stream: 1 | 2, message: string): void {
  writeFileSync(stream, `${message}\n`);
}

function exitWith(code: number, message: string): never {
  runTeardown();
  emit(2, message);
  process.exit(code);
}

// Explicit function types: TypeScript narrows after a `never` call only when the
// callee's type is declared, not inferred.
type Exit = (message: string) => never;
const usage: Exit = (message) => exitWith(EXIT_USAGE, `${message}\n\n${USAGE}`);
const broken: Exit = (message) => exitWith(EXIT_BROKEN, `BROKEN: ${message}`);
const refuse: Exit = (message) => exitWith(EXIT_REFUSED, `REFUSED: ${message}`);
const step = (label: string, message: string): void => emit(1, `[${label}] ${message}`);
const short = (sha: string): string => sha.slice(0, 12);

// Single-quote for a POSIX shell: the hints this program prints are pasted.
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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

function git(root: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Run {
  return spawn(["git", "-C", root, ...args], timeoutMs);
}

function gitOrBroken(root: string, args: string[]): string {
  const run = git(root, args);
  if (run.status !== 0) broken(`git ${args.join(" ")} failed (exit ${run.status}): ${run.err}`);
  return run.text;
}

function nulSplit(buffer: Buffer): Buffer[] {
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

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// "Not there" and "could not be asked" are different answers: ABSENT reads as a
// lost lease at the deletion and as a confirmed deletion at the postcondition.
type Resolved =
  | { kind: "resolved"; sha: string }
  | { kind: "absent" }
  | { kind: "broken"; reason: string };

function resolveRef(root: string, ref: string): Resolved {
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

function resolveCommit(root: string, ref: string): string | null {
  const resolved = resolveRef(root, ref);
  return resolved.kind === "resolved" ? resolved.sha : null;
}

// FETCH_HEAD is one slot every fetch in the worktree rewrites, and these
// repositories are shared; a pid-namespaced ref this run owns removes the slot.
function privateRef(): string {
  return `refs/retire-branch/${process.pid}/mainline`;
}

function fetchMainline(root: string, options: Options): string {
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

// --- the landing gate ----------------------------------------------------------

// THE ARGUMENT ORDER IS THE WHOLE GATE: the swapped call asks whether the
// mainline is inside the branch, exits 0 on exactly the unlanded work this
// protects, and agrees with the right order after any fast-forward merge.
function isContainedIn(root: string, args: { subject: string; reference: string }): number {
  const order = [args.subject, args.reference];
  return git(root, ["merge-base", "--is-ancestor", "--end-of-options", ...order]).status;
}

// `--no-renames` splits a rename so a missing deletion cannot hide; no ext diff,
// textconv, diff.relative or diff.ignoreSubmodules config may narrow or suppress
// a difference.
const NAME_ONLY_DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative"];
const NAME_ONLY_TAIL = ["--ignore-submodules=none", "--name-only", "-z"];

interface Landing {
  readonly root: string;
  readonly shallow: boolean;
  readonly label: string;
  readonly subject: string;
  readonly reference: string;
}

function namesDiffering(root: string, from: string, to: string, why: string): Buffer[] {
  const run = git(root, [...NAME_ONLY_DIFF, ...NAME_ONLY_TAIL, from, to, "--"], FETCH_TIMEOUT_MS);
  if (run.status !== 0) broken(`${why} git diff ${short(from)} ${short(to)}: ${run.err}`);
  return nulSplit(run.out);
}

// ONE place where a containment answer becomes a verdict. Squash and rebase
// merges never put the branch's shas on the mainline, so content settles them:
// every path the branch changed since its merge-base must match the mainline tip.
function requireLanded(check: Landing): string {
  const { root, label, subject, reference } = check;
  const containment = isContainedIn(root, { subject, reference });
  if (containment === 0) return `by ancestry: ${label} is contained in ${short(reference)}`;
  if (containment !== 1)
    broken(`merge-base --is-ancestor exited ${containment}: unanswered question`);
  // A shallow clone treats its grafted boundary as a root: this negative is not evidence.
  if (check.shallow)
    broken(`${label} looks unlanded, but this is a SHALLOW repository: fetch --unshallow first`);
  const notContained = `${label} (${short(subject)}) is NOT contained in the mainline tip (${short(reference)})`;
  const couldNotRun = `${notContained}, and the content check could not run:`;
  const mergeBase = git(root, ["merge-base", "--end-of-options", reference, subject]);
  const base = mergeBase.text.trim();
  if (mergeBase.status !== 0 || !COMMIT_ID.test(base)) broken(`${couldNotRun} ${mergeBase.err}`);
  const changed = namesDiffering(root, base, subject, couldNotRun);
  if (changed.length === 0) refuse(`${notContained}, and there is no delta to judge by content`);
  // Intersected by raw bytes rather than passed back as pathspecs: a pathspec
  // round-trip would re-encode the names and is bounded by ARG_MAX.
  const changedKeys = new Set(changed.map((path) => path.toString("latin1")));
  const atTip = namesDiffering(root, reference, subject, couldNotRun);
  const differing = atTip.filter((path) => changedKeys.has(path.toString("latin1")));
  if (differing.length > 0) {
    const shown = differing
      .slice(0, 10)
      .map((path) => path.toString("utf-8"))
      .join(", ");
    refuse(
      `${notContained}, and its content differs from that tip on ${differing.length} path(s): ${shown}`,
    );
  }
  return `by content equivalence at ${short(base)}: ${label} matches ${short(reference)} on all ${changed.length} path(s) it changed`;
}

function isShallow(root: string): boolean {
  const answer = gitOrBroken(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (answer !== "true" && answer !== "false") broken(`--is-shallow-repository printed ${answer}`);
  return answer === "true";
}

// --- worktree state ---------------------------------------------------------------

interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  locked: string | null;
  isMain: boolean;
}

function listWorktrees(root: string): Worktree[] {
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
function captureWorktree(tree: Worktree): { refusals: string[]; ignoredCount: number } {
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
function stashesOnBranch(root: string, branch: string, branchTip: string): string[] {
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
function liveWriters(treePath: string): Writer[] {
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

// --- the retirement --------------------------------------------------------------

const VALUED_FLAGS = {
  "--branch": "branch",
  "--repo-root": "repoRoot",
  "--remote": "remote",
  "--mainline": "mainline",
  "--original-tip": "originalTip",
} as const;

function parseOptions(argv: string[]): Options {
  const options: Options = {
    branch: "",
    repoRoot: process.cwd(),
    remote: "origin",
    mainline: "main",
    originalTip: null,
    wantWriterCheck: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (flag in VALUED_FLAGS) {
      const value = argv[++i];
      // A refname or path never begins with "-": this is the NEXT flag swallowed.
      if (value === undefined || value.startsWith("-")) usage(`${flag} needs a value`);
      options[VALUED_FLAGS[flag as keyof typeof VALUED_FLAGS]] = value;
    } else if (flag === "--no-writer-check") options.wantWriterCheck = false;
    else if (flag === "--execute") options.execute = true;
    else usage(`unknown option: ${flag}`);
  }
  if (options.branch === "") usage("--branch is required");
  if (options.branch === options.mainline)
    usage(
      `--branch and --mainline are both '${options.branch}'; that would judge the mainline against itself and then delete it`,
    );
  return options;
}

function pathIsWithin(inner: string, outer: string): boolean {
  let a = inner;
  let b = outer;
  try {
    a = realpathSync(inner);
    b = realpathSync(outer);
  } catch {
    // Compared as given; the anchored choice is the safe one either way.
  }
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

interface Gates {
  readonly root: string;
  readonly options: Options;
  readonly shallow: boolean;
  readonly branchRef: string;
  readonly branchTip: string;
  readonly originalTip: string | null;
  readonly reference: string;
}

// Re-fetched as late as it usefully can be: a mainline rewritten while the gates
// ran recreates the stale-reference false-allow.
function reverifyLanding(gates: Gates): void {
  const { root, options, shallow, branchTip, originalTip, reference } = gates;
  const currentTip = fetchMainline(root, options);
  if (currentTip === reference) {
    step("recheck", `${options.remote}/${options.mainline} did not move; the gates still hold`);
    return;
  }
  const moved = `${options.remote}/${options.mainline} moved ${short(reference)} -> ${short(currentTip)} while the gates ran`;
  step("recheck", moved);
  const label = `${options.branch} (re-checked: ${moved})`;
  step(
    "recheck",
    requireLanded({ root, shallow, label, subject: branchTip, reference: currentTip }),
  );
  if (originalTip !== null) {
    const original = `the pre-rebase tip (re-checked: ${moved})`;
    step(
      "recheck",
      requireLanded({
        root,
        shallow,
        label: original,
        subject: originalTip,
        reference: currentTip,
      }),
    );
  }
}

// Run once before the destructive phase and again immediately before the removal:
// a tree can switch branches, commit, or acquire work or a stranger in between.
function judgeWorktree(gates: Gates, holder: Worktree, phase: "first" | "final"): void {
  const { root, options, branchRef, branchTip } = gates;
  const late = phase === "final" ? " while the gates ran" : "";
  const holders = listWorktrees(root).filter((tree) => tree.branch === branchRef);
  const held = holders[0];
  if (holders.length !== 1 || held === undefined || held.path !== holder.path) {
    const now = holders.map((tree) => tree.path).join(", ") || "nobody";
    refuse(`${holder.path} no longer holds ${branchRef} on its own (now held by: ${now})`);
  }
  if (held.head !== null && held.head !== branchTip) {
    refuse(
      `${holder.path} committed${late} (${branchRef} is now at ${short(held.head)}, verified at ${short(branchTip)})`,
    );
  }
  const capture = captureWorktree(held);
  const refusals = capture.refusals;
  for (const entry of stashesOnBranch(root, options.branch, branchTip)) {
    refusals.push(`a stash belongs to this branch: ${entry}`);
  }
  // `update-ref -d` deletes a checked-out branch (the `branch -d` guard does not
  // apply), and the main worktree cannot be removed.
  if (holder.isMain)
    refusals.push(
      `${branchRef} is checked out in the MAIN worktree; switch it to another branch first`,
    );
  if (!options.wantWriterCheck) {
    if (phase === "first")
      step("worktree", "live-writer probe SKIPPED (--no-writer-check): no evidence either way");
  } else {
    for (const writer of liveWriters(holder.path)) {
      if (!writer.isAncestor)
        refusals.push(
          `a live process has its cwd inside the worktree${late}: ${writer.description}`,
        );
      else if (phase === "first")
        step(
          "worktree",
          `your own shell is inside this worktree (${writer.description}); cd out afterwards`,
        );
    }
  }
  if (capture.ignoredCount > 0) {
    const list = `git -C ${quote(holder.path)} status --porcelain -uall --ignored`;
    step(
      "worktree",
      `${capture.ignoredCount} ignored file(s) will be destroyed with the tree (list them with: ${list})`,
    );
  }
  if (refusals.length > 0)
    refuse(`the worktree ${holder.path} holds work${late}:\n  - ${refusals.join("\n  - ")}`);
  // The tip again, LAST: the probes above are several subprocesses.
  const tipNow = resolveRef(root, branchRef);
  if (tipNow.kind !== "resolved") broken(`${branchRef} could not be re-read before the removal`);
  if (tipNow.sha !== branchTip)
    refuse(
      `${branchRef} moved to ${short(tipNow.sha)} while the final checks ran (verified at ${short(branchTip)})`,
    );
}

function retire(options: Options): void {
  const root = options.repoRoot;
  // A BARE repository answers "false" on a ZERO exit; the answer is the stdout.
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) broken(`${root} is not a git working tree: ${inside.err}`);
  if (inside.text.trim() !== "true")
    broken(`${root} is a bare repository; a working tree is needed`);

  // ALL holders: forced checkouts defeat git's one-branch-one-worktree guard.
  const branchRef = `refs/heads/${options.branch}`;
  const worktrees = listWorktrees(root);
  const mainWorktree = worktrees[0];
  if (mainWorktree === undefined) broken(`git worktree list reported no worktrees for ${root}`);
  const holders = worktrees.filter((tree) => tree.branch === branchRef);
  if (holders.length > 1)
    refuse(
      `${branchRef} is checked out in ${holders.length} worktrees at once; release all but one first`,
    );
  const holder = holders[0];
  // `root` honours --repo-root for every gate; `survivor` is a directory this run
  // can never remove, used only for the commands that outlive the removal.
  let survivor = root;
  if (holder !== undefined && !holder.isMain && pathIsWithin(root, holder.path)) {
    survivor = mainWorktree.path;
    step(
      "anchor",
      `--repo-root is inside the worktree being retired; the removal and the deletion run from ${survivor}`,
    );
  }
  const shallow = isShallow(root);
  teardownRoot = survivor;

  // A remote-tracking ref is a CACHE: after a non-fast-forward rewrite it may still
  // contain the branch. Read first only to show the operator; judged never.
  const trackingBefore = resolveCommit(root, `refs/remotes/${options.remote}/${options.mainline}`);
  const reference = fetchMainline(root, options);
  const trackingNote =
    trackingBefore === null
      ? "no remote-tracking ref existed to compare"
      : trackingBefore === reference
        ? "the remote-tracking ref was already current"
        : `the pre-fetch ${options.remote}/${options.mainline} was STALE at ${short(trackingBefore)}`;
  step("fetch", `${options.remote}/${options.mainline} -> ${reference} (${trackingNote})`);

  const branchTip = resolveCommit(root, branchRef);
  if (branchTip === null)
    broken(`${branchRef} does not resolve to a commit: an unanswered question, not a passed gate`);
  // `update-ref -d` dereferences by default: deleting a symbolic refs/heads/topic
  // that points at main deletes MAIN while every gate passes (verified).
  const symbolic = git(root, ["symbolic-ref", "-q", "--", branchRef]);
  if (symbolic.status === 0)
    refuse(
      `${branchRef} is a SYMBOLIC ref -> ${symbolic.text.trim()}; deleting it would delete that target. Resolve the symbolic ref before retrying.`,
    );
  if (symbolic.status !== 1)
    broken(`git symbolic-ref could not say whether ${branchRef} is symbolic: ${symbolic.err}`);
  step("branch", `${branchRef} is at ${branchTip}`);

  step(
    "landed",
    requireLanded({ root, shallow, label: options.branch, subject: branchTip, reference }),
  );
  let originalTip: string | null = null;
  if (options.originalTip !== null) {
    originalTip = resolveCommit(root, options.originalTip);
    if (originalTip === null)
      broken(`--original-tip ${options.originalTip} does not resolve to a commit`);
    step(
      "landed",
      requireLanded({
        root,
        shallow,
        label: "the pre-rebase tip",
        subject: originalTip,
        reference,
      }),
    );
  }
  const gates: Gates = { root, options, shallow, branchRef, branchTip, originalTip, reference };

  if (holder === undefined) {
    step("worktree", `no worktree holds ${branchRef}`);
    const stashes = stashesOnBranch(root, options.branch, branchTip);
    if (stashes.length > 0)
      refuse(`${options.branch} has unfinished stashed work:\n  - ${stashes.join("\n  - ")}`);
  } else {
    judgeWorktree(gates, holder, "first");
    step("worktree", `${holder.path} is clean and idle`);
    if (!options.execute) step("worktree", `would remove ${holder.path} (add --execute)`);
  }

  if (!options.execute) {
    step("delete", `would delete ${branchRef} at ${branchTip} (add --execute)`);
    runTeardown();
    emit(1, `REHEARSED: every gate passed for ${options.branch}; nothing was destroyed`);
    return;
  }
  // Every network read and content gate runs BEFORE the removal; between the
  // removal and the pinned deletion only the holder re-scan and the lease refuse.
  reverifyLanding(gates);
  if (holder !== undefined) {
    judgeWorktree(gates, holder, "final");
    // Removal BEFORE deletion: `worktree remove` refuses a tree whose branch ref
    // is gone (HEAD stops resolving, every file reads as untracked).
    const removed = git(survivor, ["worktree", "remove", "--", holder.path], FETCH_TIMEOUT_MS);
    if (removed.status !== 0) broken(`git worktree remove ${holder.path} failed: ${removed.err}`);
    step("worktree", `removed ${holder.path}`);
  }
  const holdersNow = listWorktrees(survivor).filter((tree) => tree.branch === branchRef);
  if (holdersNow.length > 0)
    refuse(
      `${branchRef} acquired a worktree while the gates ran (${holdersNow.map((tree) => tree.path).join(", ")})`,
    );

  // Pinned to the judged sha: `branch -D` deletes whatever the name points at now;
  // this refuses a push that landed between the gate and the deletion. --no-deref:
  // a ref that turned symbolic since the check can only delete ITSELF.
  const deleted = git(survivor, [
    "update-ref",
    "-d",
    "--no-deref",
    "--end-of-options",
    branchRef,
    branchTip,
  ]);
  if (deleted.status !== 0) {
    const nowAt = resolveRef(survivor, branchRef);
    if (nowAt.kind === "broken")
      broken(
        `${branchRef} could not be deleted (${deleted.err}) AND could not be re-read (${nowAt.reason})`,
      );
    if (nowAt.kind === "resolved" && nowAt.sha === branchTip)
      broken(
        `${branchRef} is still at the verified ${short(branchTip)} but the deletion failed: ${deleted.err}. The lease held; the write did not.`,
      );
    const now = nowAt.kind === "absent" ? "the ref is gone" : `now ${short(nowAt.sha)}`;
    refuse(
      `${branchRef} was not deleted: it is no longer at the verified ${short(branchTip)} (${now}). Something landed between the gate and the deletion; re-run.`,
    );
  }
  // The postcondition, checked rather than inferred: only ABSENT confirms it.
  const afterDelete = resolveRef(survivor, branchRef);
  if (afterDelete.kind === "broken")
    broken(
      `update-ref reported success but ${branchRef} could not be re-read to confirm it (${afterDelete.reason})`,
    );
  if (afterDelete.kind === "resolved")
    broken(
      `update-ref reported success but ${branchRef} still resolves to ${short(afterDelete.sha)}`,
    );
  step("delete", `deleted ${branchRef} (was ${branchTip})`);
  runTeardown();
  emit(1, `LANDED: ${options.branch} retired at ${branchTip}`);
}

retire(parseOptions(process.argv.slice(2)));
