---
name: watch-ci-after-push
description: Use when pushing commits to a remote with CI, merging a PR, or when asked whether a pipeline passed, so every push and merge gets a background watcher.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Watch CI After Push

Every push gets a **background watcher** that reports pass/fail with failing-job logs. Never fire-and-forget a push. Never watch CI inline: an inline watch blocks the session for minutes while a background watcher costs nothing.

## When to Apply

- A `git push` just ran (any branch with CI)
- A PR just merged (watch the mainline tip, not the topic HEAD; recipe below)
- "did CI pass?" / "watch the pipeline" / "check the build"

## Workflow

### 1. Find the runs the push triggered

- Poll until the runs appear: they can take a few seconds to register after the push.
- Always pass the **FULL 40-character SHA**: `gh run list --commit` silently returns an empty list for short SHAs.

```bash
sha="$(git rev-parse HEAD)"   # full SHA - short SHAs silently match nothing
for i in 1 2 3 4 5; do
  runs="$(gh run list --commit "$sha" --json databaseId,name,status,conclusion,url)"
  [ "$runs" != "[]" ] && break
  sleep 3
done
echo "$runs"
```

Still empty after ~15s? That usually means no workflow triggers on this ref. Say so and stop (include the repo's Actions URL).

### 2. Watch in the background

Preferred: spawn a **background subagent** with this brief, then keep working. Never sleep or poll waiting for it. Act on its report when the completion notification arrives:

```text
Watch the CI runs for commit <full-sha> on <repo>: run
"<skill-dir>/scripts/watch-ci.sh <full-sha>" from the repo root and
report its full output. Exit 0: all green (skipped runs count as
pass). Say so in one line. Exit 1: some workflow's latest run ended
with any non-success, non-skipped conclusion (e.g.
failure/cancelled/timed_out). Include the FAIL lines and the log
excerpts. Exit 2: discovery or gh itself failed, or the expected
workflow (default: the one named "CI") never registered a run on
the SHA. Report that as tooling trouble, NEVER as a red pipeline.
Report even on success; never go silent. You watch and report ONLY:
never fix, commit, or push from this role.
```

Fallback without subagents: run the bundled `scripts/watch-ci.sh` as a background shell command. It does discovery, watching, and the failure report in one command. The path is relative to the installed skill folder, not the repo under review. Redirect its output to a file, and read that file when it exits:

```bash
bash "<skill-dir>/scripts/watch-ci.sh" "$(git rev-parse HEAD)" > /tmp/ci-watch.out 2>&1
# exit 0: latest run per workflow green (older re-triggered runs are reported
# as superseded, not judged); 1: some latest run ended with a non-success,
# non-skipped conclusion (log excerpts in the file); 2: no runs registered or
# gh failed, or the expected workflow never registered a run
```

The script refuses a vacuous green: the expected workflow (by default the one named `CI`) must be among the discovered runs, or it exits 2 naming what it did find. A repo whose gate workflow has a different name passes `--expect-workflow <name>` (repeatable or comma-separated) before the SHA; names match exactly and case-sensitively, so a comma or newline can never be part of an expected name. When the push event dropped the run, dispatch the missing workflow by hand, e.g. `gh workflow run ci.yml --ref <branch>`. Transient gh or network errors mid-watch are retried (3 attempts with a short backoff) before the script concludes anything; only a persistent failure exits 2.

The exit codes are ranked, not independent: a red run (exit 1) outranks a missing expected workflow, which outranks a gh error (both exit 2). A missing gate workflow plus a red bystander therefore exits 1, with the missing-workflow message still printed; clear the red run, then watch again for the gate.

In this skill's home repository, a drift test (`tests/doc-drift.test.ts`) pins these citations (the invocation shape, the exit semantics, the expected-workflow gate, the superseded/FAIL/skip lines) to `scripts/watch-ci.sh`. A rename on either side fails CI until doc and script move together.

### 3. Report

- All green: one line ("CI passed: <workflow names>").
- Any failure: the failing workflow and job names, the log excerpt that shows the actual error, and the run URL. Excerpt, not the full log.

## Polling Budget

GitHub's core REST bucket is 5000 authenticated requests per hour per user, shared by every REST call the session makes (`gh run list`, `watch`, and `view` included). Production: parallel watchers plus `gh run watch` at its 3 s default refresh exhausted it, and every CI verdict was blind for 45 minutes. Two rules follow:

- **One CI poller per session at a time.** Queue the next push behind the running watcher, or, when the branch's runs share a `concurrency` group key, watch only the newest mainline tip: an older tip's watcher can end with no verdict to report (the group behavior is spelled out below).
- **The sustained watch interval is at least 60 s.** The bundled script passes `--interval 60` to every `gh run watch`; a hand-rolled watcher does the same (`gh run watch <id> --interval 60`), never gh's default. The script's two bounded bursts are not what this rule is about and stay as they are: registration polling (up to five `gh run list` calls 3 s apart, until the runs appear) and the transient-failure retries (up to three attempts 2 s apart) each spend a handful of requests once; the minutes-long watch is where the budget goes.

Stacked pushes also lose verdicts on GitHub's side. When a workflow's runs share a `concurrency` group key (commonly the workflow plus the branch), GitHub keeps at most one running plus one pending run per key: a newer push cancels the pending run (and the running one too where `cancel-in-progress` evaluates true), so that SHA never gets a verdict, which the script reports as `FAIL(cancelled)` on a latest run. Two landings in one session needed reruns for exactly this; wait for the running watcher's verdict before pushing again.

## After a Merge

A merge is a push to the mainline by other hands, and nothing above covers it by accident: after `gh pr merge`, `git rev-parse HEAD` in the checkout still names the TOPIC branch's tip, while the squash or merge commit is a new SHA that exists only on the mainline. A watcher started on the topic tip proves nothing about the merged pipeline. With a merge queue, `gh pr merge` can return success on ENQUEUE, before the commits reach the mainline; wait until the PR is actually merged (`mergedAt` set) before fetching, or the fetch grabs the pre-merge tip. Then resolve the mainline tip and run the same workflow (discovery, background watch, report) on that SHA:

```bash
git fetch <base-remote> <mainline>    # origin in a plain clone; in a fork checkout, the
#                                       canonical remote the PR merged into, never the fork
sha="$(git rev-parse FETCH_HEAD)"     # the merged mainline tip, not the topic HEAD
```

## Sleeping on PR Activity

Waiting for a review, a reply, or a merge after the push? Never poll the PR from the session: every poll spends tokens on "nothing changed yet". Run the bundled waiter as a background shell command (same pattern as the CI watcher above) and act when it exits:

```bash
bun "<skill-dir>/scripts/wait-for-pr-event.mts" <pr-number> --repo <owner/name> > /tmp/pr-wait.out 2>&1
```

- `--until` picks the watched events from `comment,review,checks,merge` (default: `comment,review`).
- `--interval` sets seconds between polls (default 60, minimum 60: the Polling Budget floor above), but a failed poll retries after 2 seconds instead of waiting the full interval; `--timeout` sets seconds before giving up (default 1800).
- The waiter reads a complete baseline first (comment, thread-reply, and review-thread counts via GraphQL `isResolved`, the latest review, per-check conclusions, merged state) and exits 2 instead of waiting when that read fails.
- At the deadline it makes one final bounded read, so the closing snapshot is current and a delta landing in the last window still exits 0.

| Exit | Meaning |
| --- | --- |
| 0 | a watched event happened; the output names it (`new review by <login>`, `unresolved threads 0 -> 2`, `check <name> -> failure`, merged) |
| 1 | the PR merged or closed while that outcome was not watched; the wait's job ended - on a merge, watch the mainline tip per "After a Merge" above |
| 2 | usage or tooling error (bad args, gh missing or failing); it never retries forever |
| 3 | timeout with no watched change; the baseline and final snapshots are in the output |

Worked example, babysitting a PR between review rounds:

```bash
bun "<skill-dir>/scripts/wait-for-pr-event.mts" 123 --until comment,review --timeout 3600 > /tmp/pr-123-wait.out 2>&1
# read /tmp/pr-123-wait.out when it exits:
#   exit 0 -> handle the named event (reply, fix, push, re-request review)
#   exit 1 -> the PR merged or closed; stop babysitting (a merge still gets the "After a Merge" watch above)
#   exit 3 -> no activity this hour; re-arm the waiter or escalate to the user
```

The drift test also pins this waiter's invocation, its `--until` set, and all four exit codes to `scripts/wait-for-pr-event.mts`.

## Fallback Without gh

- `gh` unavailable or unauthenticated: report the push and give the commit's checks URL (`https://github.com/<owner>/<repo>/commit/<sha>/checks`). Do not silently skip the watch.
- Non-GitHub CI: use that system's equivalent watch command. The rule is the same: background watcher, report pass/fail with failing logs.
