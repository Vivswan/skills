# Skills

[![CI](https://github.com/Vivswan/skills/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/skills/actions/workflows/ci.yml)

A collection of skills for AI coding agents. Skills are packaged instructions and resources that extend agent capabilities.

## About This Repository

This repo keeps the collection-style catalog and install flow from `vercel-labs/agent-skills`, while also keeping each skill folder plugin-ready so MCP servers, hooks, or app integrations can be added later without changing the layout. The root [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json) publishes the whole catalog as a single `vivswan-skills` plugin for Claude Code marketplace installs, with [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) as the plugin manifest, but the main experience stays centered on `npx skills add ...`.

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

### no-invalid-states

Review and refactor code so invariants live in the type system instead of
scattered runtime checks: parse at boundaries, then make invalid internal
states impossible to construct.

**Use when:**

- Repeated defensive checks guard the same condition throughout a codebase
- Booleans encode lifecycle states, or optional fields must appear together
- Comments say "must call X before Y" and wrong ordering only fails at runtime
- You want "parse, don't validate" applied with the language's strongest
  idiomatic mechanism

**Categories covered:**

- Sum types: enums, discriminated unions, sealed classes
- Newtypes and branded types behind smart constructors
- Typestate and state-specific types for lifecycle APIs
- Boundary parsing with retained runtime checks for external data
- Per-language guidance: Rust, TypeScript, Python, and a survey of Go,
  JVM languages, C#, Swift, functional and dynamic languages, and schemas

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

Pin a release (see [releases](https://github.com/Vivswan/skills/releases) for the current tag):

```bash
npx skills add Vivswan/skills#vX.Y.Z -g
```

Or install everything as a Claude Code plugin:

```text
/plugin marketplace add Vivswan/skills
/plugin install vivswan-skills@vivswan-skills
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

Run the repo checks before publishing changes:

```bash
bun run check
```

That runs the TypeScript typecheck, the Biome lint, YAML and JSON schema lints, the unit tests, structural validation ([`scripts/validate-skills.ts`](./scripts/validate-skills.ts)), and cross-file consistency checks ([`scripts/smoke-test.ts`](./scripts/smoke-test.ts)). CI runs the same script through [`.github/workflows/checks.yml`](./.github/workflows/checks.yml), plus an end-to-end test that the real `npx skills` CLI discovers and groups every skill ([`scripts/cli-discovery-test.ts`](./scripts/cli-discovery-test.ts)).

## License

Individual and Small Organization License 1.0.0 - see [LICENSE.md](./LICENSE.md).
