# Fleet Monitor

One subagent whose only job is watching the rest of the fleet. It starts a periodic check (a cron or scheduled wakeup where the harness offers one, a sleep loop otherwise) and messages the lead when any agent stalls or dies. Sweep every 5-10 minutes; each sweep stays cheap (see Probe Cost below), so the bound is noise, not load. Reviewers sometimes idle without delivering: tell them explicitly to report back, and nudge if only an idle notification arrives.

Every rule below comes from a false conclusion caught in production. Do not simplify them away.

## Liveness Attribution

- **Attribute processes by CWD, never argv:** `lsof -a -p <pid> -d cwd`. Tools like `codex exec` run with the worktree as cwd but no path in argv, so a builder mid-review shows zero argv-matched processes and mimics the corpse signature exactly.
- **A bare `ps | grep -c` self-matches** through the monitor's own shell wrapper. Sanity-check every count probe against a token that cannot exist.
- **macOS has no `timeout`/`gtimeout`:** a probe wrapped in `timeout N ...` produces nothing and exits 0, indistinguishable from "none found". Cap probes with `perl -e 'alarm N; exec @ARGV' -- <cmd>`.

## Activity Fingerprinting

- A status-output hash alone misses rebases and live editing. Fingerprint = any of: status hash, index mtime, newest-file mtime, HEAD sha.
- Scan the whole worktree for activity, not just `src/`; an infra builder's work lives elsewhere.
- The absence of a test runner's scratch directories does not mean no test is running.

## Probe Cost

Routine sweeps must be O(cheap): status hash, index mtime, a marker file, commits-ahead. Whole-tree filesystem walks collapse under wave-start I/O (parallel installs can kill consecutive sweeps at the command cap). A dead sweep is an instrument failure, never a quiet fleet. Expensive walks belong at flag-time, against one worktree only.

## Verifying a Landing

- Verify by ancestry on the mainline's remote ref (e.g. `origin/main`), never by inferring from a worktree's disappearance.
- In a cherry-pick, rebase, or squash-merge landing workflow, verify by PATCH CONTENT (subject match + patch diff + files exist at the mainline's remote tip), never by sha: the worktree's sha is never the landed sha, so a sha-identity rule reports every successful landing as lost work.
