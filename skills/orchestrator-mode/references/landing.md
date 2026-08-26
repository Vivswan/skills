# Landing Modes

The three landing-mode procedures for orchestrator mode. Mode selection, who merges, and the universal rules that apply in every mode - the trivial-fix exception, visualization-first PR bodies, review-before-landing, the CI watcher after every push or merge, the exit-conditioned merge - are defined in the skill's Land section (6); the babysit-to-convergence loop for open PRs is the skill's Babysit section (5). The steps below only name WHEN those gates fire in each mode - their definitions and defaults live in the skill, not here.

## Serial Landings (direct-push repos)

1. One pending change on the mainline at a time, in plan order.
2. Take the builder's branch (named in its completion signal) and prepare it per the repo's conventions: rebase onto the mainline, cherry-pick its commits, or export and apply its diff as a patch.
3. Re-run the gates on the result, run the review pass, then commit and push.
4. Keep the mainline tree frozen while a review round is in flight, and serialize resource-exclusive validation (fixed ports, shared stacks).

## Stacked PRs (dependent tracks, one chain)

1. Tracks form a linear chain: each branch bases on its predecessor, not on the mainline, so reviewers see only that track's delta. Where the `/gh-stack` skill is installed, it owns the mechanics (creation, restack, submit, merge); otherwise maintain the chain with plain git branch-on-branch plus one PR per link, each PR's base set to its predecessor's branch.
2. The lead owns the stack: builders develop in their own worktrees against the agreed base branch and never restack; the lead integrates each converged branch into the chain, restacks successors, and pushes. After any restack, re-run the landing-gate review on every link whose content changed.
3. Merging goes bottom-up, one link at a time, in chain order; after each merge the lead restacks the remainder onto the mainline. The whole chain never merges in one shot. `gh stack merge` runs from whichever merging hand the setup interview named.
4. Parallel building is still fine: builders on later links start from the current state of the link below (or from the mainline plus an interface stub the brief names) and accept that their diff gets rebased when earlier links land - the shared-file content check from `references/fleet-monitor.md` applies to every restack.

With gh-stack, the lead's loop looks like (all commands non-interactive per that skill's flag table - `--json`, `--auto`, `--yes`):

```bash
git config rerere.enabled true       # init prompts for this on a first TTY run; pre-enable to stay non-interactive
git config remote.pushDefault origin # multi-remote repos (fork checkouts) need an explicit push target; adjust origin to the writable remote
gh stack init track-1            # bottom of the chain, before spawning builders
gh stack add  track-2            # one layer per track, in dependency order
# STOP: switch the main checkout back to the mainline, spawn the builders,
# and collect each layer's committed work (Worktree interplay, below).
# Submitting now would publish EMPTY layer PRs.
git checkout track-1             # stack commands error (ErrNotInStack) from the mainline;
#                                  the bottom layer is the natural anchor to run them from
gh stack sync                    # restack upper layers onto the collected work first:
#                                  submit only pushes, it does not cascade-rebase, and
#                                  track-2 was branched before track-1's commits existed
gh stack submit --auto           # push all layers, open one draft PR each
# submit derives titles and bodies automatically (no body flag) - rewrite
# each created PR body into the visualization-first format (Land section):
gh pr edit <num> --body-file <file>  # once per PR submit just opened
# per converged layer, bottom-up:
gh stack merge <pr> --yes --squash   # method explicit on the first merge
gh stack sync --prune                # restack the remainder, drop merged branches
git checkout <mainline>              # back to the mainline once stack operations are done
```

Read `gh stack sync`'s verdict in its OUTPUT, never its exit code - both the pre-submit restack and the post-merge sync: it can print "Sync aborted" and still exit 0, leaving successors silently stale. On an aborted sync, stop and reconcile before continuing - the same exit-code-vs-verdict rule the skill's Land section states for gates.

Worktree interplay: git refuses to check out a branch already checked out in a worktree, and builders hold their layer branches in theirs. So after `init`/`add` create the layer branches, the lead switches the main checkout back to the mainline BEFORE spawning builders, leaving every layer branch free for its builder's worktree; and the lead runs `rebase --upstack`/`sync`/`merge` from the main checkout only AFTER collecting (or removing) the owning builder's worktree, never while it is live. Layer commits happen only on that layer's branch in its builder's worktree; the lead's stack operations are the only cross-layer writes.

## A PR per Track (PR repos)

1. Each builder's branch becomes its own PR, opened as a DRAFT (title and description per the repo's conventions); it stays draft through its babysit loop, with the flip rules in both directions per the skill's Babysit section. The spawn brief says who does what: either the builder pushes its branch and opens the draft PR, reporting the URL in its signal, or the builder stays no-push and the lead pushes from the worktree and opens it. Creating and iterating many PRs in parallel is fine: the file whitelists that keep worktrees disjoint keep the PRs disjoint too.
2. What stays serial is merging into the shared base: merge one at a time in plan order (or hand the ordering to the repo's merge queue), and rebase or update each successor PR after the previous merge. The lead prepares each PR (gates green, landing-gate review converged, CI watched) and reports "ready to merge"; the merge itself is executed by the hand the setup interview named.
3. The landing-gate review runs on each PR's final state before merge; re-run it after any rebase that changes content.
