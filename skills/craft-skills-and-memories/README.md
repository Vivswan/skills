# Craft Skills and Memories

`/craft-skills-and-memories` covers both ends of the lifecycle of an agent's instruction sources:

- **Creating** skills and memories to a shared quality bar: example-led, trigger-form descriptions, right scope.
- **Repairing** them at their canonical source when they fail in practice.

Skills stay general-purpose. Memories are created and fixed at their own scope, project-specific or common.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill craft-skills-and-memories
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/craft-skills-and-memories -g
```

## What It Does

- Creates new skills and memories example-led, in the right home and scope, wired into their catalog or index
- Separates skill defects from transient failures (outages, sandboxes, local config)
- Finishes the user's task first, then repairs the skill or memory
- Edits the canonical source when authorized, or reports the defect with a proposed fix
- Routes every edit through whatever checks and review govern where it lives

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
