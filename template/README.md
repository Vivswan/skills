# Template Skill

Use this folder as the starting point for a new skill in this repository.

## What to Copy

Copy these files into `skills/<your-skill-name>/` and then replace the placeholders:

- `SKILL.md`
- `README.md`
- `LICENSE.md` (the smoke test requires a byte-identical copy of the root `LICENSE.md` in every skill)
- `.codex-plugin/plugin.json`
- `agents/openai.yaml`
- `references/author-notes.md`
- `.mcp.json.example` if the skill may grow MCP support later

Then delete the `internal: true` line from the copied `SKILL.md` metadata: it keeps `template/` out of `npx skills` listings, and the validator rejects it on a published skill (the CLI would silently drop the skill from installs).

## Compatibility Target

Every new skill should remain usable through:

- `npx skills add Vivswan/skills`
- Claude Code
- Codex
- GitHub Copilot

That means the public `SKILL.md` must be complete even before any plugin or MCP enhancements are added.
