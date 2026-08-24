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
  agents/openai.yaml     # required Codex sidecar: interface; policy when explicit-invocation-only
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
4. Fill in `SKILL.md` with activation criteria, workflow steps, and fallback behavior. Keep the frontmatter `description` a short trigger ("Use when ..."), and lead with worked examples, scenarios, or concrete commands rather than abstract prose.
5. Create `agents/openai.yaml` with an `interface` block mirroring the codex manifest (required; add `policy.allow_implicit_invocation: false` for explicit-invocation-only skills).
6. Add a human-facing `README.md`.
7. Update the root [`README.md`](../README.md) catalog.
8. List the new skill in [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json).
9. Run `bun run check`.

## Contributing Criteria to Reviews

A skill contributes to `/rubber-duck-review` second-opinion passes by declaring a `## Review Criteria` section in its `SKILL.md` - that alone joins it to every review; there is no registry to update. Keep the section short: a few bullets the reviewer can act on, plus a pointer to the skill's own workflow for triaging findings. The smoke test rejects a section without list items.

Criteria that only apply in a specific context use a differently named heading (e.g. `## Orchestration Review Criteria`) and are folded into reviews by the skill that owns that context instead of being auto-discovered.

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
- `agents/openai.yaml` exists and its interface mirrors the codex manifest
- `.claude-plugin/plugin.json` lists the skill directory, and `.claude-plugin/marketplace.json` stays consistent with it
- optional MCP files parse as JSON when present

## Template Notes

The files in [`template/`](../template) are intentionally marked internal or placeholder-only. They are for authors, not for public installation.
