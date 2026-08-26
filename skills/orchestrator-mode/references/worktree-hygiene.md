# Worktree Hygiene

Rules for handovers, removals, and shared-worktree fan-outs. Each guards against a destructive failure seen in production.

## Handovers: Stop the Predecessor First

A message sent to a completed or idle agent RESUMES it. An acknowledgment or thank-you sent after a worktree handover wakes the predecessor, which resumes writing into the worktree its successor now owns (a live-writer clobber). The order is always: stop the agent first (TaskStop in Claude Code); any farewell after that is unnecessary.

A successor arriving in a shared worktree should hash-sleep-hash a hot file to prove there is no live writer before editing.

## Isolation Worktrees Auto-Remove When Clean

A stranded stop with a clean tree DESTROYS an isolation worktree: the harness auto-removes an isolation worktree when its agent completes unchanged, so a coordinator that stops to "wait for children" before any editor has written leaves its sub-editors working in a deleted directory.

- Coordinators in isolation worktrees must dirty the tree IMMEDIATELY on start; one untracked marker file at the worktree root is enough (e.g. `.orchestrator-keepalive`). The marker is never staged or committed; when later status reads judge "real work", a lone `??` for the marker is an artifact, not work. The coordinator deletes it before its final signal or handoff.
- Before resuming a worktree-isolated agent that stopped clean, verify the worktree still exists. Respawn fresh when it does not.

## Removing a Worktree

- Before any removal, run a FRESH `git -C <tree> status --porcelain` and read the STATUS CODES; never trust a prior report's dirty count. Counts cannot distinguish new files from removal-in-progress deletions; codes distinguish `??`/`M` real work from `D` artifacts and the coordinator's keepalive marker.
- Also BEFORE removing, check for processes whose cwd is inside the worktree (`lsof -a -p <pid> -d cwd`, or `lsof +D` on the path). A harness agent absent from the running list is not itself writing, but processes it spawned (test chains, installs) can still be; kill them or wait them out first.
- Removal does not kill survivors either: a landed builder's wedged test chain can outlive its deleted directory for hours. After removing, re-check and kill any process whose cwd names the deleted path.
- Delete the worktree's branch too once it is no longer needed, but verify the landing BY CONTENT first (see fleet-monitor.md, Verifying a Landing), never by what `git branch -d` says. In squash- and rebase-merge workflows `-d` refuses even after every successful landing (the local shas never land verbatim), so a refusal there is normal: verify by content, then `git branch -D`. Only in merge-commit and direct-push workflows does a refused `-d` actually indicate unlanded commits worth investigating.

## Unique Per-File Ownership Across Fan-Out Rounds

When a coordinator fans sub-editors into ONE worktree:

- Every file has exactly one owner across ALL rounds.
- A later round's list is computed by SUBTRACTING everything any earlier round covered, by file list, not by "looks done".
- No round starts while a prior round's editor may still be writing.

Re-assigning files a prior round still owns produces racing-writer collisions and duplicated work even when exact-match edit semantics prevent outright corruption.
