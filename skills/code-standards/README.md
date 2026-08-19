# Code Standards

`/code-standards` packages house standards for maintainable code and the artifacts around it, each with a concrete specimen: systemic fixes over instance patches, guard tests for recurring problems, general-purpose over special-case, maintainability over effort, lean comments, no barrel files or pass-through functions, no planning references in code, lean AGENTS.md files, content-only commit messages, and no text blobs (scannable structure everywhere).

It doubles as a review-criteria companion: when installed alongside [`/rubber-duck-review`](../rubber-duck-review/), its `## Review Criteria` section is folded into the reviewer prompt automatically.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill code-standards
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/code-standards -g
```

## What It Does

- Applies the standards while writing code, not just at review time
- Contributes review criteria to [`/rubber-duck-review`](../rubber-duck-review/) second-opinion passes
- Ties each reviewer finding back to a named standard for consistent triage
- Defers to explicit user or project decisions, recording the standard set aside

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
