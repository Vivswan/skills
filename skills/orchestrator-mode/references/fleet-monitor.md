# Fleet Monitor

One subagent whose only job is watching the rest of the fleet. It starts a periodic check (a cron or scheduled wakeup where the harness offers one, a sleep loop otherwise) and messages the lead when any agent stalls or dies. Sweep every 5-10 minutes; each sweep stays cheap (see Probe Cost below), so the bound is noise, not load. Reviewers sometimes idle without delivering: tell them explicitly to report back, and nudge if only an idle notification arrives.

Every rule below comes from a false conclusion caught in production. Do not simplify them away.

## Liveness Attribution

- **Attribute processes by CWD, never argv:** `lsof -a -p <pid> -d cwd`. Tools like `codex exec` run with the worktree as cwd but no path in argv, so a builder mid-review shows zero argv-matched processes and mimics the corpse signature exactly.
- **A bare `ps | grep -c` self-matches** through the monitor's own shell wrapper. Sanity-check every count probe against a token that cannot exist - and when a count EQUALS its impossible-token control, discard it as self-match noise rather than reading activity into it.
- **macOS has no `timeout`/`gtimeout`:** a probe wrapped in `timeout N ...` produces nothing and exits 0, indistinguishable from "none found". Cap probes with `perl -e 'alarm N; exec @ARGV' -- <cmd>`.
- **Rebase-refreshed mtimes mimic editing.** Rebasing onto a moved mainline checks out every file the new base's commits touched, so their mtimes go fresh with zero work done. Before attributing "actively editing" after a branch-tip rewrite, run `git -C <wt> status --porcelain`: a clean tree means no edits regardless of mtimes. (A monitor once reported a builder "actively editing" two files it never owned - they were the new base's.) The same trap at spawn: creating a worktree stamps EVERY checked-out file, so `find -newermt <spawn time>` cannot discriminate the agent writing from the checkout happening.
- **A sleeping shell counts as alive.** A worker sleep-polling (`lsof` cwd shows a zsh holding a `sleep`) is a discipline problem for the lead, never a corpse for the monitor.
- **Presence is not work.** A lone childless shell at ~0% CPU parked on the worktree cwd reads as "alive" under a presence test and silently voids idle counts that should keep running. A working agent shows a process TREE (bun/node/test-host children); instantaneous CPU may still read near zero on an I/O-bound test host, so judge by children and state, not by a single CPU sample.

## Activity Fingerprinting

Every naive churn probe fails toward a FALSE STALL - each of these made a busy worker look idle in production:

- The porcelain dirty-hash fingerprints only the path-and-status set; it freezes the moment a worker stops adding files and just keeps editing the same ones.
- `git diff --shortstat` measures unstaged changes only; it blanks when a worker stages everything (the commit-imminent signature reads as idle).
- `git diff HEAD` misses untracked files entirely - a builder once had 616 untracked lines of real work while reading as static.
- The git index never moves on working-tree writes (only on add/commit/status-refresh), so index mtime can sit frozen at spawn time while a worker writes hundreds of lines. Measured gap in production: 12.5 minutes.

The standing vocabulary that replaces them: for "did anything happen" use the NEWEST MTIME among dirty and untracked files PLUS the HEAD SHA (a clean amend or rebase moves HEAD with no dirty files and an unchanged commits-ahead count), never the index; for "is anything happening now" use children and CPU per Liveness Attribution; and require two observations of BOTH before any flag.

Two more measurement rules: (1) size a track base-to-HEAD (its branch-point commit to its HEAD), never `diff origin/main..HEAD` - for a behind track the latter also reverses every sibling landing in the gap (observed seven-fold deletion inflation); reserve origin/main comparisons for ahead/behind counts. (2) A sweep is not atomic: the mainline can move between two commands of one sweep, making ahead/behind counts disagree within a single pass - when readings contradict, re-fetch and re-read rather than trusting the earlier number.

- Scan the whole worktree for activity, not just `src/`; an infra builder's work lives elsewhere.
- The absence of a test runner's scratch directories does not mean no test is running.
- **Evidence is bound to a SHA.** Every amend or rebase expires every prior content claim about the commit; re-verify on the new SHA rather than carrying counts forward. A track can cross four SHAs between first commit and landing.

## Standing States

Keep a per-worker standing state in the running snapshot - `active`, `dormant-by-design` (committed, parked pending another landing), `landing-gate`, `landed-swept` - and check every would-be flag against it before reporting. Without this, a lead's "do not flag X, it is parked on purpose" instruction evaporates two rounds later and the same false suspicion re-fires each sweep. A dormant worker's only reportable events are its worktree vanishing, its HEAD moving (new commits appearing OR an amend/rebase - the commits-ahead count may not change), or new dirty or untracked files appearing while parked; a landing-gate worker's branch may legitimately gain a fix commit or disappear entirely (verified landing).

## Priors at the Quiet Seams

- **The signal seam:** a committed-clean-quiescent worker is MORE OFTEN mid-review or composing its signal than stranded - measured six out of six across one 40-sweep shift. Raise the flag anyway (the one real strand is the one that matters), but frame it as an observation, never an assertion: "no tree activity since X; you will know whether its signal arrived". The lead holds the half the monitor cannot see (whether the agent's turn is open, whether a message landed); that framing is what keeps a correct-on-evidence flag from interrupting a working builder.
- **The read-first prior:** a builder whose brief says read-the-landed-code-first is silent with nothing written for its first one or two sweeps, then produces substantial output in one go. Reading leaves no trace in trees or processes - its silence is not evidence of anything, the same blind spot as composing a message.
- **The meta-lesson:** a known-bad probe can re-enter through someone else's wording of a flag condition. The defence is not memory, it is measuring again immediately before firing - a near-miss stays a near-miss only because the monitor re-checked instead of trusting its own earlier authorization.

## Probe Cost

Routine sweeps must be O(cheap): status hash, newest-dirty mtime, HEAD SHA, a marker file, commits-ahead. Whole-tree filesystem walks collapse under wave-start I/O (parallel installs can kill consecutive sweeps at the command cap). A dead sweep is an instrument failure, never a quiet fleet. Expensive walks belong at flag-time, against one worktree only.

## Verifying a Landing

- Verify by ancestry on the mainline's remote ref (e.g. `origin/main`), never by inferring from a worktree's disappearance.
- In a cherry-pick, rebase, or squash-merge landing workflow, verify by PATCH CONTENT (subject match + patch diff + files exist at the mainline's remote tip), never by sha: the worktree's sha is never the landed sha, so a sha-identity rule reports every successful landing as lost work.
- **The rebase is the risk, not the intent.** "Did this track touch the file" and "did this track's rebase preserve the file" are different questions: a clean replay can drop another landing's lines with no conflict marker, and the silent no-op is the failure that hides. For shared files that multiple landings edit (especially ones where the same sentence is duplicated across many entries, so a partial revert still parses and lints), maintain an executable baseline - exact tokens with EXPECTED COUNTS, positive-controlled - and run it on every post-rebase tree and again on the mainline after each landing, regardless of what the track meant to touch. Check the number, never mere presence.
