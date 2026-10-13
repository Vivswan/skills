# Retire Branch: why each gate exists

Companion to `scripts/retire-branch.mts`: the incidents behind its gates, one entry each, so a change to the script can be judged against what the gate was for.

- **One program, four exit codes.** `verify && delete` degrades to `verify; delete` the moment anything joins it with `;`, `|| true`, or a pipeline whose status comes from the wrong end. Three landings in one session destroyed state their own check had refused.

  Exit 3 (broken measurement) is kept apart from exit 1 (refused). A refusal for the wrong reason is an unanswered question, and an unanswered question must never sit one `|| true` away from a deletion.
- **Fetch into a ref the run owns.** A remote-tracking ref is a cache. After a non-fast-forward rewrite, `origin/main` can still contain the branch, and ancestry says "contained" about a history the mainline no longer holds. Whether a fetch updates it at all depends on the remote's refspec. `FETCH_HEAD` is one slot every fetch in a shared worktree rewrites.

  The script fetches into `refs/retire-branch/<pid>/mainline` and drops it on every exit path. It clears that name with `--no-deref` first: a fetch force-updating a symbolic ref writes its target (verified, main lost a commit).
- **Ancestry: the argument order is the whole gate.** `git merge-base --is-ancestor <branch> <reference>` asks the right question. The swap exits 0 on exactly the unlanded work the gate protects, and both orders agree after a fast-forward merge, so the tests force an UNMERGED branch. One call site, named parameters. The UNMERGED scenario with its swapped-argument mutation is the proof.
- **A three-way merge settles squash and rebase merges.** The branch's shas never reach the mainline, so ancestry refuses every landed branch there. `git merge-tree --write-tree <mainline-tip> <branch>` merges the branch into the tip without touching a worktree, and the tree it prints is the verdict:

  ```text
  the tip's own tree, exit 0 -> landed: the branch carries nothing the mainline lacks
  another tree, exit 0       -> refused, naming the paths (git diff --name-only between the two trees)
  a tree, exit 1             -> refused: a conflict, naming the conflicted paths (a directory rename split names none)
  no tree, or exit >= 2      -> exit 3 (merge-tree's "not something we can merge" is also a 1; --write-tree needs git 2.38)
  ```

  The per-path diff it replaced compared each path the branch changed against the mainline tip, so a later mainline commit to one of those files refused a landed branch (one sentence another PR changed in a file this one had edited). The merge asks the right question: does the mainline already hold everything the branch adds?

  `--no-renames --no-relative --ignore-submodules=none` on the listing keep a rename, `diff.relative`, or `diff.ignoreSubmodules` from hiding a path the refusal should name, and raw bytes keep a non-UTF-8 filename in it. merge-tree runs from the toplevel, since it prints conflicted paths relative to the cwd.
- **A shallow clone can never refuse.** Git treats the grafted boundary as a root, so history it cannot see reads as "not contained" with a plain exit 1. That negative is exit 3, with `git fetch --unshallow` as the remedy.
- **Delete by explicit ref, pinned to the judged sha.** `git branch -D` deletes whatever the name points at now. `update-ref -d --no-deref <ref> <sha>` refuses a push that landed between the gate and the deletion.

  A symbolic branch ref is refused outright. `update-ref -d` dereferences by default, and deleting `refs/heads/topic -> refs/heads/main` deletes main while every gate passes (verified).

  A failed deletion is classified: ref moved is exit 1 (re-run), ref unchanged is exit 3 (the write failed, not the lease), ref unreadable is exit 3. A dangling symref left where the branch was makes `show-ref` answer like a missing ref, so the postcondition also asks `symbolic-ref` before believing an absence.
- **Every fallible gate runs before the removal.** The first capture happens, then a fetch. In that window the tree can switch branches, commit, acquire work or a stranger, and a refusal AFTER the removal would leave a run that ends in a refusal having destroyed something.

  So under `--execute` the order is fixed: fetch the mainline again and re-prove the landing, re-run the whole worktree judgement (branch tip read once more at its very end), remove the tree, scan the holders, delete the ref pinned to the judged sha. Nothing between the removal and the deletion touches the network. The only refusals possible there are the holder re-scan and the lease itself.

  The rules the capture enforces are the worktree removal rules in `SKILL.md`. A live-writer probe that cannot run (lsof missing, partial, or answering nothing) is exit 3, and `--no-writer-check` waives that one probe only.

  The run's own ancestors (the invoking shell) are exempt from that probe, on the assumption that a foreground invocation's parents are waiting on it. A run backgrounded from a shell that keeps working in the tree defeats the assumption, so invoke it in the foreground.
