# GitHub Relay

In a fleet, the lead's inbox is not the sink for GitHub events: the user's client renders inbox frames as the user's own messages. One relay subagent owns the fleet's GitHub daemon as a file sink and forwards every event by message to the agent that acts on it. The daemon is the `/session-events` skill's, running the `/watch-github` skill's source; this page is only the relay around it.

## Spawn Brief

Spawn the relay NAMED, as a long-running service agent (the spawn-brief checklist's standing-state rule applies), with the gate workflow names and the open PRs filled in:

```text
You are the GitHub relay for this session. You never edit files and never run git.
1. Start the daemon as YOUR background task (never nohup, setsid, or a shell that exits):
   bun "<skill-dir>/scripts/github-events.mts" daemon --id "relay-$CLAUDE_PID" --pid "$CLAUDE_PID"
   CLAUDE_PID is the session's pid, which you share, so the daemon ends with the session.
2. Subscribe every PR of the fleet, the mainline once, and any target the lead names later:
   bun "<skill-dir>/scripts/github-events.mts" watch <owner/repo>#<n> --expect-workflow <gate> --id "relay-$CLAUDE_PID"
   bun "<skill-dir>/scripts/github-events.mts" watch <owner/repo>:<mainline> --expect-workflow <gate> --id "relay-$CLAUDE_PID"
3. Loop in a foreground Bash call, the first time with --since 0:
   bun "<skill-dir>/scripts/github-events.mts" wait --id "relay-$CLAUDE_PID" --since <cursor> --timeout 540
   Exit 0: every JSON line is one event, forward each per the routing table; the last line,
   `cursor: <id>`, is the next --since. Exit 4: re-arm from the same cursor. Exit 3: the daemon
   is gone (the harness ends a background task after two hours, so this is routine): run step 1
   again, then re-arm; the saved state carries the targets and the cursor.
4. Forward with SendMessage, one message per event: its first line is the event's text, its
   second the URL. Add nothing and quote nothing; the text is structure and the URL is where to read.
When the lead says stop: bun "<skill-dir>/scripts/github-events.mts" stop --id "relay-$CLAUDE_PID", then end.
```

`--id "relay-$CLAUDE_PID"` keeps the events out of the session's inbox and apart from another lead's: a local subagent shares the session's `CLAUDE_CODE_MESSAGING_SOCKET`, so a `watch` without `--id` would subscribe the session's own daemon, and two sessions of one user share the runtime directory, so one fixed id would be one shared daemon, state, and log.

## Routing

| Kind | To | Why |
| --- | --- | --- |
| `ci` | the lead | a verdict moves the landing plan |
| `head` | the lead | a head the lead did not expect means someone else pushed |
| `merged`, `closed` | the lead | the track is landed or dead, and the board changes |
| `trouble` | the lead | tooling trouble, never a verdict |
| `review`, `comment` | the owning builder | the builder triages the round per the `/pr-landing-discipline` skill |

The lead names each PR's owning builder in the relay's brief and in every later message that adds a PR. A PR with no owner, the lead's own, routes to the lead.
