---
name: watch-github
description: Use when a push went up or a PR opened, or when waiting on a PR's reviews, merge, or CI, or on a branch tip's CI, so a daemon the session owns delivers the events as messages instead of polls.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Watch GitHub

One daemon per Claude Code session, started by the session as a background task, polls GitHub for the pull requests and branch tips that session watches. The session subscribes once and keeps working. Comments, reviews, CI verdicts, head moves, merges, and closes arrive as messages in the session, one message per poll, and as lines in a log any other agent can read.

The daemon is the `/session-events` skill's, installed beside this one; this skill is its GitHub source. That page owns the envelope, the runtime directory and files, the file sink, and the two-hour cap. This page owns what is polled and what the events say.

Operating envelope: one Claude Code session, one user, the daemon started once by that session, GitHub reachable through an authenticated `gh`.

## The Specimen

A push went up and its PR is open. Once per session the daemon is started as a background task, then one line subscribes the PR with its gate workflow:

```bash
bun "<skill-dir>/scripts/github-events.mts" daemon     # once per session, as a BACKGROUND task
bun "<skill-dir>/scripts/github-events.mts" watch owner/repo#12 --expect-workflow checks
```

The session goes back to work. Minutes later the gate finishes, and this arrives in the conversation unasked:

```text
<cross-session-message from="uds:/run/user/1000/session-events/4242.github-events.sock" from-name="github-events">
PR owner/repo#12: CI green on 1a2b3c4d5e6f: 3 workflows
https://github.com/owner/repo/pull/12/checks
automated notice from github-events; no reply needed
</cross-session-message>
```

No turn was spent on "nothing changed yet". The daemon is the session's own child: its messages arrive at once, named `github-events` in the envelope, and it exits on its own when the session does.

## When to Apply

- A `git push` just ran on a branch with CI, or a PR was just opened: watch the PR.
- Waiting on a PR: a review, a reply, a merge, or "did CI pass?"
- A PR just merged, or a direct push landed on the mainline: watch the mainline branch, `owner/repo:main`, once per session; every tip it gets from then on is judged.

## Targets

```bash
bun "<skill-dir>/scripts/github-events.mts" watch owner/repo#12 --expect-workflow checks --expect-workflow lint
bun "<skill-dir>/scripts/github-events.mts" watch owner/repo:main --expect-workflow checks
```

| Target | Events | Ends |
| --- | --- | --- |
| `owner/repo#n`, a pull request | comment, review, ci, head, merged, closed, trouble | at the merge or close |
| `owner/repo:branch`, a branch tip | ci, head, trouble | never; every push to the branch is a new head |

Issues and security alerts are future target forms of this source, never new commands or skills.

`--expect-workflow <name>`, repeatable, names a gate: the `name:` of a workflow file under `.github/workflows/` that gates the target. The flags of one call are the complete gate set. A repeated `watch` of the same target replaces it, gates and cursor: its CI is judged again, and its activity baseline is taken afresh.

Without a daemon, `watch` exits 3 and prints the exact start command. A PR's first sighting reports none of the comments or reviews already on it; only what lands afterwards is an event. Its CI verdict and its merged or closed state are judged at once.

## Events

Each message holds one poll's events, each with a URL, and the closing line `automated notice from github-events; no reply needed`. Never reply to it. Every text is structure: who, where, how many, which state, which SHA. Nothing a comment, a review, or a build log said is in a message; the URL is where to read it.

