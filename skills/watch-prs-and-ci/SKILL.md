---
name: watch-prs-and-ci
description: Use when a push went up or a PR opened, or when waiting on a PR's reviews, merge, or CI, so one daemon per user delivers the events as messages instead of polls.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Watch PRs and CI

One daemon per user per machine polls GitHub for every PR the sessions on that machine care about. A session subscribes once and keeps working. Comments, reviews, CI verdicts, head moves, merges, and closes arrive as messages in the session that subscribed, and as lines in a log any other agent can read.

## The Specimen

A push went up and its PR is open. One line subscribes the session:

```bash
bun "<skill-dir>/scripts/pr-events.mts" watch octocat/repo#12 --mode bypass --head "$(git rev-parse HEAD)" --expect-workflow checks
```

The session goes back to work. Two polls later a review lands, and this arrives in the conversation unasked:

```text
<cross-session-message from-name="pr-events" from-mode="bypass">
PR octocat/repo#12: new review by copilot-pull-request-reviewer[bot] (COMMENTED), 2 review comments
  src/server.ts:241  The timeout handle is never cleared on the error path ...
  docs/setup.md:53   The example port differs from the default two lines below ...
https://github.com/octocat/repo/pull/12
automated notice from pr-events; no reply needed
</cross-session-message>
```

No turn was spent on "nothing changed yet". No watcher process belonged to the session. The daemon found or started itself on the `watch` call, and it exits on its own once no subscriber is left.

## When to Apply

- A `git push` just ran on a branch with CI, or a PR was just opened
- Waiting on a PR: a review, a reply, a merge, or "did CI pass?"
- A PR just merged, sent here by the `/pr-landing-discipline` skill, which owns the merge moment. A subscribed PR's merge event already carries the merge commit (After a Merge below).
- A direct push to the mainline with no PR: `watch-commit` (After a Merge below)

## Workflow

### 1. Subscribe

```bash
bun "<skill-dir>/scripts/pr-events.mts" watch <owner/repo>#<n> --mode bypass --head "$(git rev-parse HEAD)" --expect-workflow <gate workflow name>
# --mode prompting instead when this session asks before tool calls (How an Agent Knows Its Mode, below)
```

- **`--mode` is required**: `bypass` or `prompting`, how this session takes permission prompts. Every message to this session is stamped with it.
- **`--head <sha>`** records the head you pushed, so that head is never reported as a head move. Pass the full 40-character SHA, and run `watch --head` again after each push.
- **`--expect-workflow <name>`** names a gate workflow: the `name:` of a workflow file under `.github/workflows/` that gates the PR. Repeat the flag per gate. Without it, every workflow that registered a run on the head is judged, and at least one must have.

`watch` returns once its baseline poll has finished, a few seconds, so a `ci` event for an already-green head can arrive before the call returns. The call is safe to repeat: a second `watch` for the same PR re-asserts the mode, records the head and gates it names, and never starts a second daemon.

### 2. Keep working, never poll

Nothing to run, sleep on, or check. A message arrives when something changed. Never read the PR by hand between messages, never spawn a watcher subagent, and never run `gh run watch`: the daemon is the one poller for this user.

### 3. Act per event

Each message is one event for one PR, with the PR's URL and the closing line `automated notice from pr-events; no reply needed`. Never reply to it.

| Kind | The line says | What to do |
| --- | --- | --- |
| `comment` | `PR octocat/repo#12: 1 new comment by octocat`, then the body, with `path:line` for a review-thread reply | triage it as a review round: reply, fix, or resolve |
| `review` | `PR octocat/repo#12: new review by octocat (CHANGES_REQUESTED), 2 review comments`, then each comment with its `path:line` | the same, per the `/pr-landing-discipline` skill |
| `ci` | `PR octocat/repo#12: CI green on 1a2b3c4 (checks, lint)`, or `CI red on 1a2b3c4` with the workflow, the job, and the failed-job log tail | green: carry on; red: fix from the excerpt, push, and the next verdict arrives on its own |
| `head` | `PR octocat/repo#12: head moved by octocat to 1a2b3c4; CI pending` | a head no subscriber recorded with `--head`: someone else pushed, or your own push without a fresh `watch --head`; pull before touching the branch |
| `merged` | `PR octocat/repo#12: merged as 9f8e7d6; watching its mainline CI` | stop babysitting; the `ci` event for the merge commit follows |
| `closed` | `PR octocat/repo#12: closed without merging` | stop babysitting |
| `trouble` | `polling failed, not a verdict` after three failed polls, or `gate workflow "checks" never registered on 1a2b3c4; not green` | tooling trouble, never a red or green pipeline; Gotchas below |

