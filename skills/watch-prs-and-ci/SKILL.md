---
name: watch-prs-and-ci
description: Use when a push went up or a PR opened, or when waiting on a PR's reviews, merge, or CI, so a daemon the session owns delivers the events as messages instead of polls.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Watch PRs and CI

One daemon per Claude Code session, started by the session as a background task, polls GitHub for the PRs and commits that session watches. The session subscribes once and keeps working. Comments, reviews, CI verdicts, head moves, merges, and closes arrive as messages in the session, one message per poll, and as lines in a log any other agent can read.

## The Specimen

A push went up and its PR is open. Once per session the daemon is started as a background task, then one line subscribes the PR:

```bash
bun "<skill-dir>/scripts/pr-events.mts" daemon     # once per session, as a BACKGROUND task
bun "<skill-dir>/scripts/pr-events.mts" watch octocat/repo#12 --head "$(git rev-parse HEAD)" --expect-workflow checks
```

The session goes back to work. Two polls later a review lands, and this arrives in the conversation unasked:

```text
PR octocat/repo#12: new review by copilot-pull-request-reviewer[bot] (COMMENTED), 2 review comments
  src/server.ts:241  The timeout handle is never cleared on the error path ...
  docs/setup.md:53   The example port differs from the default two lines below ...
https://github.com/octocat/repo/pull/12
automated notice from pr-events; no reply needed
```

No turn was spent on "nothing changed yet". The daemon is the session's own child: its messages render as plain text, and it exits on its own when the session does.

## When to Apply

- A `git push` just ran on a branch with CI, or a PR was just opened
- Waiting on a PR: a review, a reply, a merge, or "did CI pass?"
- A PR just merged, sent here by the `/pr-landing-discipline` skill, which owns the merge moment. A watched PR's merge event already carries the merge commit (After a Merge below).
- A direct push to the mainline with no PR: `watch-commit` (After a Merge below)

## Workflow

### 1. Start the daemon, once per session

```bash
bun "<skill-dir>/scripts/pr-events.mts" daemon
```

Run it as a **background task of this session**: the Bash tool's background mode. A background task stays in the session's process tree, which is what makes its messages render as plain text instead of being held for approval, and what lets it exit when the session ends.

Never start it with `nohup`, `setsid`, `disown`, or from a shell that exits: a detached daemon is a cross-session sender, and every message it sends is held (Gotchas below).

- The daemon reads its session from `CLAUDE_CODE_MESSAGING_SOCKET`. A second start in the same session exits 0 saying the first is up.
- It prints one line naming its socket and log, then polls once a minute until the session is gone, `stop` is called, or a signal arrives.

### 2. Subscribe

```bash
bun "<skill-dir>/scripts/pr-events.mts" watch <owner/repo>#<n> --head "$(git rev-parse HEAD)" --expect-workflow <gate workflow name>
```

- **`--head <sha>`** records the head you pushed, so that head is never reported as a head move. Pass the full 40-character SHA, and run `watch --head` again after each push.
- **`--expect-workflow <name>`** names a gate workflow: the `name:` of a workflow file under `.github/workflows/` that gates the PR. Repeat the flag per gate. The flags of one call are the complete gate set: a repeated `watch` replaces the set and restarts a pending judgment, so a mistyped name is corrected by calling again.
- With every gate present and passed, a green is terminal at once. Without a gate, every workflow that registered a run on the head is judged, and a green is confirmed by the next poll seeing the same workflows, so a workflow still registering gets its say.

`watch` returns once its poll has finished, a few seconds, so a `ci` event for an already-green head can arrive before the call returns. A PR's first sighting reads what is already on it and reports none of it; only what lands afterwards is an event. Without a daemon, `watch` exits 3 and prints the exact start command.

### 3. Keep working, never poll

Nothing to run, sleep on, or check. A message arrives when something changed. Never read the PR by hand between messages, never spawn a watcher subagent, and never run `gh run watch`: the daemon is the one poller for this session.

### 4. Act per event

