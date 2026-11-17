# Think in Trees

`/think-in-trees` fires whenever an agent works out where something belongs or how a set of things relates: a file or folder, a command or flag, a page, a menu item, a setting, an alert, a task, a step in a failing chain. The tree is the analysis; the drawing is how the owner sees it.

```text
hold the whole tree
  -> first level = the dimension the reader arrives with
  -> run the checks
  -> agree, then move
  -> guard it
```

The checks need no judgment once the picture exists: look-alike siblings, one concept under two names, a child under the wrong parent, a leaf missing from its listing, a leaf legal only under another leaf, a node with more than about eight children, two rows that say one thing.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill think-in-trees
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/think-in-trees -g
```

## What It Does

- Places every thing in the whole tree before answering, and shows the owner that tree as text before any prose
- Puts the dimension the flat form hid on the first level: situation kind, state ownership, concept, account, reader action, dependency
- Runs the seven checks and names each fault with its node
- Moves as a pure move, then splits and rewrites, then adds a guard so the tree holds: a folder cap, tests mirroring sources, a sidebar in tree order
- Carries one specimen per surface in `references/`: folders, CLI, docs, navigation, config, streams, debugging
- Hands the file inside the folder to [`/code-standards`](../code-standards/), a flag legal only under another flag to [`/no-invalid-states`](../no-invalid-states/), and the words beside the picture to [`/working-text`](../working-text/)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
