#!/usr/bin/env bun
// Retire a landed branch as one program: fetch, prove the landing, judge the
// worktree, remove it, delete the ref pinned to the judged sha. Every
// destructive call is unreachable from a failed gate.

import {
  type Gates,
  judgeWorktree,
  pathIsWithin,
  refuse,
  requireLanded,
  reverifyLanding,
  step,
} from "./retire/judge.mts";
import {
  armTeardown,
  broken,
  type Exit,
  emit,
  exitWith,
  FETCH_TIMEOUT_MS,
  fetchMainline,
  git,
  isShallow,
  listWorktrees,
  type Options,
  resolveCommit,
  resolveRef,
  runTeardown,
  short,
  stashesOnBranch,
} from "./retire/read.mts";

const EXIT_USAGE = 2;

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

const usage: Exit = (message) => exitWith(EXIT_USAGE, `${message}\n\n${USAGE}`);

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
  armTeardown(survivor);

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
