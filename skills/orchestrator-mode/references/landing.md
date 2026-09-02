# Landing Modes

A landing is two independent choices:

- The GATE, chosen once per session: direct commits to the mainline, or a PR before it.
- The BASE, chosen per track by the dependency graph: the mainline for independent work, the dependency's branch for work that builds on unlanded content.

The two sections below are the gate's two values. The base choice exists in direct mode too: dependent tracks still build branch-on-branch, they just land serially instead of via stacked PRs.

Who merges, the standing merge exceptions, show-the-change PR bodies, draft discipline, the exit-conditioned landing, and the babysit-to-convergence loop are defined in the `/pr-and-issue-discipline` skill. Review-before-landing and the CI watcher after every push or merge stay in orchestrator-mode's Land section (6), and the fleet-specific babysit addition (cross-track comment routing) in orchestrator-mode's Babysit section (5). The steps below only name WHEN those gates fire in each mode; their definitions and defaults live there, not here.

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

1. Tracks whose bases chain onto each other form a stack: each branch bases on its predecessor, so reviewers see only that track's delta. The chain is git branch-on-branch plus one PR per link, each PR's base set to its predecessor's branch (an independent track's PR bases on the mainline). A PR's base branch must exist in the BASE repository, so a stacked chain requires push access there: every layer branch is pushed to a writable remote of the base repository. When only a fork is writable, dependent tracks land serially instead (branch-on-branch builds, one PR at a time against the mainline, the next opened after its dependency merges).
2. The lead owns the stack: builders develop in their own worktrees against the agreed base branch and never restack. The lead integrates each converged branch into the chain, restacks successors, and pushes; the shared re-gate rule (item 3 above) applies to every link whose content a restack changed.
3. For a chain, the shared serial-merge rule takes its order from the chain: bottom-up, one link at a time; the whole chain never merges in one shot.
4. Parallel building is still fine: builders on later links start from the current state of the link below (or from the mainline plus an interface stub the brief names) and accept that their diff gets rebased when earlier links land. The shared-file content check from `references/fleet-monitor.md` applies to every restack.

The lead's loop, top to bottom. Nothing in the block may prompt: no interactive rebase, and any command that could open a prompt gets stdin closed (`< /dev/null`).

