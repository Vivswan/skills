# Contributing to skills

Thanks for contributing. Every change lands through a pull request; this page covers what a change goes through and how a skill is laid out.

## Pull requests

- Open a PR as a draft and flip it ready when it converges. PRs are squash-merged, so the PR title becomes the commit subject.
- PR titles and commit subjects are [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example `feat: add X`; the `pr-title` check validates the title.
- Run `bun run check` before pushing. CI runs the same command and gates on the `all-green` check.
- Plain ASCII punctuation only: no curly quotes, em-dashes, or invisible unicode.
- By opening a pull request, or offering code in an issue or review for inclusion, you agree to the Contributions section of [LICENSE.md](LICENSE.md).

## Security

Never report a vulnerability in an issue or pull request. Use GitHub's private "Report a vulnerability" route on the Security tab.

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
