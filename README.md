# Skills

[![Validate Skills](https://github.com/Vivswan/skills/actions/workflows/validate-skills.yml/badge.svg)](https://github.com/Vivswan/skills/actions/workflows/validate-skills.yml)

A collection of skills for AI coding agents. Skills are packaged instructions and resources that extend agent capabilities.

## About This Repository

This repo keeps the collection-style catalog and install flow from `vercel-labs/agent-skills`, while also keeping each skill folder plugin-ready so MCP servers, hooks, or app integrations can be added later without changing the layout. The root [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json) is there for future marketplace-style installs, but the main experience stays centered on `npx skills add ...`.

## Compatibility

The repo is designed around a shared skill core plus optional agent-specific plugin metadata.

| Capability | Claude Code | Codex | GitHub Copilot |
| --- | --- | --- | --- |
| Install with `npx skills add Vivswan/skills` | Yes | Yes | Yes |
| Plain `SKILL.md` workflow | Yes | Yes | Yes |
| Root `.claude-plugin/marketplace.json` | Yes, optional enhancement | Not primary path | Not primary path |
| Per-skill `.codex-plugin/plugin.json` | Not primary path | Yes, optional enhancement | Not primary path |
| MCP via per-skill config | Yes, if the plugin host supports it | Yes, if the plugin host supports it | Keep a skill-only fallback |

Compatibility rules for every skill in this repo:

- `npx skills add ...` is the primary install path across agents.
- `SKILL.md` must contain a complete fallback workflow even if plugin or MCP integrations are added.
- Plugin manifests are additive enhancements, not a requirement for using the skill.
- GitHub Copilot compatibility should assume skill-first installation rather than plugin-specific behavior.

## Available Skills

### natural-writing

Write and edit prose that avoids the documented signs of AI writing from
[Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

**Use when:**

- Drafting human-facing prose: docs, READMEs, articles, blog posts, emails, PR descriptions
- Rewriting text to remove AI tells ("humanize this")
- Checking whether text reads as AI-generated

**Categories covered:**

- Inflated significance, promotional tone, weasel attributions
- AI vocabulary clusters and copula avoidance
- Formatting tells: bold-label lists, Title Case headings, emoji, dash punctuation (banned outright)
- Chat artifacts, placeholders, tool residue, fabricated citations

### rubber-duck-review

Cross-model code review using a second agent, tool, or read-only CLI fallback.

**Use when:**

- You want a second opinion before merging or shipping
- You want another model to review correctness, naming, or long-term design risk
- You want a review-only pass that will not modify files

**Categories covered:**

- Correctness issues
- Future-proofing risks
- Naming and design traps
- Hardcoded assumptions that may age badly

## Installation

```bash
npx skills add Vivswan/skills -g
```

Install a specific skill:

```bash
npx skills add Vivswan/skills -g --skill rubber-duck-review
```

Install to a specific agent:

```bash
npx skills add Vivswan/skills -g --skill rubber-duck-review -a codex
npx skills add Vivswan/skills -g --skill rubber-duck-review -a claude-code
npx skills add Vivswan/skills -g --skill rubber-duck-review -a github-copilot
```

Install directly from the skill folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/rubber-duck-review -g
```

## Usage

Skills are automatically available once installed. The agent will use them when relevant tasks are detected.

**Examples:**

```bash
Rubber duck this patch before we merge it
```

```bash
Get a second opinion on this refactor
```

## Creating a Basic Skill

Start from the files in [`template/`](./template), then add the new skill under [`skills/`](./skills).

The full authoring guide lives in [`docs/authoring.md`](./docs/authoring.md).

At minimum, a new skill should include:

- `SKILL.md`
- `README.md`
- `.codex-plugin/plugin.json`

If the skill needs MCP later, add a local `.mcp.json` based on the template example and keep the plain-skill fallback in `SKILL.md`.

## Skill Structure

Each skill can contain:

- `SKILL.md`
- `README.md`
- `.codex-plugin/plugin.json`
- `.mcp.json`
- `references/`
- `scripts/`

## Validation

Run the local validator before publishing changes:

```bash
uv run python scripts/validate-skills.py
```

The same checks also run in GitHub Actions through [`.github/workflows/validate-skills.yml`](./.github/workflows/validate-skills.yml).

## License

MIT
