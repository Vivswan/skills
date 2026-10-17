# Session Events

`/session-events` is the daemon behind event delivery to a Claude Code session: one per session and source, started by the session as a background task, polling a system for the targets the session watches. Each poll's alerts arrive as one message in the peer envelope, and its notes stay in the log. Every event is a line there, which a non-Claude agent reads with `wait`.

What is polled is a source: a script of a few lines that imports `runEvents` and says what a target is, how it is read, and what its events say. The `/watch-github` skill is the GitHub source; `scripts/examples/log-source.mts` watches a file and is the worked example for writing one.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill session-events
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/session-events -g
```

A skill that ships a source resolves this one as its sibling folder and exits 2 naming the install command above when it is absent.

## What It Does

- **One daemon per session and source**, started once as a background task; it is the session's own child, so its messages render as plain text, and it exits when the session does. The harness ends a background task after two hours; the saved state survives, so the session starts it again.
- **The envelope, and no quoted text**: every message names its sender, and a source says what moved (identifiers, counts, states, URLs) without quoting a line from the polled system, so nothing in a message reads as the owner's own words.
- **A log of every event**, numbered, appended before the state is saved, so a crash loses nothing and re-sends at most one poll. An event a source marks `level: "note"` lands there and is never delivered as a message, so a source says what is wrong as alerts and keeps the rest readable as notes.
- **A file sink** for Codex, the Copilot CLI, or a shell: a daemon named with `--id <name>` and a blocking `wait --id <name> --since <id>`.
- **A source contract of four fields**, worked through in the skill page with the file source.

## Layout

- [`SKILL.md`](./SKILL.md): the specimen, the source contract, the commands, the envelope, the lifecycle and files, and the gotchas
- [`scripts/session-events.mts`](./scripts/session-events.mts): the library a source imports: `runEvents(source)` is the CLI (`daemon`, `watch`, `unwatch`, `wait`, `poll`, `status`, `stop`) and the daemon. Exit 0 ok; 2 usage or no runtime directory; 3 no daemon for this session, naming the command that starts one; `wait` exits 4 on timeout.
- [`scripts/examples/log-source.mts`](./scripts/examples/log-source.mts): the file source.
- [`scripts/state.mts`](./scripts/state.mts) and [`scripts/inbox.mts`](./scripts/inbox.mts): the daemon's files and the inbox delivery.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