```bash
set -e                               # every step below is load-bearing: a failed rebase, push,
#                                      or check stops the flow HERE, before anything (a boundary
#                                      re-record, a push, a retarget) builds on the failure
export GIT_TERMINAL_PROMPT=0         # a credential prompt would hang the block; fail loudly instead
export GIT_SSH_COMMAND="ssh -oBatchMode=yes"  # the same for SSH remotes, which GIT_TERMINAL_PROMPT
#                                      does not cover: no passphrase or host-key prompts
export GH_PROMPT_DISABLED=1          # and for the gh commands below, which prompt on a TTY
#                                      independently of git's settings
export GH_REPO=<base-repo>           # pin every gh command to the BASE repository (owner/name):
#                                      in a multi-remote checkout gh infers its target from the
#                                      remotes and can pick the fork, where PRs cannot target
#                                      the canonical mainline (item 1 above)
git config rerere.enabled true       # record conflict resolutions once and replay them on later
#                                      restacks, in place of a hand-resolve (or a prompt) each time.
#                                      A repo-wide config write shared with every sibling worktree
#                                      (the /worktree-hygiene skill's shared-config rule) -
#                                      deliberate here, since replayed resolutions are wanted
#                                      session-wide. Every push below names its remote explicitly
#                                      (and GH_REPO pins the gh commands), so no pushDefault-style
#                                      write is needed here
# Chain setup, before spawning builders. Branch the bottom link off the DESIGNATED
# mainline explicitly - the interviewed one, not the repo default branch, which is
# wrong for a session targeting develop/release - and off its CURRENT remote tip,
# not a possibly stale local branch (the same FETCH_HEAD rule as the post-merge
# fetch below):
git fetch <base-remote> <mainline>
git checkout -b track-1 FETCH_HEAD
git checkout -b track-2 track-1  # one layer per track, in dependency order, each off its dependency's branch
git config branch.track-2.depTip "$(git rev-parse track-1)"
git checkout -b track-3 track-2  # a deeper chain continues the same two-line pattern per link
git config branch.track-3.depTip "$(git rev-parse track-2)"
#                                  record the dependency tip each layer branched from. The boundary
#                                  is MAINTAINED, not set-once (the direct gate's dependent-track
#                                  rule above): re-record it after every restack of the layer. A
#                                  stale recording replays later or rewritten dependency commits.
git checkout <mainline>              # release the layer branches for the builders' worktrees
# STOP: spawn the builders and let them commit each layer's work. When a layer's
# builder signals done, stop it and REMOVE its worktree (Worktree interplay,
# below): a branch checked out in ANY worktree cannot be checked out elsewhere,
# so every step below fails "already used by worktree" while a builder still
# holds its layer. Publishing before the layers carry the collected commits
# would publish EMPTY layer PRs.
# Restack each successor onto its dependency's collected work, bottom-up:
# track-2 was branched before track-1's commits existed. Per link: transplant
# only the delta past the recorded boundary, VALIDATE the postcondition (the
# link's base contains the dependency's current tip), and only then move the
# boundary - a boundary recorded before its check passes would, on a failed
# transplant, point at a dependency the branch never inherited, and a retry
# from it omits or replays commits. track-3 follows onto the restacked
# track-2 the same way:
git rebase --onto track-1 "$(git config branch.track-2.depTip)" track-2 < /dev/null
git merge-base --is-ancestor "$(git rev-parse track-1)" track-2 || exit 1  # STOP and reconcile; never continue to publish
git config branch.track-2.depTip "$(git rev-parse track-1)"
git rebase --onto track-2 "$(git config branch.track-3.depTip)" track-3 < /dev/null
git merge-base --is-ancestor "$(git rev-parse track-2)" track-3 || exit 1
git config branch.track-3.depTip "$(git rev-parse track-2)"
# Publish: push each layer branch, then open one draft PR per link with the base
# set EXPLICITLY (gh defaults --base to the repo default branch): the dependency's
# branch for a stacked link, the mainline for an independent track. The opener
# authors each title and body directly, per the repo's title convention and the
# PR-body shape (/pr-and-issue-discipline), so the PR is born prepared:
git push -u origin track-1 track-2 track-3
gh pr create --draft --head track-1 --base <mainline> --title "<repo-convention title>" --body-file <file>
gh pr create --draft --head track-2 --base track-1 --title "<repo-convention title>" --body-file <file>
gh pr create --draft --head track-3 --base track-2 --title "<repo-convention title>" --body-file <file>
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
gh pr merge <pr> --squash            # DELEGATED PATH ONLY: this line runs when the interview
#                                      delegated merging to the lead, a merge queue owns the
#                                      ordering, or a standing /pr-and-issue-discipline
#                                      exception applies.
#                                      The DEFAULT hand is the user, so the default loop stops
#                                      at flip-ready plus a "ready to merge" report per link.
#                                      Method: or --merge / --rebase - a per-repo choice read
#                                      from the repo's merge policy (settings, CONTRIBUTING,
#                                      recent history) or the setup interview; squash is only
#                                      the example, explicit on the first merge either way.
#                                      With a merge queue, merge returns success on ENQUEUE,
#                                      before the commits reach the mainline - enqueue is not
#                                      landed. WATCH until the PR is actually merged (mergedAt
#                                      set, the commit on the mainline) before restacking.
# After the lower link merges, the restack CASCADES bottom-up, one link at a time,
# and each link transplants onto ITS OWN dependency's new tip: only the IMMEDIATE
# successor moves onto the mainline; every higher link follows its REWRITTEN
# dependency (repeating the mainline command for a higher link would flatten the
# chain). Transplant only the delta: a squash merge rewrites history, so the
# dependency's commits are not ancestors of the squash commit, and a whole-branch
# rebase would replay the dependency's changes:
git fetch <base-remote> <mainline>   # from the remote the PR MERGES INTO: origin in a plain
#                                      clone, the canonical remote (not the writable fork remote)
#                                      in a fork checkout - a fork's mainline can lag the base
#                                      repository's and would fail every ancestry gate below. The
#                                      squash landed on the REMOTE mainline; fetch first, or the
#                                      transplant targets a stale pre-merge tip. The steps below
#                                      use FETCH_HEAD, the ref this fetch just wrote: whether the
#                                      fetch also updates the remote-tracking ref depends on the
#                                      remote's configured fetch mapping (the same distinction as
#                                      in the /worktree-hygiene skill), and a stale
#                                      remote-tracking ref would transplant onto a pre-merge tip
#                                      and record that stale boundary
exp2=$(git rev-parse track-2)        # expected remote tips, captured BEFORE the rewrite from the
exp3=$(git rev-parse track-3)        # LOCAL branch tips - the lead's own last-published values,
#                                      which nothing but this checkout can move: the push below
#                                      leases against these exact values. A bare --force-with-lease
#                                      leases on the shared remote-tracking refs instead, which
#                                      another worktree's fetch can advance mid-flow
#                                      (/worktree-hygiene) - the fetch would launder a racing
#                                      remote edit into a satisfied lease
git rebase --onto FETCH_HEAD "$(git config branch.track-2.depTip)" track-2 < /dev/null
git merge-base --is-ancestor FETCH_HEAD track-2 || exit 1  # STOP: reconcile before recording or pushing anything.
#                                      FETCH_HEAD is the merged mainline tip the fetch above wrote,
#                                      so the postcondition needs no hand-supplied commit id
git config branch.track-2.depTip "$(git rev-parse FETCH_HEAD)"   # the base moved and the check passed: re-record it
git rebase --onto track-2 "$(git config branch.track-3.depTip)" track-3 < /dev/null
git merge-base --is-ancestor "$(git rev-parse track-2)" track-3 || exit 1
git config branch.track-3.depTip "$(git rev-parse track-2)"
#                                      a third link (track-3, where the chain has one) transplants
#                                      onto the rewritten track-2, never onto the mainline, and so
#                                      on up the chain. Per link, the same rebase-validate-record
#                                      order as pre-publish: the postcondition (merged mainline
#                                      commit an ancestor of the immediate successor; each higher
#                                      link containing its rewritten dependency's tip) runs while
#                                      the remote is still untouched, BEFORE the boundary
#                                      re-record and the push, so a bad transplant stops the flow
#                                      with nothing built on it
git push --atomic origin \
  --force-with-lease=refs/heads/track-2:"$exp2" \
  --force-with-lease=refs/heads/track-3:"$exp3" \
  track-2 track-3                    # every rewritten link, in ONE transactional push, each
#                                      leased against its captured pre-rewrite tip: an unpushed
#                                      restack leaves a stale PR whose CI never covered what will
#                                      actually merge, and the shared re-gate rule (item 3 above)
#                                      applies to every content-changed link. --atomic makes a
#                                      failed lease on ANY ref reject the WHOLE cascade; without
#                                      it git can update one branch before rejecting another,
#                                      leaving the PR branches at mixed restack generations
gh pr edit <num> --base <mainline>   # retarget the IMMEDIATE successor's PR to the mainline (or
#                                      the next surviving dependency) AFTER the restack, never
#                                      before (restack-then-retarget, above). Higher links keep
#                                      their PR base: their dependency branch still exists
# re-gate and reconverge each content-changed successor, then flip it ready again
git checkout <mainline>              # back to the mainline once stack operations are done...
git merge --ff-only FETCH_HEAD       # ...and fast-forward it: the fetch above wrote FETCH_HEAD,
#                                      not the local branch, which still sits at its pre-merge
#                                      tip - a later track branched from it would omit the commit
#                                      that just landed
```

