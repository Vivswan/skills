# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

Skills: Installable agent skills and plugin-ready workflows for coding agents

## Toolchain

- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)
- See `package.json` scripts for the available commands.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`,
  `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the
  commit subject and drives release-please versioning. CI validates both
  (the ci.yml pr-title job + validate-commit-names).
- CI gates on a single required check named `all-green` in the managed
  `.github/workflows/ci.yml`. This repository's own test/lint jobs belong in
  `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not
  edit ci.yml, template sync overwrites it. The `release` job runs on top
  of the gate (`needs: all-green`); the release pipeline is repo-owned in
  `.github/workflows/release.yml` (pre/post-release jobs go there, around the
  managed release-please machinery).
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode). CI enforces this with the check-typography action; use plain ASCII
  punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform"
  arrive via sync PRs pushed by that repository. Do not edit them here;
  change them in Vivswan/repo-platform and let the next sync
  PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy)
  are applied from Vivswan/repo-platform: by the
  `settings/repos/` file named after this repository over there when one
  exists, otherwise by this repository's own `.github/settings.yml`. Do not
  change settings by hand in the GitHub UI; edit the settings file.
- Repo-owned escape hatches stay local:
  `.github/workflows/checks.yml`,
  `.github/workflows/release.yml`, `.gitleaks.toml`,
  `.gitignore`'s marked LOCAL section, `.typography-allow.local`
  (typography exemptions; the managed `.typography-allow` is overwritten
  by sync), and the repository-specific section below.
- Module selection is this repository's own: edit the `modules` list in
  `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below. This section survives template
     updates via three-way merge. -->
<!-- repo-platform:local-section -->

### What this repository is

A collection of installable skills, plugins, and MCP-ready integrations for
coding agents. Skills are packaged instructions and resources that extend
agent capabilities. Consumers install with `npx skills add Vivswan/skills`
(single skill: `--skill <name>`). Claude Code users can also install the
`vivswan-skills` plugin through the marketplace defined in
`.claude-plugin/marketplace.json`.

### Layout

```text
.claude-plugin/
  marketplace.json   catalog + version (bump by hand when releasing)
  plugin.json        plugin manifest; the authority for the skills list
skills/
  <skill-name>/
    SKILL.md
    README.md
    .codex-plugin/plugin.json
    references/
    scripts/
template/            starter files for the next skill
scripts/             repo check scripts (TypeScript, run with bun)
```

### Creating a new skill

- Keep every public skill in `skills/<skill-name>/`, kebab-case, with
  `SKILL.md` uppercase and valid YAML frontmatter.
- Keep `SKILL.md` focused on activation logic and workflow; put supporting
  detail in `references/` and executable helpers in `scripts/`.
- Keep each skill folder plugin-ready by maintaining
  `.codex-plugin/plugin.json`. If a skill grows MCP, hooks, or app
  integrations later, add those files inside the same skill folder instead of
  changing the repo layout.
- If a skill uses MCP, `SKILL.md` must still explain how to complete the task
  when the MCP server is unavailable.
- Treat `npx skills add ...` and the plain skill content as the compatibility
  baseline for Claude Code, Codex, and GitHub Copilot.
- List the new skill in `.claude-plugin/plugin.json` (`skills`) and add a
  `### <skill-name>` section to the root `README.md`. The smoke test fails
  the build if either is missing.
- Follow `docs/authoring.md` for the shared skill-core plus plugin-layer
  model.

### Publishing hygiene

- Update the root `README.md` whenever you add, rename, or remove a skill.
- Keep the files in `template/` useful as the starter for the next skill.
- Run `bun run check` before publishing or opening a PR (also enforced by the
  pre-commit hook and CI).
- Never rename or move a published skill folder: consumer lock files record
  the path, and `npx skills update` breaks for existing installs.
- Never add a file named `metadata.json` inside a skill folder; the
  `npx skills` CLI silently drops it at install time.

### Releases

- Versioning is single-source. The catalog version lives only in
  `.claude-plugin/marketplace.json` (`metadata.version`). Bump it there when
  cutting a release, and don't add a `version` to any skill's `SKILL.md`, to
  `.codex-plugin/plugin.json`, or to `.claude-plugin/plugin.json`; duplicates
  only drift, and the smoke test rejects them.
- There is no automated release pipeline: release-please was removed from
  this repo (the module is deselected in `.repo-platform.yml`). Consumers
  install from `main` with `npx skills add Vivswan/skills`.
- Changes to skill behavior, plugin manifests, MCP configuration, or
  agent-facing instructions are product changes in this repo. Use `fix:` for
  those updates, not `docs:`, even when the changed file is Markdown.

### Commit rules

- Preserve the Git author email as
  `58091053+Vivswan@users.noreply.github.com` for commits made from this
  repo.
- No attribution lines in commits or PR descriptions: never add
  `Generated by`, `Co-Authored-By`, `claude`, `codex`, or `copilot`.
