---
name: worktree-hygiene
description: Use when creating, removing, or handing over git worktrees, or when several actors share one repository through worktrees.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Worktree Hygiene

> A worktree is shared mutable state: removal is destructive, a handover is an ownership transfer, and every worktree shares the main repository's `.git`. Each rule below guards against a destructive failure seen in production.

"An actor" below is anything that writes into a worktree: an agent, a subagent, a human session, a process one of them spawned.

## When to Apply

- Removing a git worktree or deleting its branch
- Handing a worktree or branch from one actor to another, or resuming an actor that owns one
- Several actors (agents, sessions, scripts) share one repository or one worktree
- Checking out branches or writing `git config` while other worktrees exist

## Removing a Worktree

Verify all three before `git worktree remove`, freshly, in this order:

1. **Clean, by fresh status codes.** Run a fresh `git -C <tree> status --porcelain` and read the STATUS CODES; never trust a prior report's dirty count. Counts cannot distinguish new files from removal-in-progress deletions; codes can. Every entry blocks the removal unless its exact path is positively identified as disposable: a removal-in-progress shows its own deletions as `D`, and a coordinator's keepalive marker (below) is a lone `??`. A `??`, `M`, or `D` entry not identified that way is real work.
2. **Landed, by content.** Confirm the branch's work is pushed or landed before deleting anything.
   - Check ancestry first, against a ref the fetch just wrote: `git fetch <remote> <mainline>` followed by `git merge-base --is-ancestor <branch> FETCH_HEAD`. Test `FETCH_HEAD`, not `<remote>/<mainline>`: whether the fetch updates the remote-tracking ref depends on the remote's configured fetch mapping, and a stale local ref proves nothing once the remote moved ahead.
   - A passing ancestry check clears the branch. A failing one proves nothing under squash or rebase merges, which rewrite the branch's shas (GitHub's rebase merge always does). Verify by CONTENT instead: subject match, patch diff, the files present at the remote tip.
3. **No live writer.** Check for processes whose cwd is inside the worktree (`lsof -a -p <pid> -d cwd`, or `lsof +D <tree>`). An actor absent from the running list is not itself writing, but processes it spawned (test chains, installs) can still be; kill them or wait them out first. And never remove a LOCKED tree (`git worktree list --porcelain` shows `locked` with its reason) or a tree another actor may be using without knowing whose it is and why.

After removing:

- **Remove with `git worktree remove`, never a bare `rm -rf`.** Manual deletion leaves the worktree's administrative entry in the shared git dir, so git keeps treating its branch as checked out (and blocks deleting it) until `git worktree prune`. After a deletion that already happened manually, prune explicitly.
- **Removal does not kill survivors.** A finished actor's wedged test chain can outlive its deleted directory for hours. Re-check and kill any process whose cwd names the deleted path.
- **Delete the branch too once it is no longer needed**, but verify the landing first (rule 2), never by what `git branch -d` says: `-d` only tests merge into the branch's configured upstream (or into HEAD when none is set), so it knows nothing about the landing workflow, and under squash and rebase merges it refuses after every successful landing. Treat a refusal as a prompt to verify by rule 2, never as a verdict in either direction; once verified, delete with `git branch -D`.

### Auto-removal can destroy a live workspace

Harnesses that auto-clean isolation worktrees remove them when their actor completes with a clean tree. An actor that stops "to wait" before anything is written, while others still work in its tree, leaves them working in a deleted directory.

- An actor coordinating others inside its own isolation worktree dirties the tree IMMEDIATELY on start; one untracked marker file at the worktree root is enough (e.g. `.orchestrator-keepalive`). The marker is never staged or committed; when later status reads judge "real work", a lone `??` for the marker is an artifact, not work. Delete it before the final signal or handoff.
- Before resuming any actor that stopped clean in an isolation worktree, verify the worktree still exists. Respawn fresh when it does not.

## Handing Over a Worktree

Ownership transfers explicitly, never by inference: at any moment exactly one actor owns a worktree, and a handover is a named event (a stop plus a grant), not a guess from silence.

- **Stop the predecessor first.** A message sent to a completed or idle agent RESUMES it. An acknowledgment or thank-you sent after a handover wakes the predecessor, which resumes writing into the worktree its successor now owns (a live-writer clobber). The order is always: stop the actor first (TaskStop in Claude Code); any farewell after that is unnecessary.
- **A successor proves there is no live writer** before editing: hash a hot file, wait, hash again (`shasum <file>; sleep 5; shasum <file>`), and edit only when the hashes match.
- **A removed tree's branch goes to whoever collects it.** Stopping an actor and removing its worktree transfers its branch to the collector, and only to the collector. Follow-up fixes on that branch go to a FRESH actor in a NEW worktree.
- **Never resurrect a released actor.** A message to a stopped actor resumes it into a directory that no longer exists. Once its worktree is removed, that actor is never messaged again.

## One Branch, One Worktree

Git refuses, by default, to check out a branch that is already checked out in ANY worktree ("already used by worktree"). So a branch is held by at most one tree, and the holder must release it before anyone else can take it:

```bash
git -C <holding-tree> checkout --detach   # or check out another branch there,
                                          # or remove the worktree (rules above)
git checkout <branch>                     # only now succeeds elsewhere
```

The refusal is a guard, not a lock: `git worktree add --force` and `git checkout --ignore-other-worktrees` override it. Never use them to take a branch a live tree holds; two checkouts of one branch means two writers of one ref.

Plan around the guard rather than fighting it: operations that need a branch checked out (rebase, merge, stack tooling) run only after the tree holding that branch is released or removed, never while its owner is live.

## Worktrees Share the Main Repository's .git

Every linked worktree keeps a small private git dir (HEAD, index, in-progress rebase or bisect state, `refs/worktree/*`) and shares everything else through the main repository's git dir (`$GIT_COMMON_DIR`): one config, one remote list, one hook set, one store for branches and tags. Consequences for concurrent actors:

- **`git config` writes are repository-wide.** An actor enabling `rerere`, setting `remote.pushDefault`, or rewriting `branch.<name>.*` sections changes behavior in every sibling worktree at once, mid-run. (Per-worktree config exists only when `extensions.worktreeConfig` is enabled and the write targets `config.worktree`; without that, every write is shared.)
- **Identity is shared.** A `user.email` or `user.name` write in one tree stamps every sibling's next commit. Set identity per command (`git -c user.email=...`) or in environment variables scoped to the actor, never in the shared config while others run.
- **Branches and tags are shared.** A fetch, a branch deletion, or a tag move performed in one tree is instantly visible in all (only HEAD and `refs/worktree/*` are per-tree); a sibling mid-rebase against a ref you delete fails in ways it cannot diagnose. Coordinate ref surgery, or schedule it when no sibling is live.
- **Hooks are shared by default.** Installing or editing a hook from one worktree changes what every sibling's next commit runs. (A per-worktree `core.hooksPath`, or a relative hooks path resolving per tree, is the exception; absent that, assume shared.)

## File Ownership Across Parallel Actors

When several actors write into ONE worktree, or several rounds of actors work the same file set:

- Every file has exactly one owner across ALL rounds; give each actor an explicit file whitelist.
- A later round's list is computed by SUBTRACTING everything any earlier round covered, by file list, not by "looks done".
- No round starts while a prior round's actor may still be writing.

Re-assigning files a prior round still owns produces racing-writer collisions and duplicated work even when exact-match edit semantics prevent outright corruption.
