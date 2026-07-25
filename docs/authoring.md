# Authoring Guide

This repository is built around a simple rule:

- every skill must work as a plain `SKILL.md`
- plugin manifests are optional enhancements
- MCP is optional and must never be the only path

## Repository Model

Use a shared skill core with agent-specific plugin layers:

```text
skills/<skill-name>/
  SKILL.md
  README.md
  .codex-plugin/plugin.json
  .mcp.json              # optional
  references/            # optional
  scripts/               # optional
```

This keeps the repo compatible with:

- Claude Code through `npx skills add ...` and optional marketplace/plugin metadata
- Codex through `npx skills add ...` and optional `.codex-plugin/plugin.json`
- GitHub Copilot through the installed skill content itself

## Adding a New Skill

1. Copy the starter files from [`template/`](../template).
2. Create `skills/<skill-name>/`.
3. Rename placeholders so the skill name, folder name, and plugin manifest name match.
4. Fill in `SKILL.md` with activation criteria, workflow steps, and fallback behavior.
5. Add a human-facing `README.md`.
6. Update the root [`README.md`](../README.md) catalog.
7. List the new skill in [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json).
8. Run `bun run check`.

## Compatibility Rules

- `npx skills add Vivswan/skills` is the primary install path.
- A skill must remain useful even if no plugin host is available.
- `SKILL.md` should contain the real workflow, not just pointers to MCP tools.
- Plugin manifests should improve discovery and UX, not hold the only business logic.
- GitHub Copilot should be treated as skill-first, not plugin-first.

## MCP Conventions

When a skill needs MCP:

- Keep the MCP config in the skill folder as `.mcp.json`.
- Add a `.mcp.json.example` first when the real config needs secrets or environment-specific commands.
- Describe required environment variables in the skill `README.md`.
- Add a "Fallback Without MCP" section in `SKILL.md`.
- Never require MCP to understand the skill's primary task.

Recommended pattern:

```text
skills/my-skill/
  SKILL.md
  README.md
  .codex-plugin/plugin.json
  .mcp.json.example
  references/
```

## Validation Checklist

- `SKILL.md` has valid frontmatter with `name` and `description`
- folder name matches the public skill name
- `README.md` exists for each public skill
- `.codex-plugin/plugin.json` exists and parses as JSON
- `.claude-plugin/plugin.json` lists the skill directory, and `.claude-plugin/marketplace.json` stays consistent with it
- optional MCP files parse as JSON when present

## Template Notes

The files in [`template/`](../template) are intentionally marked internal or placeholder-only. They are for authors, not for public installation.
