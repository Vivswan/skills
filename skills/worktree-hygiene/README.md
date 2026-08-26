# Worktree Hygiene

`/worktree-hygiene` fires when a session creates, removes, hands over, or shares git worktrees. A worktree is shared mutable state, and every rule guards against a destructive failure seen in production:

- **Removal safety**: fresh status codes (never a stale dirty count), landing verified by ancestry or by content (squash and rebase merges never land the branch's shas), no live process with its cwd inside the tree, no locked tree removed blind
- **Handover**: ownership transfers explicitly - stop the predecessor first, prove no live writer before editing, never message a stopped actor whose directory is gone
- **One branch, one worktree**: git refuses a checkout a sibling tree holds; release before taking it elsewhere
- **Shared `.git`**: config writes, identity, refs, and hooks hit every sibling worktree at once
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

- Gates every worktree removal on three fresh checks: clean by status codes, landed by content, no live writer
- Treats branch deletion verdicts by workflow: a refused `git branch -d` is normal under squash merges and meaningful under merge commits
- Makes handovers explicit ownership transfers, with the stop-the-predecessor rule and the hash-sleep-hash live-writer probe
- Names the shared-`.git` hazards (config, identity, refs, hooks) that let concurrent actors sabotage each other silently
- Assigns exactly one owner per file when several actors or rounds share one tree
- Pairs with [`/orchestrator-mode`](../orchestrator-mode/), which applies these rules across a whole fleet of builder worktrees

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