The texts above are the shape. The shipped script and this page are kept in sync upstream, and where they disagree, trust the script and report the drift.

## How an Agent Knows Its Mode

Claude Code accepts exactly two mode tokens on an incoming message, and a session that bypasses prompts holds a frame asserting the other mode or none. The assertion made at `watch` must therefore match the receiving session.

| You are | Assert |
| --- | --- |
| Claude Code running without permission prompts (bypass permissions, or a session started with permissions skipped) | `--mode bypass` |
| anything that stops to ask before a tool call, including a Claude Code session in its default mode | `--mode prompting` |

A held frame is visible: the session shows a held delivery notice instead of the event text, `status` shows the delivery as held, and the Gotchas row below names the remedy.

## After a Merge

A subscribed PR needs nothing more. The `merged` event names the merge commit, and the daemon judges that commit's CI for the same subscribers, so the mainline verdict arrives as a later `ci` message.

The judged SHA is the PR's merge commit on the mainline, never the topic branch's HEAD: after `gh pr merge`, `git rev-parse HEAD` still names the topic tip, and the squash or merge commit exists only on the mainline. With a merge queue, `gh pr merge` can return on enqueue; the event waits for `mergedAt`.

A direct push to the mainline has no PR to subscribe. Watch the pushed commit once:

```bash
git fetch <base-remote> <mainline>    # origin in a plain clone; in a fork checkout, the remote the push went to
bun "<skill-dir>/scripts/pr-events.mts" watch-commit <owner/repo> "$(git rev-parse FETCH_HEAD)" --mode bypass --expect-workflow <gate workflow name>
```

The commit is dropped once its CI settles; the `ci` event is written to the log and delivered.

## Daemon

Agents never discover the daemon. `watch` finds or starts it; the lifecycle, in full:

