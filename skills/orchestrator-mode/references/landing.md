# Landing Modes

The three landing-mode procedures for orchestrator mode. Mode selection, who merges, and the universal rules that apply in every mode - the trivial-fix exception, visualization-first PR bodies, review-before-landing, the CI watcher after every push or merge, the exit-conditioned merge - are defined in the skill's Land section (6); the babysit-to-convergence loop for open PRs is the skill's Babysit section (5). The steps below only name WHEN those gates fire in each mode - their definitions and defaults live in the skill, not here.

The modes compose within one session; they are not mutually exclusive. Independent tracks ride flat PRs while a track that depends on a sibling's UNLANDED content stacks its PR on that branch - base set to the dependency's branch. When the dependency merges, FIRST restack the dependent branch onto the updated mainline, THEN retarget the PR - in that order, because a squash merge rewrites history: the dependency's commits are not ancestors of the squash commit, so retargeting without the rebase makes the lower track's commits reappear in the dependent PR's diff. The failure this composability kills, from production: a docs track's final round sat blocked for a full cycle waiting for a script-fix PR to merge, when basing the docs PR on the script-fix branch would have removed the wait entirely.

## Serial Landings (direct-push repos)

1. One pending change on the mainline at a time, in plan order.
2. Take the builder's branch (named in its completion signal) and prepare it per the repo's conventions: rebase onto the mainline, cherry-pick its commits, or export and apply its diff as a patch.
3. Re-run the gates on the result and run the review pass. Then land per the prep mode: a rebase or cherry-pick already leaves committed work, so fast-forward the mainline onto it and push; an applied patch is uncommitted, so commit it first, then push. Either way, what gets pushed is the MAINLINE, never the builder's branch.
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
#                                  restack upper layers onto the collected work first: submit
#                                  only pushes, it does not cascade-rebase, and track-2 was
#                                  branched before track-1's commits existed. The redirects
#                                  keep sync non-TTY: it has no prompt-suppression flag, and
#                                  on a terminal it opens a divergence wizard that blocks
#                                  automation instead of printing the "Sync aborted" text
#                                  the verdict check below reads.
gh stack submit --auto           # push all layers, open one draft PR each
# submit derives titles and bodies automatically (no body flag; a multi-commit
# layer's TITLE gets humanized from the branch name, which can violate title
# gates such as Conventional Commits) - rewrite BOTH into the repo's convention
# and the visualization-first format (Land section) before treating the PR as
# prepared:
gh pr edit <num> --title "<repo-convention title>" --body-file <file>  # once per PR submit just opened
# per converged layer, bottom-up:
gh stack merge <pr> --yes --squash   # or --merge / --rebase: the method is a per-repo choice
#                                      read from the repo's merge policy (settings, CONTRIBUTING,
#                                      recent history) or the setup interview - squash is only
#                                      the example; explicit on the first merge either way.
#                                      With a merge queue, merge returns success on ENQUEUE,
#                                      before the commits reach the mainline - enqueue is not
#                                      landed. WATCH until the PR is actually merged (mergedAt
#                                      set, the commit on the mainline) before the sync below:
#                                      same logs-vs-postcondition principle as the sync check.
gh pr ready <num> --undo             # FIRST: flip every about-to-be-restacked successor to
#                                      DRAFT before anything rewrites it. sync itself pushes
#                                      the rewritten branches, so drafting afterward leaves a
#                                      window where a still-ready successor exposes unverified
#                                      content to an auto-merge or user merge - close the
#                                      window before rewriting, not after (the skill's
#                                      Babysit-section both-directions draft rule, applied at
#                                      the restack site)
gh stack sync --prune < /dev/null > "$SYNC_OUT" 2>&1   # restack the remainder, drop merged
#                                      branches (same non-TTY capture as the pre-submit sync)
gh stack submit --auto               # push the restacked remainder so successor PRs update:
#                                      an unpushed restack leaves stale PRs whose CI never
#                                      covered what will actually merge, and the re-gate rule
#                                      (item 2 above) applies to every content-changed link
# re-gate and reconverge each content-changed successor, then flip it ready again
git checkout <mainline>              # back to the mainline once stack operations are done
```

Judge `gh stack sync` by BOTH signals, at both sync sites (the pre-submit restack and the post-merge sync): the exit code catches hard failures (nonzero on rebase conflicts and API failures), and the capture in `"$SYNC_OUT"` is scanned for ANY failure marker - "Sync aborted", "Push failed", error lines - not just the abort text, because gh-stack can print a failure, keep going, and still exit 0. Either signal failing (a nonzero exit OR any marker in the capture) stops the flow to reconcile first. Then, because absence of failure text is still not success, verify the POSTCONDITION sync existed to produce before continuing, per site: the pre-submit sync is verified by each successor's base containing the LOWER LAYER'S CURRENT TIP; the post-merge sync by the next layer's merge-base containing the MERGED MAINLINE COMMIT (or the stack status view showing the chain clean). Logs approximate; the postcondition is the truth - the same family as the exit-code lesson. And after any restack that changed a link's content, re-run the landing-gate review on that link (item 2 above) before it merges.

Worktree interplay: git refuses to check out a branch already checked out in a worktree, and builders hold their layer branches in theirs. So after `init`/`add` create the layer branches, the lead switches the main checkout back to the mainline BEFORE spawning builders, leaving every layer branch free for its builder's worktree; and the lead runs `rebase --upstack`/`sync`/`merge` from the main checkout only AFTER collecting (or removing) the owning builder's worktree, never while it is live. Removal itself is destructive: run the removal checks in `references/worktree-hygiene.md` (fresh status codes, no live processes with cwd inside the tree) before deleting anything. Collection is a HANDOFF: stopping a builder and removing its worktree transfers ownership of that layer branch to the lead's stack operations only - review fixes on a collected layer ALWAYS go to a FRESH builder in a NEW worktree, with no collection exception to the skill's findings-go-to-a-builder rule, and never by resurrecting the removed builder (a message to a stopped agent resumes it, into a directory that no longer exists; see `references/worktree-hygiene.md` on handovers). For a layer the main checkout itself holds - the bottom-layer anchor in the block above - release the branch first with `git checkout <mainline>` before creating the fix worktree, then recollect and re-anchor on a stack branch before the next stack command: the same one-branch-one-worktree rule this paragraph opens with. Until collection, layer commits happen only on that layer's branch in its builder's worktree; the lead's stack operations are the only cross-layer writes.

## A PR per Track (PR repos)

1. Each builder's branch becomes its own PR, opened as a DRAFT (title and description per the repo's conventions); it stays draft through its babysit loop, with the flip rules in both directions per the skill's Babysit section. The spawn brief says who does what: either the builder pushes its branch and opens the draft PR, reporting the URL in its signal, or the builder stays no-push and the lead pushes from the worktree and opens it. Creating and iterating many PRs in parallel is fine: the file whitelists that keep worktrees disjoint keep the PRs disjoint too.
2. What stays serial is merging into the shared base: merge one at a time in plan order (or hand the ordering to the repo's merge queue), and rebase or update each successor PR after the previous merge. The lead prepares each PR (gates green, landing-gate review converged, CI watched) and reports "ready to merge"; the merge itself is executed by the hand the setup interview named.
3. The landing-gate review runs on each PR's final state before merge; re-run it after any rebase that changes content.