Each message holds one poll's events, each with the PR's URL, and the closing line `automated notice from pr-events; no reply needed`. Never reply to it. Several events in one poll arrive separated by a blank line, and messages are at least a second apart.

| Kind | The line says | What to do |
| --- | --- | --- |
| `comment` | `PR octocat/repo#12: 1 new comment by octocat`, then one indented line per comment: the author, or `path:line` for a review-thread comment, then the body | triage it as a review round: reply, fix, or resolve |
| `review` | `PR octocat/repo#12: new review by octocat (CHANGES_REQUESTED), 2 review comments`, then the review body and each of its comments with `path:line` (The Specimen above) | the same, per the `/pr-landing-discipline` skill |
| `ci` | `PR octocat/repo#12: CI green on 1a2b3c4d5e6f: checks, lint`, or `CI red on 1a2b3c4d5e6f` with one line per run and the failed-step log tail of each failed run | green: carry on; red: fix from the excerpt, push, and the next verdict arrives on its own |
| `head` | `PR octocat/repo#12: head moved to 1a2b3c4d5e6f by octocat` | a head you did not record with `--head`: someone else pushed, or your own push without a fresh `watch --head`; pull before touching the branch |
| `merged` | `PR octocat/repo#12: merged at 2026-10-12T14:03:20Z; mainline commit 9f8e7d6c5b4a is now watched for CI`; the log line's `sha` is the whole merge commit | stop babysitting; the `ci` event for the merge commit follows |
| `closed` | `PR octocat/repo#12: closed without merging` | stop babysitting |
| `trouble` | `polling failed 3 times in a row (...); not a verdict`, `CI run not registered on 1a2b3c4d5e6f after 2 polls; not a verdict` with `no run registered for checks` under it, `issue comments: more than 10 pages since the last one reported; the older ones are not reported; read the PR`, or `merged at ...; no merge commit reported after 5 polls, so its mainline CI is not watched` | tooling trouble, never a red or green pipeline; Gotchas below |

The texts above are the shape, and the specimen is the exact text. The shipped script and this page are kept in sync upstream, and where they disagree, trust the script and report the drift.

## After a Merge

A watched PR needs nothing more. The `merged` event names the merge commit, and the daemon judges that commit's CI with the PR's gates, so the mainline verdict arrives as a later `ci` message.

The judged SHA is the PR's merge commit on the mainline, never the topic branch's HEAD: after `gh pr merge`, `git rev-parse HEAD` still names the topic tip, and the squash or merge commit exists only on the mainline. With a merge queue, `gh pr merge` can return on enqueue; the event waits for `mergedAt`.

GitHub can report the merge commit a poll or two after the merge. The PR stays watched until it does, for up to 5 polls, then a `trouble` event says so.

A direct push to the mainline has no PR to watch. Watch the pushed commit once:

```bash
git fetch <base-remote> <mainline>    # origin in a plain clone; in a fork checkout, the remote the push went to
bun "<skill-dir>/scripts/pr-events.mts" watch-commit <owner/repo> "$(git rev-parse FETCH_HEAD)" --expect-workflow <gate workflow name>
```

The commit is dropped once its CI settles; the `ci` event is written to the log and delivered. A `watch-commit` on a PR's merge commit before the merge keeps its own gate set over the PR's.

## Daemon

The lifecycle, in full:

```text
start     the session runs `daemon` as a background task; the owner is the session whose inbox
          CLAUDE_CODE_MESSAGING_SOCKET names, and every file the daemon owns is named by that session's pid
one only  binding `<runtime-dir>/<session-pid>.sock` is the rule: a second daemon of the session finds it
          answering and exits 0; a socket file nobody answers on was left by a crash and is replaced
poll      once a minute, and at once on `watch`; a restart with saved targets polls at once
stop      the session's pid gone (checked every second, and before every gh read) -> finish the poll
          in flight, save, unlink the socket, exit; `stop`, SIGTERM, SIGINT -> the same at once
agents    `status` prints the targets with their gates, the last delivery and how it went, and the last event
```

```bash
bun "<skill-dir>/scripts/pr-events.mts" status
bun "<skill-dir>/scripts/pr-events.mts" stop
```

