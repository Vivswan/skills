
## Creating a skill

Start from the files in [`template/`](./template), then add the new skill under [`skills/`](./skills). The full authoring guide lives in [`docs/authoring.md`](./docs/authoring.md).

At minimum, a new skill includes:

- `SKILL.md`
- `README.md`
- `.codex-plugin/plugin.json`
- `agents/openai.yaml` (interface mirroring the codex manifest)

If the skill needs MCP later, add a local `.mcp.json` based on the template example and keep the plain-skill fallback in `SKILL.md`.

## Skill structure

Each skill can contain:

- `SKILL.md`
- `README.md`
- `.codex-plugin/plugin.json`
- `agents/openai.yaml` (required Codex sidecar: interface; policy for explicit-invocation skills)
- `.mcp.json`
- `references/`
- `scripts/`
