# Contributing to skills

Thanks for contributing. Every change lands through a pull request; this page covers what a change goes through and how a skill is laid out.

## Pull requests

- Open a PR as a draft and flip it ready when it converges. PRs are squash-merged, so the PR title becomes the commit subject.
- PR titles and commit subjects are [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example `feat: add X`; the `pr-title` check validates the title.
- The pre-commit hook runs `bun run check:staged`: the static checks listed in [`scripts/check-staged.mts`](./scripts/check-staged.mts), then only the tests a staged file reaches, by import, by its skill's test folder, by file name in the test's text, or by a glob the test's first line declares.
- CI runs the full `bun run check` (its steps are the `check` script in [`package.json`](./package.json)) through [`.github/workflows/checks.yml`](./.github/workflows/checks.yml), plus an end-to-end test that the real `npx skills` CLI discovers and groups every skill ([`scripts/cli-discovery.mts`](./scripts/cli-discovery.mts)). It gates on the `all-green` check; do not run it locally.
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