```text
start      the first `watch` from any session or agent connects to the control socket; nothing there ->
           spawn the daemon detached, retry the connect every 100 ms for up to 5 s -> still nothing: exit 2 naming the log
find       one fixed directory per user (the ladder below), so there is nothing to look up;
           the subscriber's inbox is never guessed: it is CLAUDE_CODE_MESSAGING_SOCKET as handed over at `watch`
one only   binding daemon.sock is the lock: in use -> connect to the winner; refused on an existing file -> unlink, bind again
stop       each poll prunes subscribers whose session is gone (socket sink) or whose lease lapsed (file sink);
           10 min with none -> save, unlink the socket, exit; `stop`, SIGTERM, SIGINT -> the same at once
users      everything is keyed by uid: each user has their own daemon, log, subscriptions, `gh` identity, and rate budget
agents     `status` prints the subscribers, PRs, last event, last delivery state per subscriber, and the log path
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
| `<os tmpdir>/pr-events-<uid>` | the OS temp dir, honouring `TMPDIR` and `CLAUDE_CODE_TMPDIR` |
| `/tmp/pr-events-<uid>` | the last resort |

| File | Holds |
| --- | --- |
| `daemon.sock` | the control socket, also the daemon's `from` address |
| `events.jsonl` | the write-ahead log, one line per event, appended before any delivery |
| `state.json` | subscriptions and last-seen rows, written tmp-then-rename after every poll |
| `daemon.log` | the daemon's stderr; the first place to read on exit 2 |

A `gh` call is a fresh process each time, so tokens refresh under gh's control, and the daemon never exits on gh trouble: three consecutive failed polls raise one `trouble` event per subscriber, and a recovery event follows.

## Commands

```text
pr-events.mts watch <owner/repo>#<n> --mode bypass|prompting [--head <sha>] [--expect-workflow <name>]... [--sink socket|file] [--id <name>] [--pid <pid>]
pr-events.mts watch-commit <owner/repo> <sha> --mode ... [--expect-workflow ...]
pr-events.mts unwatch <owner/repo>#<n> | --all
pr-events.mts wait [--id <name>] [--since <id>] [--timeout <s>]
pr-events.mts poll
pr-events.mts status
pr-events.mts stop
pr-events.mts daemon [--interval <s>] [--idle-seconds <s>]
```

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 2 | usage (no `--mode`, no inbox socket for the socket sink, no `--id` for the file sink), gh missing, or the daemon unreachable after a spawn, which names the log path on stderr |
| 3 | `wait` only: the timeout passed with no newer line |

`poll` runs one poll now, for tests and debugging. `daemon` is what `watch` spawns; `--interval` has a floor of 60 s, and `--idle-seconds` is the empty-subscriber exit delay.

## Without a Claude Code Inbox

Codex, the Copilot CLI, a shell, or a Claude Code session with no `CLAUDE_CODE_MESSAGING_SOCKET` reads the log instead of receiving messages. Subscribe with the file sink and a name, then block on `wait`:

```bash
bun "<skill-dir>/scripts/pr-events.mts" watch octocat/repo#12 --mode prompting --sink file --id codex-12
bun "<skill-dir>/scripts/pr-events.mts" wait --id codex-12 --since 0 --timeout 3600 > /tmp/pr-events-wait.out 2>&1
```

Run `wait` as a background command and read the file when it exits. Exit 0 printed the new lines and the new cursor; pass that cursor as the next `--since`. Exit 3 is the timeout with nothing new: re-arm, or escalate to the user.

`--id` names the file-sink subscription the reader holds, and each `wait` renews its 24 h lease; a file subscriber whose lease lapsed is pruned. `--pid <pid>` at `watch` time prunes on that process's death instead.

Every event line has the same shape, whichever sink delivers it:

```json
{"id":17,"at":"2026-10-12T14:03:20Z","repo":"octocat/repo","pr":12,"kind":"review","text":"...","url":"https://github.com/octocat/repo/pull/12"}
```

`kind` is one of `comment`, `review`, `ci`, `head`, `merged`, `closed`, `trouble`. A held or dropped socket delivery leaves the line in the log, so nothing is lost to a session that was away.

## Polling Budget

GitHub throttles in separate buckets. The core REST bucket is 5000 requests per hour per user, the Actions REST endpoints (`gh run list`, `gh run watch`, `gh run view`) are a secondary bucket on top, and GraphQL has its own.

Ten sessions on one account, each running its own watcher, locked the Actions bucket for over an hour with 403 "API rate limit exceeded" while core still read 5000/5000, and every REST-based CI verdict was blind. GraphQL kept answering throughout.

Three rules follow, and the daemon embodies them:

- **One poller per user per machine.** Sessions subscribe; they never poll, spawn a watcher, or run `gh run watch`. A hand-rolled watcher beside the daemon is the incident above.
- **The sustained interval is at least 60 s.** That is the floor of the daemon's `--interval`.
- **GraphQL only, REST only for failed-run logs.** One aliased batch read covers every subscribed PR per poll (about 3 nodes per PR, so 12 PRs cost 1 point), check suites by commit when a head's rollup moves, and `gh run view <id> --log-failed` once per failed run, at most 3 excerpts per verdict.

At 12 PRs and 3 pending commits the daemon makes about 4 calls a minute, 8 at worst, under 600 points an hour of 5000. A rate-limited GraphQL answer is tooling trouble, never a reason to fall back to REST.

When a workflow's runs share a `concurrency` group key, GitHub keeps at most one running plus one pending run per key. A newer push cancels the pending run, and the running one too where `cancel-in-progress` evaluates true, so the older head never gets a verdict. The daemon judges the current head: after a stacked push only the newest head gets a verdict, so wait for it before pushing again.

## Gotchas

| What you see | What it means | What to do |
| --- | --- | --- |
| a held delivery notice in the session instead of the event text | the `--mode` asserted at `watch` does not match how this session takes permission prompts | `watch` again with the other mode |
| `watch` exits 2: no inbox socket for the socket sink | `CLAUDE_CODE_MESSAGING_SOCKET` is unset: not a Claude Code session, or one without an inbox | `--sink file --id <name>` and `wait` (above) |
| auth errors in `daemon.log` after a `gh auth` change | the shell that spawned the daemon handed it a `GH_TOKEN` that has gone stale | `stop`, then `watch` again |
| a `trouble` event: the gate workflow never registered | the named `--expect-workflow` has no run on the head two polls after its CI went pending (a head move or a rollup change); bystanders may be green | dispatch it by hand, `gh workflow run <gate workflow file> --ref <branch>`; never read the rollup as green |
| `watch` exits 2 naming the log, with a `daemon.sock` file present | a refused connect to an existing file is a stale socket the next start unlinks; a repeat means the daemon itself failed to start | read `daemon.log`, then `watch` again |
| a `trouble` event: polling failed, not a verdict | three consecutive polls failed (gh, network, or GitHub); the daemon keeps polling | wait for the recovery event; read `daemon.log` if it does not come |

## Fallback Without gh

- `gh` missing: `watch` exits 2. Report the push and give the commit's checks URL, `https://github.com/<owner>/<repo>/commit/<sha>/checks`, and the PR URL. Never silently skip the watch.
- `gh` unauthenticated or its token stale: the daemon keeps polling and raises a `trouble` event after three failed polls, with the auth errors in `daemon.log`. Fix the auth, then `stop` and `watch` again.
- Non-GitHub CI: use that system's own notification or watch command. The rule is the same: one poller, events delivered, never an inline wait.
