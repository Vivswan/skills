# Claude Remote Peers

`/claude-remote-peers` fires when a Claude Code session must reach a Claude Code session on another machine. The bridge script forwards each session's inbox socket to the other host over ssh, at the same path, and prints the `uds:` address to pass to `SendMessage`; the worked example is in [`SKILL.md`](./SKILL.md#the-specimen).

Replies arrive as pushed `<cross-session-message>` turns, the same as from a session on the local machine. Nothing is copied between the machines, nothing polls, and nothing stays running on the remote beyond the ssh session holding the forwards.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill claude-remote-peers
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/claude-remote-peers -g
```

## What It Does

- Finds the live Claude Code session on the remote from its registry, newest first or by pid
- Holds one ssh connection with `-L` for their inbox and `-R` for ours, each at its home path, and reports `bridge up` only after both forwarded sockets are confirmed present, the remote one over ssh
- Prints the `uds:` address for `SendMessage`; the remote replies to the message's `from` address on its own
- Removes both forwarded sockets on SIGTERM, Ctrl-C, or ssh exit, and exits 1 if the remote removal fails
- Documents the manual shell fallback for a host without bun

## Layout

- [`SKILL.md`](./SKILL.md): the specimen, the workflow, the manual fallback, the gotchas table
- [`references/protocol.md`](./references/protocol.md): diagrams, the socket and registry files, the wire format, the five facts the bridge rests on, why it copies nothing
- [`scripts/bridge.mts`](./scripts/bridge.mts): `bun scripts/bridge.mts <ssh-destination> [remote-pid] [-- <extra ssh options>]`; runs with bun alone and needs `python3` on the remote

## Requirements

| Need | Why |
| --- | --- |
| non-interactive `ssh <destination>` | keys or an agent; the script runs with `BatchMode=yes` |
| OpenSSH 6.7+ on both ends | Unix socket forwarding with `-L` and `-R` |
| Linux or macOS receiver | Windows inboxes require an auth token the bridge does not carry ([why](./references/protocol.md#the-five-facts-the-bridge-rests-on)) |
| a live Claude Code session on each side | each needs its own inbox socket |

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
