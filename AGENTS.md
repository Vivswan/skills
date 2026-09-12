<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

Skills: Installable, plugin-ready skills that give coding agents disciplined workflows, from code standards and review gates to multi-agent orchestration

## Conventions

- PR titles and commit subjects are Conventional Commits; with the release-please module they drive its versioning. PRs are squash-merged, so the PR title becomes the commit subject; with the pr-title module, its check validates the title.
- CI gates on the `all-green` check, required by the managed ruleset. Under `.github/workflows/`, this repository's test and lint jobs go in `checks.yml`, its green-gated work on main in `post-green.yml` (both repo-owned); `ci.yml` is managed.
- With the release-please module, a green push to main releases through the fleet's release pipeline; this repository's release steps go in the repo-owned `update-release.yml` and `update-release-pr.yml` hooks.
- Plain ASCII punctuation only: no curly quotes, em-dashes, or invisible unicode. The check-typography gate enforces it.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs from that repository. Do not edit them here; change them there.
- Repository settings are rendered into `.github/settings.yml` by Vivswan/repo-platform's sync from its fleet layers plus this repository's own `.github/settings.local.yml`. Edit that file, never the rendered one or the GitHub UI; the merge rules are in repo-platform's docs/settings.md.
- Repo-owned, never overwritten by sync: `checks.yml`, `post-green.yml`, `.gitleaks.toml`, `.gitignore` outside its managed region, `.typography-allow.local`, the release hooks, and the module starters (the release-please JSON files, the `.claude-plugin/` manifests, the nightly workflows).
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync PR applies a change. The per-module contracts are in repo-platform's docs/new-repo.md.
- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md.

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->
<!-- END REPO-PLATFORM MANAGED -->

### What this is

Installable skills for coding agents. Consumers run `npx skills add Vivswan/skills`; there is no release pipeline, main is what ships.

### Principles

- A skill is example-led: worked commands and copy-paste blocks a cold agent can follow, never abstract prose.
- The frontmatter `description` is a trigger ("Use when ..."), never a summary.
- Every skill has exactly one firing moment, disjoint from the others; fewer skills beats more.
- No backwards compatibility: renaming or retiring a skill is a normal change, done fully in one PR.
- Skill behavior and agent-facing text are product: `fix:`, not `docs:`.

### Working here

- `bun run check` before every push; `docs/authoring.md` walks a new skill through the layout the smoke test enforces.
- Commits carry the author email `58091053+Vivswan@users.noreply.github.com` and no attribution lines.
