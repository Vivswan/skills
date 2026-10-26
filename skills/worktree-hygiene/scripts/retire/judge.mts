// The judgments retire-branch.mts prints: landed by ancestry or by three-way
// merge, which worktree holds the branch and whether it may go, and the
// re-checks before the destructive phase. Every reading comes from read.mts.

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  broken,
  COMMIT_ID,
  captureWorktree,
  type Exit,
  emit,
  exitWith,
  fetchMainline,
  git,
  gitOrBroken,
  isContainedIn,
  listWorktrees,
  liveWriters,
  mergeInto,
  NAME_ONLY_DIFF,
  nulSplit,
  type Options,
  resolveRef,
  short,
  stashesOnBranch,
  type Worktree,
} from "./read.mts";

const EXIT_REFUSED = 1;

export const refuse: Exit = (message) => exitWith(EXIT_REFUSED, `REFUSED: ${message}`);
export const step = (label: string, message: string): void => emit(1, `[${label}] ${message}`);

// Single-quote for a POSIX shell: the hints this program prints are pasted.
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// --- the landing gate ----------------------------------------------------------

interface Landing {
  readonly root: string;
  readonly shallow: boolean;
  readonly label: string;
  readonly subject: string;
  readonly reference: string;
}

const showPaths = (paths: Buffer[]): string =>
  paths
    .slice(0, 10)
    .map((path) => path.toString("utf-8"))
    .join(", ");

// ONE place where a containment answer becomes a verdict. Squash and rebase
// merges never put the branch's shas on the mainline, so a three-way merge
// settles them: merging the branch into the mainline tip must give back that
// tip's own tree, which means the branch carries nothing the mainline lacks.
// A two-endpoint diff against the tip is the wrong question: a later mainline
// edit of a file the branch touched differs there while the branch is landed.
export function requireLanded(check: Landing): string {
  const { root, label, subject, reference } = check;
  const containment = isContainedIn(root, { subject, reference });
  if (containment === 0) return `by ancestry: ${label} is contained in ${short(reference)}`;
  if (containment !== 1)
    broken(`merge-base --is-ancestor exited ${containment}: unanswered question`);
  // A shallow clone treats its grafted boundary as a root: this negative is not evidence.
  if (check.shallow)
    broken(`${label} looks unlanded, but this is a SHALLOW repository: fetch --unshallow first`);
  const notContained = `${label} (${short(subject)}) is NOT contained in the mainline tip (${short(reference)})`;
  const couldNotRun = `${notContained}, and the merge check could not run:`;
  const mainline = gitOrBroken(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${reference}^{tree}`,
  ]).trim();
  if (!COMMIT_ID.test(mainline))
    broken(`${couldNotRun} rev-parse ${short(reference)}^{tree} printed ${mainline}`);
  const merged = mergeInto(root, reference, subject, couldNotRun);
  if (merged.kind === "conflict") {
    const where =
      merged.conflicted.length > 0
        ? `on ${merged.conflicted.length} path(s): ${showPaths(merged.conflicted)}`
        : "without a file-level path (a directory rename split)";
    refuse(`${notContained}, and merging it there CONFLICTS ${where}`);
  }
  if (merged.tree !== mainline) {
    const listing = git(root, [
      ...NAME_ONLY_DIFF,
      "--name-only",
      "-z",
      mainline,
      merged.tree,
      "--",
    ]);
    if (listing.status !== 0)
      broken(`${couldNotRun} git diff ${short(mainline)} ${short(merged.tree)}: ${listing.err}`);
    const changed = nulSplit(listing.out);
    if (changed.length === 0)
      broken(
        `${couldNotRun} the merged tree ${short(merged.tree)} differs from ${short(mainline)} on no listed path`,
      );
    refuse(
      `${notContained}, and merging it there would still change ${changed.length} path(s): ${showPaths(changed)}`,
    );
  }
  return `by three-way merge: ${label} merges into ${short(reference)} without changing its tree`;
}

// --- the worktree gate ---------------------------------------------------------

export function pathIsWithin(inner: string, outer: string): boolean {
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

export interface Gates {
  readonly root: string;
  readonly options: Options;
  readonly shallow: boolean;
  readonly branchRef: string;
  readonly branchTip: string;
  readonly originalTip: string | null;
  readonly reference: string;
}

type Phase = "first" | "final";

// Re-fetched as late as it usefully can be: a mainline rewritten while the gates
// ran recreates the stale-reference false-allow.
export function reverifyLanding(gates: Gates): void {
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

function requireSoleHolder(gates: Gates, holder: Worktree, late: string): Worktree {
  const { root, branchRef, branchTip } = gates;
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
  return held;
}

function writerRefusals(holder: Worktree, phase: Phase, late: string): string[] {
  const refusals: string[] = [];
  for (const writer of liveWriters(holder.path)) {
    if (!writer.isAncestor) {
      refusals.push(`a live process has its cwd inside the worktree${late}: ${writer.description}`);
      continue;
    }
    if (phase === "first")
      step(
        "worktree",
        `your own shell is inside this worktree (${writer.description}); cd out afterwards`,
      );
  }
  return refusals;
}

// Run once before the destructive phase and again immediately before the removal:
// a tree can switch branches, commit, or acquire work or a stranger in between.
export function judgeWorktree(gates: Gates, holder: Worktree, phase: Phase): void {
  const { root, options, branchRef, branchTip } = gates;
  const late = phase === "final" ? " while the gates ran" : "";
  const held = requireSoleHolder(gates, holder, late);
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
  if (options.wantWriterCheck) {
    refusals.push(...writerRefusals(holder, phase, late));
  } else if (phase === "first") {
    step("worktree", "live-writer probe SKIPPED (--no-writer-check): no evidence either way");
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