A failed step in this loop is loud on its own: a rebase stops on a conflict with a nonzero exit, and `--force-with-lease` refuses to push over a branch that moved under you. The block's `set -e` turns that loudness into a full stop, so no later step (a boundary re-record, a push, a retarget) builds on a failure. What still needs explicit verification is the POSTCONDITION each step exists to produce, per site: before publishing, each successor's base contains the dependency's current tip; after a merge, the next layer's merge-base contains the merged mainline commit (both `merge-base --is-ancestor` checks in the block). Logs approximate; the postcondition is the truth (`/verify-with-controls` rule 4).

Worktree interplay: git refuses to check out a branch already checked out in a worktree (the `/worktree-hygiene` skill's one-branch-one-worktree rule), and builders hold their layer branches in theirs.

- After the chain setup creates the layer branches, the lead switches the main checkout back to the mainline BEFORE spawning builders, leaving every layer branch free for its builder's worktree.
- The lead runs restacks and merges from the main checkout only AFTER collecting (or removing) the owning builder's worktree, never while it is live.
- Removal itself is destructive: run the removal checks in the `/worktree-hygiene` skill (fresh status codes, no live processes with cwd inside the tree) before deleting anything.
- Collection is a HANDOFF: stopping a builder and removing its worktree transfers ownership of that layer branch to the lead's stack operations only. Review fixes on a collected layer ALWAYS go to a FRESH builder in a NEW worktree, with no collection exception to the skill's findings-go-to-a-builder rule, and never by resurrecting the removed builder (a message to a stopped agent resumes it, into a directory that no longer exists; see the `/worktree-hygiene` skill on handovers).
- For a layer the main checkout itself holds (a rebase in the block above ends with that layer's branch checked out), release the branch first with `git checkout <mainline>` before creating the fix worktree, then recollect before the next restack touches that layer: the same one-branch-one-worktree rule this section opens with.
- Until collection, layer commits happen only on that layer's branch in its builder's worktree; the lead's restacks are the only cross-layer writes.