The runtime directory, tried in this order. Each must be creatable as a private directory (mode 0700, owned by the user) or the next is tried; none at all exits 2 asking for `PR_EVENTS_DIR`.

| Tried | When |
| --- | --- |
| `$PR_EVENTS_DIR` | set |
| `$XDG_RUNTIME_DIR/pr-events` | `XDG_RUNTIME_DIR` set |
| `$CLAUDE_CODE_TMPDIR/pr-events-<uid>` | `CLAUDE_CODE_TMPDIR` set |
| `<os tmpdir>/pr-events-<uid>` | the OS temp dir, honouring `TMPDIR` |
| `/tmp/pr-events-<uid>` | the last resort |

| File | Holds |
| --- | --- |
| `<session-pid>.sock` | the control socket, also the daemon's `from` address, where the session reports a held or refused delivery |
| `<session-pid>.events.jsonl` | the write-ahead log, one line per event, appended before any delivery |
| `<session-pid>.state.json` | the targets, last-seen rows with the activity ids already seen, and the last delivery, written tmp-then-rename after every poll |
| `<session-pid>.log` | the daemon's log; the first place to read when something is off |

A file-sink daemon (below) names its files `<id>.` instead. A `gh` call is a fresh process each time, so tokens refresh under gh's control, and the daemon never exits on gh trouble: three consecutive failed polls raise one `trouble` event, and a recovery event follows.

## Commands

```text
pr-events.mts daemon [--interval <s>] [--id <name>] [--pid <pid>]
pr-events.mts watch <owner/repo>#<n> [--head <sha>] [--expect-workflow <name>]... [--id <name>]
pr-events.mts watch-commit <owner/repo> <sha> [--expect-workflow <name>]... [--id <name>]
pr-events.mts unwatch <owner/repo>#<n> | --all [--id <name>]
pr-events.mts wait [--since <id>] [--timeout <s>] [--id <name>]
pr-events.mts poll | status | stop [--id <name>]
```

| Exit | Meaning |
| --- | --- |
| 0 | ok; `stop` with no daemon running is ok too |
| 2 | usage (`CLAUDE_CODE_MESSAGING_SOCKET` unset and no `--id`, a bad `--id`, `--pid` without `--id`), gh missing at `daemon`, or no runtime directory |
| 3 | no daemon answers for this session: stderr names the socket and the exact background command that starts one |
| 4 | `wait` only: the timeout passed with no newer line |

`poll` runs one poll now, for tests and debugging. `--interval` has a floor of 60 s.

## Without a Claude Code Inbox

Codex, the Copilot CLI, a shell, or a Claude Code session with no `CLAUDE_CODE_MESSAGING_SOCKET` names a file-sink daemon with `--id` and reads the log instead of receiving messages. Start the daemon as that agent's own background job, then block on `wait`:

```bash
bun "<skill-dir>/scripts/pr-events.mts" daemon --id codex-12
bun "<skill-dir>/scripts/pr-events.mts" watch octocat/repo#12 --id codex-12
bun "<skill-dir>/scripts/pr-events.mts" wait --id codex-12 --since 0 --timeout 3600 > /tmp/pr-events-wait.out 2>&1
```

A file-sink daemon runs until `stop`. `--pid <pid>` ends it with that process instead: pass the agent's own pid, never `$$` from a one-shot shell, which becomes the daemon's own pid when the shell execs it (the daemon refuses its own pid).

Run `wait` as a background command and read the file when it exits. Exit 0 printed the new lines and the new cursor; pass that cursor as the next `--since`. Exit 4 is the timeout with nothing new: re-arm, or escalate to the user.

Every event line has the same shape, whichever sink reads it:

```json
{"id":17,"at":"2026-10-12T14:03:20Z","repo":"octocat/repo","pr":12,"kind":"review","text":"...","url":"https://github.com/octocat/repo/pull/12"}
```

`kind` is one of `comment`, `review`, `ci`, `head`, `merged`, `closed`, `trouble`. Every line is addressed to the daemon's one owner, and `status` shows how the last delivery to a session went. A held or refused delivery leaves the line in the log, so nothing is lost.

