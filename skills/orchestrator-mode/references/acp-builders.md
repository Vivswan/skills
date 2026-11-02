# ACP Builders

A builder that is not a Claude Code subagent (Codex, Gemini CLI, or a Claude Agent outside the Agent tool) runs as an ACP agent under `scripts/acp-runner.mts`. The runner spawns the adapter in the builder's worktree, holds one session open, and takes the lead's prompts over a control socket. The session's files sit beside the session-events daemons' files, where the fleet monitor reads them every poll (`references/fleet-monitor.md`, the `builder` rows).

```text
lead  --acp-runner prompt-->  runner (the adapter's parent)  --session/prompt-->  codex-acp | claude-agent-acp | gemini --acp
      <--state.json, events.jsonl--                          <--session/update, session/request_permission--
```

## The Specimen

The lead starts one runner per builder as a BACKGROUND task, then hands it the brief:

```bash
bun "<skill-dir>/scripts/acp-runner.mts" start --name parser --cwd /repo/.claude/worktrees/feat-parser --mode workspace-write --adapter codex-acp
bun "<skill-dir>/scripts/acp-runner.mts" prompt --name parser --file /tmp/fleet-4242/briefs/parser.md
bun "<skill-dir>/scripts/acp-runner.mts" status --name parser
```

```text
acp-runner parser pid 4242: codex-acp in /repo/.claude/worktrees/feat-parser; session 01a1...; socket /run/user/1000/session-events/parser.acp-runner.sock; state /run/user/1000/session-events/parser.acp-runner.state.json
prompted
{ "phase": "busy", "lastStop": null, "steering": false, ... }
```

The turn ends with `"phase": "idle"` and `"lastStop": "end_turn"` in the state, and the events log holds every update, permission, and stop. `cancel` interrupts a turn; `stop` ends the session and the adapter.

## Adapters and Modes

| Builder | Adapter on PATH | Install | Mode for a builder |
| --- | --- | --- | --- |
| Codex | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` | `workspace-write` |
| Claude Agent | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` | `acceptEdits` |
| Gemini CLI | `gemini --acp` | the Gemini CLI | its default |

`--mode` must name a mode the adapter advertises in `session/new`; one it does not is a usage error naming the offered ones. `--adapter` comes last and owns the rest of the line, so an adapter's own flags (`gemini --acp`) pass through.

## The Permission Rule

The owner's rule: a builder writes its own worktree and nothing else. Every command runs. A file tool whose locations all sit inside `--cwd` runs. One with a location outside is refused with the adapter's reject option and recorded in the events log with the paths; `--allow-outside` lifts it for a builder whose brief grants more.

A refusal ends the turn on codex-acp (its reject means "tell Codex what to do differently"); claude-agent-acp marks the call failed and goes on. The state's `lastStop` says which.

## Forwarding a Line

A github-events line for an ACP builder goes to it the way the lead forwards one to a Claude builder by message, with the same judgment about which line is the builder's to act on:

```bash
bun "<skill-dir>/scripts/acp-runner.mts" prompt --name parser "lead: PR owner/repo#12: review by octocat (CHANGES_REQUESTED), 3 comments https://github.com/owner/repo/pull/12#pullrequestreview-7"
```

```text
prompted   the builder was idle: the line is this turn
injected   the adapter steers (codex-acp, claude-agent-acp advertise it): the line joins the running turn
queued     no steering, or the turn ended as the steer arrived: the line is the next turn's prompt, sent as soon as the builder is idle
```

The lead opens the text with `lead:` so the builder tells the lead's words from its own brief; the spawn brief says so (`references/spawn-briefs.md`, ACP-Run Builders).

## The Command

```text usage=skills/orchestrator-mode/scripts/acp-runner.mts
usage: acp-runner.mts <command> [options]
  start --name <builder> --cwd <worktree> [--mode <id>] [--allow-outside] --adapter <command> [args...]
      spawn the adapter in the worktree, open one ACP session there, and serve the control socket until stop
  prompt --name <builder> (<text> | --file <path>)   the builder's next turn: prompted when idle, injected into the running turn where
                                                     the adapter steers, else queued for the turn after
  status --name <builder>                            print the state file as JSON
  cancel --name <builder>                            interrupt the running turn
  stop --name <builder>                              end the session and the adapter
--name is [a-z0-9-]{1,40}; --cwd is the builder's worktree, absolute; --adapter is last and takes the rest of the line
--mode names a session mode the adapter advertises (codex-acp: read-only, workspace-write, agent, agent-full-access;
  claude-agent-acp: default, acceptEdits, plan, auto, bypassPermissions); one it does not advertise is a usage error
permissions: every command runs; a file tool whose locations all sit inside the worktree runs; one outside is refused
  and recorded, unless --allow-outside
files: <dir>/<name>.acp-runner.{state.json,events.jsonl,sock}; <dir> is $SESSION_EVENTS_DIR, else $XDG_RUNTIME_DIR/session-events,
  else $CLAUDE_CODE_TMPDIR/session-events-<uid>, else <os tmpdir>/session-events-<uid>, else /tmp/session-events-<uid>
prints: start, one banner line, then nothing until it exits; prompt, one word: prompted, injected, or queued;
  status, the state object; cancel and stop, one word: cancelled, stopped
exits: 0 ok; 1 prompt refused (the runner still starting, or ended), or start ending because the adapter exited;
       2 usage, a mode the adapter lacks, or a runner of this name already serving; 3 no runner answers for this name
```