| Kind | The line says | What to do |
| --- | --- | --- |
| `comment` | `PR owner/repo#12: 2 new comments by octocat at src/x.ts:41, src/y.ts:7`, the newest comment's URL | open the URL and triage it as a review round |
| `review` | `PR owner/repo#12: review by octocat (CHANGES_REQUESTED), 3 comments`, the review's URL | the same, per the `/pr-landing-discipline` skill |
| `ci` | `PR owner/repo#12: CI green on 1a2b3c4d5e6f: 3 workflows`, the checks page; or `PR owner/repo#12: CI red on 1a2b3c4d5e6f: checks / check / Run tests`, the failed run's URL | green: carry on; red: `gh run view <id> --log-failed` for the excerpt, fix, push, and the next verdict arrives on its own |
| `head` | `PR owner/repo#12: head moved to 1a2b3c4d5e6f; last commit by octocat` (the commit's author, not who pushed), on every move, your own pushes included | a head you did not push: pull before touching the branch |
| `merged` | `PR owner/repo#12: merged into main` | stop babysitting; the mainline's CI is the branch target's business |
| `closed` | `PR owner/repo#12: closed without merging` | stop babysitting |
| `trouble` | `PR owner/repo#12 is not readable; unwatch it or check access`; `PR owner/repo#12: CI settled on 1a2b3c4d5e6f with no run of checks; check the workflow name` (or `no checks on 1a2b3c4d5e6f after 2 polls, so no run of checks`); `PR owner/repo#12: 3 reads failed; read the daemon log`; or the `/session-events` skill's line after three failed polls | tooling trouble, never a red or green pipeline; Gotchas below |
| busy | not a kind: a poll with an event, a pending rollup, or a head still being judged keeps the 60 s interval; a quiet poll moves to 300 s | nothing |

A branch target's lines open with `branch owner/repo:main:` instead. The comment line counts the viewer's own comments out. A review's inline comments are counted on its line and not again as comments.

### The CI rules

- **Green** is every named gate's latest run passed (skipped counts), or, with no gate named, the PR's aggregate rollup `SUCCESS`.
- **Red** is any named gate's latest run failed or cancelled with no newer run, or, with no gate, the rollup `FAILURE` or `ERROR`. The red line names up to 50 failed jobs per suite, each as workflow, job, and first failed step, and any gate with no run after `; no run of`.
- **A gate with no run** is pending while the rollup is pending, and one `trouble` event once the rollup settled without it, or after two polls on a head with no checks at all: a typo in the name, or a workflow that does not trigger on this ref.
- **No checks and no gate** is no CI, not pending: nothing is said, and the head idles until a rollup appears. Name the gate with `--expect-workflow` when a run must register.
- **The unit is the workflow.** Re-triggers stack runs on one SHA; the newest run of each workflow is judged, and an older cancelled one is superseded.
- **After a verdict**, the head is judged again when something moves: a gated head on every poll (a gate's re-run need not move the rollup), a gateless one when the rollup changes. The same verdict stays silent; a different one is a new `ci` event. A new head is judged from nothing.

## Polling Budget

GitHub throttles GraphQL in its own bucket and the Actions REST endpoints (`gh run list`, `gh run watch`, `gh run view`) in a secondary one that parallel watchers lock for longer than a run lasts. The daemon reads GraphQL only, once a minute while something moves and every five minutes while nothing does.

One poll costs one request per repository: every watched PR's row, every watched branch's tip, the check suites of each head still being judged or carrying named gates, and the viewer's login, aliased in one query (one more request per 30 PRs of a repository). On top of that:

- one detail read per PR whose row moved (comments, reviews, threads), paged back only to the last activity already seen
- one paged read for a head with more than 100 check suites
- one read per red verdict, naming up to 50 failed jobs per suite with their steps

At steady state, nothing moving, that is one request per repository every five minutes. Never run `gh run watch`, spawn a watcher subagent, or read the PR by hand between messages: the daemon is the one poller for this session.

When a workflow's runs share a `concurrency` group key, a newer push cancels the older head's pending run, so only the newest head gets a verdict; wait for it before pushing again.

## Commands

```text
github-events.mts daemon [--interval <s>] [--id <name> [--pid <pid>]]
github-events.mts watch <owner/repo>#<n> | <owner/repo>:<branch> [--expect-workflow <name>]... [--id <name>]
github-events.mts unwatch <target> | --all [--id <name>]
github-events.mts wait [--since <id>] [--timeout <s>] [--id <name>]
github-events.mts poll | status | stop [--id <name>]
```

| Exit | Meaning |
| --- | --- |
| 0 | ok; `stop` with no daemon running is ok too, and so is a second `daemon` start |
| 2 | usage (`CLAUDE_CODE_MESSAGING_SOCKET` unset and no `--id`, a target in neither form, a blank gate name), no runtime directory, or the `/session-events` skill not installed beside this one: `install it beside this skill: npx skills add Vivswan/skills -g --skill session-events` |
| 3 | no daemon answers for this session: stderr names the socket and the exact background command that starts one |
| 4 | `wait` only: the timeout passed with no newer line |

`--interval` is 60 s by default. The file sink (`--id`), `wait` and its cursor, and the runtime files are the `/session-events` skill's; the log line of this source is `{"id":17,"at":"2026-10-12T14:03:20Z","repo":"owner/repo","pr":12,"sha":"1a2b...","kind":"ci","text":"...","url":"..."}`, with `branch` in place of `pr` on a branch target's line.

In a fleet, the lead's session runs the daemon as its own background task, `--mode` matching the session, and watches the fleet's PRs; a builder never runs `watch` there. When the lead wants a builder to act on a review line, it forwards that line by one message.

## Gotchas

| What you see | What it means | What to do |
| --- | --- | --- |
| `watch` exits 3 naming a socket and a command | no daemon for this session | run the printed command as a background task, then `watch` again |
| the daemon stops on its own about two hours in, the session still running | the harness's cap on a background task; the `/session-events` skill's page owns the row | start it again with the same command; the saved targets carry on |
| a `trouble` event after three failed polls | gh, the network, or GitHub refused three polls in a row; `gh auth status` is the first check | fix what the daemon log names; a stale token needs `stop` and a fresh start, since the daemon inherited the session's |
| a `trouble` event: CI settled with no run of a gate | the named workflow never registered a run on the head | check the name against `.github/workflows/*.yml`, then `watch` again with the right set; never read the rollup as green |
| a `trouble` event: not readable | the PR or branch answers null: deleted, renamed, or no access | `unwatch` it, or fix the access |
| a `trouble` event: 3 reads failed | this one target's detail or paged suites read failed three polls in a row while the repository read kept answering | read the daemon log; the target is retried every poll and the counter resets on a success |
| a red line with workflow names only | the failed-jobs read failed; the verdict stands | `gh run view <id> --log-failed` on the run URL's id |
| `gh` missing | `daemon` polls fail from the first | install and authenticate the GitHub CLI; until then, report the push with the PR URL and never silently skip the watch |

A local subagent spawned with the Agent tool shares its session's inbox socket and pid, so a `watch` run inside it subscribes the session's daemon, and the events land with the session. A teammate from agent teams is a separate process with its own socket and runs its own daemon.
