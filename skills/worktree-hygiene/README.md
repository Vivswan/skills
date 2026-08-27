# Worktree Hygiene

`/worktree-hygiene` fires when a session creates, removes, hands over, or shares git worktrees. A worktree is shared mutable state, and every rule guards against a destructive failure seen in production:

- **Removal safety**: fresh status codes (never a stale dirty count), no live process with its cwd inside the tree, no locked tree removed blind; branch deletion waits for landing verified by ancestry against a just-fetched ref or by exact content (squash and rebase merges rewrite shas, so a failed ancestry check proves nothing)
- **Handover**: ownership transfers explicitly - stop the predecessor first, check for a live writer before editing, never message a stopped actor whose directory is gone
- **One branch, one worktree**: git refuses a checkout a sibling tree holds; release before taking it elsewhere
- **Shared `.git`**: config writes, identity, branches and tags, and hooks hit every sibling worktree at once
- **File ownership**: one owner per file across all rounds when several actors share a tree

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill worktree-hygiene
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/worktree-hygiene -g
```

## What It Does

- Gates every worktree removal on three fresh checks (clean by status codes, HEAD on a durable ref, no live writer) and every branch deletion on preserved work
- Treats `git branch -d` verdicts as noise: `-d` tests the branch's configured upstream (or HEAD), which need not be your mainline, so landing is verified by ancestry or content first, then deleted with `-D`
- Makes handovers explicit ownership transfers, with the stop-the-predecessor rule and the hash-sleep-hash live-writer probe
- Names the shared-`.git` hazards (config, identity, branches and tags, hooks) that let concurrent actors sabotage each other silently
- Assigns exactly one owner per file when several actors or rounds share one tree
- Pairs with [`/orchestrator-mode`](../orchestrator-mode/), which applies these rules across a whole fleet of builder worktrees

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