## Polling Budget

GitHub throttles in separate buckets: the core REST bucket, a secondary bucket for the Actions REST endpoints (`gh run list`, `gh run watch`, `gh run view`) on top of it, and GraphQL's own.

Parallel pollers on one account exhaust the Actions bucket while the core bucket still reads full, and every REST-based CI verdict is blind until it refills. GraphQL keeps answering. That is why each session has one poller and it polls through GraphQL, once a minute.

Three rules follow, and the daemon embodies them:

- **One poller per session.** The session watches; it never polls, spawns a watcher, or runs `gh run watch`. A hand-rolled watcher beside the daemon is a second poller on the same account.
- **The sustained interval is at least 60 s.** That is the floor of the daemon's `--interval`.
- **GraphQL only, REST only for failed-run logs.** The one REST call is `gh run view <id> --log-failed`, once per failed run, at most 3 excerpts per verdict; it never changes a verdict.

The reads of one poll, in order:

1. one aliased batch read over every watched PR; GitHub prices a request by its node count, so a batch of PRs costs about what one does
2. one detail read per PR whose row moved, paged back only to the last activity already seen
3. check suites by commit, for each head or commit whose verdict is pending
4. the failed-run log excerpts, when a verdict is red

The nominal cost of a poll is `1 + (PRs whose row moved) + (heads and commits with CI pending)` GraphQL requests, plus one detail read at a PR's first sighting and one viewer lookup per daemon.

On top of that, the batch read is one request per 30 PRs, a backlog adds one page per 20 missed comments, and a head with more than 100 check suites is read again until two reads agree.

At steady state, nothing moving, that is the batch read alone, once a minute. A rate-limited GraphQL answer is tooling trouble, never a reason to fall back to REST.

When a workflow's runs share a `concurrency` group key, GitHub keeps at most one running plus one pending run per key. A newer push cancels the pending run, and the running one too where `cancel-in-progress` evaluates true, so the older head never gets a verdict. The daemon judges the current head: after a stacked push only the newest head gets a verdict, so wait for it before pushing again.

## Gotchas

| What you see | What it means | What to do |
| --- | --- | --- |
| held delivery notices in the session instead of the event text | the daemon runs detached (`nohup`, `setsid`, a shell that exited), so it is a cross-session sender | `stop`, then start it again as a background task of this session |
| `watch` exits 3 naming a socket and a command | no daemon for this session | run the printed command as a background task, then `watch` again |
| `watch` exits 2: `CLAUDE_CODE_MESSAGING_SOCKET` is unset | not a Claude Code session, or one without an inbox | a file-sink daemon with `--id`, and `wait` (above) |
| auth errors in the daemon's log after a `gh auth` change | the session that started the daemon handed it a `GH_TOKEN` that has gone stale | `stop`, then start the daemon again |
| a `trouble` event: the gate workflow never registered | the named `--expect-workflow` has no run on the head two polls after its CI went pending (a head move or a rollup change); bystanders may be green or still running | check the name against `.github/workflows/*.yml`, then `watch` again with the right set, or dispatch it by hand with `gh workflow run <gate workflow file> --ref <branch>`; never read the rollup as green |
| a `trouble` event: polling failed, not a verdict | three consecutive polls failed (gh, network, or GitHub); the daemon keeps polling | wait for the recovery event; read the log if it does not come |
| a `trouble` event: no merge commit reported | GitHub reported no merge commit for the merged PR within 5 polls | read the merge commit from the PR page and `watch-commit` it |

## Fallback Without gh

- `gh` missing: `daemon` exits 2. Report the push and give the commit's checks URL, `https://github.com/<owner>/<repo>/commit/<sha>/checks`, and the PR URL. Never silently skip the watch.
- `gh` unauthenticated or its token stale: the daemon keeps polling and raises a `trouble` event after three failed polls, with the auth errors in its log. Fix the auth, then `stop` and start the daemon again.
- Non-GitHub CI: use that system's own notification or watch command. The rule is the same: one poller, events delivered, never an inline wait.
