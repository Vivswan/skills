# Project Naming

`/project-naming` finds a name for a project, repository, tool, package, or paper, and checks each candidate on every registry before the owner sees it.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill project-naming
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/project-naming -g
```

## What It Does

- Interviews the owner first: the names they like the sound of become the brief every search lane scores against
- Runs one lane per naming style in parallel, each checking its best candidates by machine
- Ships `scripts/check-name.mts`: one row per name across PyPI, npm, crates, Hugging Face, GitHub, arXiv, DNS, Wiktionary (every sense, every language, offensive registers flagged), and Urban Dictionary, with a taken control and a random free control on every run
- Presents one ranked table with a verdict per name (CLEAR, MINOR with the collision named, TAKEN); a name never appears without its row
- Treats "none of these" as the normal second round, re-verifies the winner the same day, and records what was not checked

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
