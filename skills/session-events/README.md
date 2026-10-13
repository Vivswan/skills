# Session Events

`/session-events` is the daemon behind event delivery to a Claude Code session: one per session and source, started by the session as a background task, polling a system for the targets the session watches. Each poll's events arrive as one message in the peer envelope, with content the polled system produced fenced after a boundary line, and as lines in a write-ahead log a non-Claude agent reads with `wait`.

What is polled is a source: a module that says what a target is, how it is read, and what its events say. The `/watch-prs-and-ci` skill is the PR and CI source; `scripts/examples/log-source.mts` watches a file and is the worked example for writing one.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill session-events
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/session-events -g
```

A skill that ships a source, such as `watch-prs-and-ci`, resolves this one as its sibling folder and exits 2 naming the install command above when it is absent.

## What It Does

- **One daemon per session and source**, started once as a background task; it is the session's own child, so its messages render as plain text, and it exits when the session does. The harness ends a background task after two hours; the saved state survives, so the session starts it again.
- **The envelope and the boundary**: every message names its sender, and text the polled system produced sits in a fence after a sentence that says it is data, never instructions.
- **A write-ahead log** of every event, numbered, saved in the state before it is appended and appended before it is delivered, so a crash loses nothing and a restart judges nothing twice.
- **A file sink** for Codex, the Copilot CLI, or a shell: a daemon named with `--id <name>` and a blocking `wait --id <name> --since <id>`.
- **A source contract** of a dozen members, worked through in the skill page with the file source.

## Layout

- [`SKILL.md`](./SKILL.md): the specimen, the source contract, the commands, the envelope and boundary, the daemon lifecycle and files, and the gotchas
- [`scripts/session-events.mts`](./scripts/session-events.mts): the CLI entry, run with bun: `session-events.mts <source.mts> daemon | <subscribe command> | unwatch | wait | poll | status | stop`. Exit 0 ok; 2 usage, a path that is not a source, or the source's preflight refusing; 3 no daemon for this session, naming the command that starts one; `wait` exits 4 on timeout.
- [`scripts/source.mts`](./scripts/source.mts): the `Source` and `Kit` types a source's factory is written against, its one import.
- [`scripts/examples/log-source.mts`](./scripts/examples/log-source.mts): the file source.
- The other `scripts/` modules are the daemon's parts: the control socket and CLI, the inbox delivery, and the state and log files.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
