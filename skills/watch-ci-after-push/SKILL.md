---
name: watch-ci-after-push
description: Use when pushing commits to a remote with CI, or when asked whether a pipeline passed, so every push gets a background watcher.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Watch CI After Push

Every push gets a **background watcher** that reports pass/fail with failing-job logs. Never fire-and-forget a push. Never watch CI inline: an inline watch blocks the session for minutes while a background watcher costs nothing.

## When to Apply

- A `git push` just ran (any branch with CI)
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
excerpts. Exit 2: discovery or gh itself failed. Report that as
tooling trouble, NEVER as a red pipeline. Report even on success;
never go silent. You watch and report ONLY: never fix, commit, or
push from this role.
```

Fallback without subagents: run the bundled `scripts/watch-ci.sh` as a background shell command. It does discovery, watching, and the failure report in one command. The path is relative to the installed skill folder, not the repo under review. Redirect its output to a file, and read that file when it exits:

```bash
bash "<skill-dir>/scripts/watch-ci.sh" "$(git rev-parse HEAD)" > /tmp/ci-watch.out 2>&1
# exit 0: latest run per workflow green (older re-triggered runs are reported
# as superseded, not judged); 1: some latest run ended with a non-success,
# non-skipped conclusion (log excerpts in the file); 2: no runs registered or
# gh failed
```

In this skill's home repository, a drift test (`tests/doc-drift.test.ts`) pins these citations - the invocation shape, the exit semantics, the superseded/FAIL/skip lines - to `scripts/watch-ci.sh`: a rename on either side fails CI until doc and script move together.

### 3. Report

- All green: one line ("CI passed: <workflow names>").
- Any failure: the failing workflow and job names, the log excerpt that shows the actual error, and the run URL. Excerpt, not the full log.

## Fallback Without gh

- `gh` unavailable or unauthenticated: report the push and give the commit's checks URL (`https://github.com/<owner>/<repo>/commit/<sha>/checks`). Do not silently skip the watch.
- Non-GitHub CI: use that system's equivalent watch command. The rule is the same: background watcher, report pass/fail with failing logs.
