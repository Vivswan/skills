# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## Repository Overview

A collection of installable skills for coding agents. Skills are packaged instructions and resources that extend agent capabilities.

## Repository Layout

```text
skills/
  <skill-name>/
    SKILL.md
    README.md
    .codex-plugin/plugin.json
    .mcp.json
    references/
    scripts/
template/
  SKILL.md
  README.md
  .codex-plugin/plugin.json
  .mcp.json.example
```

## Creating a New Skill

### Naming Conventions

- Keep every public skill in `skills/<skill-name>/`.
- Use kebab-case for directory names and skill names.
- `SKILL.md` must stay uppercase and use valid YAML frontmatter.

### Skill Structure

- Keep `SKILL.md` focused on activation logic and workflow.
- Put supporting detail in `references/`.
- Add `scripts/` only when the skill needs executable helpers.
- Keep each skill folder plugin-ready by maintaining `.codex-plugin/plugin.json`.
- If a skill grows MCP, hooks, or app integrations later, add those files inside the same skill folder instead of changing the repo layout.
- If a skill uses MCP, `SKILL.md` must still explain how to complete the task when the MCP server is unavailable.
- Treat `npx skills add ...` and the plain skill content as the compatibility baseline for Claude Code, Codex, and GitHub Copilot.

### Publishing Hygiene

- Update the root `README.md` whenever you add, rename, or remove a skill.
- Keep the files in `template/` useful as the starter for the next skill.
- Run `uv run python scripts/validate-skills.py` before publishing or opening a PR.

### Releases

- **Don't hand-edit the version.** Releases are driven by [release-please]
  (`release-please-config.json`) from Conventional Commit messages. Because PRs
  are squash-merged, the **PR title** is the commit subject release-please reads,
  and `.github/workflows/pr-title.yml` enforces it: `feat:` → minor, `fix:` →
  patch, `feat!:`/`BREAKING CHANGE` → major, `chore:`/`docs:` → no release.
- On push to `main`, release-please opens/updates one rolling **release PR** that
  bumps `metadata.version` in `.claude-plugin/marketplace.json` (the single
  source of truth) and regenerates `CHANGELOG.md`. **Merging that PR** tags
  `vX.Y.Z` and publishes the GitHub release. A plain push releases nothing.
- Consumers pin a release with `npx skills add Vivswan/skills#vX.Y.Z`.
- **`version` stays out of per-skill files.** Don't add `version` to a skill's
  `SKILL.md` frontmatter or `.codex-plugin/plugin.json` — the `npx skills` CLI
  ignores per-skill versions (it resolves by git ref + content hash), and
  duplicates only drift. `scripts/smoke-test.py` fails the build if one reappears.
- **One-time setup the workflow depends on:**
  - *Settings → Actions → General →* enable **"Allow GitHub Actions to create and
    approve pull requests"**, or the release PR can't be opened.
  - Add a `RELEASE_PLEASE_TOKEN` secret (PAT or GitHub App token). Without it the
    PR still opens via `GITHUB_TOKEN`, but **CI won't run on the release PR**
    (Actions can't trigger Actions), so the required `validate` check stays unmet
    and you'd have to admin-merge.
  - **Create the baseline tag once:** `.release-please-manifest.json` says the
    current version is `1.1.0`, but no `v1.1.0` tag exists yet. Without a release
    boundary, release-please's first PR can sweep all prior history into the
    changelog. Anchor it before the first run: `git tag v1.1.0 <release-commit> &&
    git push origin v1.1.0` (or set `bootstrap-sha` in the config).

[release-please]: https://github.com/googleapis/release-please

## Publishing Notes

- Collection installs should use `npx skills add Vivswan/skills`.
- Single-skill installs can target the repo path or use `--skill <name>`.
- Preserve the Git author email as `58091053+Vivswan@users.noreply.github.com` for commits made from this repo.
- Follow [`docs/authoring.md`](./docs/authoring.md) for the shared skill-core plus plugin-layer model.
