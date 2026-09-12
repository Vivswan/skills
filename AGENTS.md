<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by the platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

Skills: Installable, plugin-ready skills that give coding agents disciplined workflows, from code standards and review gates to multi-agent orchestration

## Conventions

- PR titles and commit subjects are Conventional Commits; PRs are squash-merged, so the PR title becomes the commit subject.
- CI gates on the `all-green` check. This repository's own jobs go in the repo-owned `checks.yml` (tests, lint) and `post-green.yml` (green-gated work on main); `ci.yml` is managed.
- Plain ASCII punctuation only; the check-typography gate enforces it.

## Managed by the platform

- A file whose header says "managed by Vivswan/repo-platform" arrives by sync PR. Change it there, never here.
- Repository settings come from `.github/settings.local.yml` (this repository's own) merged with the fleet layers into the rendered `.github/settings.yml`. Edit the local file, never the rendered one or the GitHub UI.
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync applies a change. Contracts: the platform's docs/new-repo.md and docs/fleet-guidelines.md.

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
