# No Sleep-Waiting on Subagents

`/no-sleep-waiting-on-subagents` bans sleeping or polling while a background subagent runs: the harness notifies on completion, so the agent keeps working (or ends the turn) and reacts when the notification arrives.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill no-sleep-waiting-on-subagents
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/no-sleep-waiting-on-subagents -g
```

## What It Does

- Keeps the session productive while background subagents run
- Routes "need it now" cases to synchronous launches or blocking waits, never sleep loops
- Propagates the rule into spawn briefs so workers do not sleep-wait on their own children
- Distinguishes harness subagents (notified) from external state (watched via [`/watch-ci-after-push`](../watch-ci-after-push/)-style watchers)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
