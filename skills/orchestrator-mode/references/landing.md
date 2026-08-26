# Landing Modes

A landing is two independent choices:

- The GATE, chosen once per session: direct commits to the mainline, or a PR before it.
- The BASE, chosen per track by the dependency graph: the mainline for independent work, the dependency's branch for work that builds on unlanded content.

The two sections below are the gate's two values. The base choice exists in direct mode too: dependent tracks still build branch-on-branch, they just land serially instead of via stacked PRs.

Who merges, the standing merge exceptions, visualization-first PR bodies, draft discipline, the exit-conditioned landing, and the babysit-to-convergence loop are defined in the `/pr-and-issue-discipline` skill. Review-before-landing and the CI watcher after every push or merge stay in the skill's Land section (6), and the fleet-specific babysit additions (routing fixes to the owning builder, cross-track comment routing) in its Babysit section (5). The steps below only name WHEN those gates fire in each mode; their definitions and defaults live there, not here.

## Direct Commits to the Mainline

1. One pending change on the mainline at a time, in plan order.
2. Take the builder's branch (named in its completion signal) and prepare it per the repo's conventions: rebase onto the mainline, cherry-pick its commits, or export and apply its diff as a patch.
   - A DEPENDENT track (based on a sibling's branch) needs one extra recorded fact, MAINTAINED rather than set-once: the dependency's tip sha. Pin it when the upper track branches, and re-record it after every restack of the upper branch. The boundary tracks the branch's ACTUAL current base, so it updates at exactly the moments the base changes; a stale recording replays later or rewritten dependency commits.
   - At landing, transplant only the track-specific delta: `git rebase --onto <mainline> <recorded-dep-tip> <upper-branch>`. A dependency landed via squash or cherry-pick leaves its original commits outside the mainline's ancestry, so a whole-branch rebase would replay the dependency's changes.
   - The boundary must be RECORDED, not inferred: squash rewrites history (the same lesson as the PR gate's restack-before-retarget rule below).
3. Re-run the gates on the result and run the review pass. Then land per the prep mode: a rebase or cherry-pick already leaves committed work, so fast-forward the mainline onto it and push; an applied patch is uncommitted, so commit it first, then push. Either way, what gets pushed is the MAINLINE, never the builder's branch.
4. Keep the mainline tree frozen while a review round is in flight, and serialize resource-exclusive validation (fixed ports, shared stacks).

## PRs

The shared mechanics, for every PR in the session regardless of its base:

1. Each track's branch becomes its own PR, opened as a DRAFT (title and description per the repo's conventions); it stays draft through its babysit loop, with the flip rules in both directions per `/pr-and-issue-discipline`. The spawn brief says who does what: either the builder pushes its branch and opens the draft PR, reporting the URL in its signal, or the builder stays no-push and the lead pushes from the worktree and opens it. Creating and iterating many PRs in parallel is fine: the file whitelists that keep worktrees disjoint keep the PRs disjoint too.
2. What stays serial is merging into the shared base: merge one at a time in plan order (or hand the ordering to the repo's merge queue), and rebase or update each successor PR after the previous merge. The lead prepares each PR (gates green, landing-gate review converged, CI watched) and reports "ready to merge"; the merge itself is executed by the hand the setup interview named.
3. The landing-gate review runs on each PR's final state before merge; re-run it after any rebase or restack that changes content.

The PR's BASE is a per-track choice inside this one mode, set by the dependency graph; any combination coexists in one session.

- An independent track bases its PR on the mainline.
- A track that depends on a sibling's UNLANDED content bases its PR on that sibling's branch (a stacked PR).
- When the dependency merges, FIRST restack the dependent branch onto the updated mainline, THEN retarget the PR. In that order, because a squash merge rewrites history: the dependency's commits are not ancestors of the squash commit, so retargeting without the rebase makes the lower track's commits reappear in the dependent PR's diff.
- The failure the per-track choice kills, from production: a docs track's final round sat blocked for a full cycle waiting for a script-fix PR to merge, when basing the docs PR on the script-fix branch would have removed the wait entirely.

### Dependency-Based (Stacked) Tracks

Everything above still applies; this subsection only adds what is stack-specific.

1. Tracks whose bases chain onto each other form a stack: each branch bases on its predecessor, so reviewers see only that track's delta. Where the `/gh-stack` skill is installed, it owns the mechanics (creation, restack, submit, merge); otherwise maintain the chain with plain git branch-on-branch plus one PR per link, each PR's base set to its predecessor's branch.
2. The lead owns the stack: builders develop in their own worktrees against the agreed base branch and never restack. The lead integrates each converged branch into the chain, restacks successors, and pushes; the shared re-gate rule (item 3 above) applies to every link whose content a restack changed.
3. For a chain, the shared serial-merge rule takes its order from the chain: bottom-up, one link at a time; the whole chain never merges in one shot.
4. Parallel building is still fine: builders on later links start from the current state of the link below (or from the mainline plus an interface stub the brief names) and accept that their diff gets rebased when earlier links land. The shared-file content check from `references/fleet-monitor.md` applies to every restack.

With gh-stack, the lead's loop looks like this (all commands non-interactive per that skill's flag table: `--json`, `--auto`, `--yes`):

```bash
git config rerere.enabled true       # init prompts for this on a first TTY run; pre-enable to stay non-interactive
git config remote.pushDefault origin # multi-remote repos (fork checkouts) need an explicit push target; adjust origin to the writable remote
SYNC_OUT=$(mktemp)                   # per-run capture for the sync verdicts below: a fixed /tmp
#                                      path can be a pre-planted symlink (redirection follows
#                                      it) or be overwritten by a concurrent session before
#                                      its verdict is read
gh stack init track-1 --base <mainline>  # bottom of the chain, before spawning builders.
#                                  --base pins the trunk to the interviewed mainline: without
#                                  it init bases the chain on the repo DEFAULT branch, wrong
#                                  for a session targeting develop/release
gh stack add  track-2            # one layer per track, in dependency order
# STOP: switch the main checkout back to the mainline, spawn the builders,
# and let them commit each layer's work. When a layer's builder signals done,
# stop it and REMOVE its worktree (Worktree interplay, below): a branch
# checked out in ANY worktree cannot be checked out elsewhere, so every step
# below fails "already used by worktree" while a builder still holds its
# layer. Submitting before the layers carry the collected commits would
# publish EMPTY layer PRs.
git checkout track-1             # stack commands error (ErrNotInStack) from the mainline;
#                                  the bottom layer is the natural anchor to run them from
gh stack sync < /dev/null > "$SYNC_OUT" 2>&1
SYNC_STATUS=$?                       # capture immediately - nothing after the fact recovers $?
#                                  restack upper layers onto the collected work first: submit
#                                  only pushes, it does not cascade-rebase, and track-2 was
#                                  branched before track-1's commits existed. The redirects
#                                  keep sync non-TTY: it has no prompt-suppression flag, and
#                                  on a terminal it opens a divergence wizard that blocks
#                                  automation instead of printing the "Sync aborted" text
#                                  the verdict check below reads.
{ grep -qE "Stack synced|Branches synced" "$SYNC_OUT" && ! grep -qE "Push failed|Sync aborted" "$SYNC_OUT"; } || SYNC_STATUS=1
#                                  BOTH conditions required: gh-stack prints its final success
#                                  verdict unconditionally, even after logging "Push failed",
#                                  so presence-of-success and absence-of-failure each catch
#                                  what the other misses - neither alone suffices (and neither
#                                  can false-fail on branch names containing "error")
[ "$SYNC_STATUS" -ne 0 ] && exit 1   # STOP and reconcile (verdict rule below); never continue to submit
# postcondition before submit: each successor's base contains the lower layer's current tip
gh stack submit --auto           # push all layers, open one draft PR each
# submit derives titles and bodies automatically (no body flag; a multi-commit
# layer's TITLE gets humanized from the branch name, which can violate title
# gates such as Conventional Commits) - rewrite BOTH into the repo's convention
# and the visualization-first format (/pr-and-issue-discipline) before treating
# the PR as prepared:
gh pr edit <num> --title "<repo-convention title>" --body-file <file>  # once per PR submit just opened
# per converged layer, bottom-up:
gh pr ready <num> --undo             # BEFORE the lower link is even OFFERED as ready to merge
#                                      (or merged, in the delegated path): flip every dependent
#                                      successor to DRAFT. The exposure window opens the moment
#                                      the lower link becomes mergeable - once it merges, squash
#                                      plus base deletion mean a successor taken by auto-merge
#                                      or a fast user action in that window lands unrestacked
#                                      and un-regated. One successor draft span per link merge,
#                                      from offer to reconvergence (/pr-and-issue-discipline's
#                                      both-directions draft rule, applied at the restack site).
gh stack merge <pr> --yes --squash   # DELEGATED PATH ONLY: this line runs when the interview
#                                      delegated merging to the lead, a merge queue owns the
#                                      ordering, or a standing Land-section exception applies.
#                                      The DEFAULT hand is the user, so the default loop stops
#                                      at flip-ready plus a "ready to merge" report per link.
#                                      Method: or --merge / --rebase - a per-repo choice read
#                                      from the repo's merge policy (settings, CONTRIBUTING,
#                                      recent history) or the setup interview; squash is only
#                                      the example, explicit on the first merge either way.
#                                      With a merge queue, merge returns success on ENQUEUE,
#                                      before the commits reach the mainline - enqueue is not
#                                      landed. WATCH until the PR is actually merged (mergedAt
#                                      set, the commit on the mainline) before the sync below:
#                                      same logs-vs-postcondition principle as the sync check.
gh stack sync --prune < /dev/null > "$SYNC_OUT" 2>&1   # restack the remainder, drop merged
SYNC_STATUS=$?                       # same executable gate as the pre-submit sync
{ grep -qE "Stack synced|Branches synced" "$SYNC_OUT" && ! grep -qE "Push failed|Sync aborted" "$SYNC_OUT"; } || SYNC_STATUS=1
[ "$SYNC_STATUS" -ne 0 ] && exit 1   # STOP: reconcile before pushing or re-flipping anything
# postcondition before continuing: the next layer's merge-base contains the merged mainline commit
gh stack submit --auto               # push the restacked remainder so successor PRs update:
#                                      an unpushed restack leaves stale PRs whose CI never
#                                      covered what will actually merge, and the shared re-gate
#                                      rule (item 3 above) applies to every content-changed link
# re-gate and reconverge each content-changed successor, then flip it ready again
git checkout <mainline>              # back to the mainline once stack operations are done
```

Judge `gh stack sync` by ALL its signals, at both sync sites (the pre-submit restack and the post-merge sync):

- The exit code catches hard failures (nonzero on rebase conflicts and API failures).
- The capture in `"$SYNC_OUT"` must contain one of sync's documented SUCCESS verdicts ("Stack synced" or "Branches synced") AND no explicit failure marker ("Push failed", "Sync aborted"). gh-stack prints its final verdict unconditionally, even after logging a failure, so presence-of-success and absence-of-failure each catch what the other misses. Matching these exact strings cannot false-fail on branch names that merely contain "error".
- Any signal failing (a nonzero exit, a missing success verdict, or a failure marker present) stops the flow to reconcile first.
- Then, because a verdict line is still only a log, verify the POSTCONDITION sync existed to produce before continuing, per site. The pre-submit sync is verified by each successor's base containing the LOWER LAYER'S CURRENT TIP. The post-merge sync is verified by the next layer's merge-base containing the MERGED MAINLINE COMMIT (or the stack status view showing the chain clean). Logs approximate; the postcondition is the truth, the same family as the exit-code lesson.

Worktree interplay: git refuses to check out a branch already checked out in a worktree, and builders hold their layer branches in theirs.

- After `init`/`add` create the layer branches, the lead switches the main checkout back to the mainline BEFORE spawning builders, leaving every layer branch free for its builder's worktree.
- The lead runs `rebase --upstack`/`sync`/`merge` from the main checkout only AFTER collecting (or removing) the owning builder's worktree, never while it is live.
- Removal itself is destructive: run the removal checks in `references/worktree-hygiene.md` (fresh status codes, no live processes with cwd inside the tree) before deleting anything.
- Collection is a HANDOFF: stopping a builder and removing its worktree transfers ownership of that layer branch to the lead's stack operations only. Review fixes on a collected layer ALWAYS go to a FRESH builder in a NEW worktree, with no collection exception to the skill's findings-go-to-a-builder rule, and never by resurrecting the removed builder (a message to a stopped agent resumes it, into a directory that no longer exists; see `references/worktree-hygiene.md` on handovers).
- For a layer the main checkout itself holds (the bottom-layer anchor in the block above), release the branch first with `git checkout <mainline>` before creating the fix worktree, then recollect and re-anchor on a stack branch before the next stack command: the same one-branch-one-worktree rule this section opens with.
- Until collection, layer commits happen only on that layer's branch in its builder's worktree; the lead's stack operations are the only cross-layer writes.
