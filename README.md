# Skills

[![CI](https://github.com/Vivswan/skills/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/skills/actions/workflows/ci.yml)

A collection of skills for AI coding agents. Skills are packaged instructions and resources that extend agent capabilities.

## About This Repository

This repo keeps the collection-style catalog and install flow from `vercel-labs/agent-skills`, while also keeping each skill folder plugin-ready so MCP servers, hooks, or app integrations can be added later without changing the layout. The root [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json) publishes the catalog as the `vivswan-skills` plugin for Claude Code marketplace installs, with [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) as the plugin manifest, plus a `xeno` plugin that groups the skills vendored from other repositories under their own heading, but the main experience stays centered on `npx skills add ...`.

## Available Skills

### Automatic

The agent applies these on its own when the task matches:

- [/code-standards](./skills/code-standards/) - House standards for maintainable code, folded into reviews
- [/codex-browser-fix](./skills/codex-browser-fix/) - Codex only: keeps the bundled Chrome plugin driving Brave and other Chromium browsers through app updates and custom model providers
- [/craft-skills-and-memories](./skills/craft-skills-and-memories/) - Create and repair skills and memories at their canonical source
- [/docs-discipline](./skills/docs-discipline/) - Repository docs that skim well and name real code: shape rules, a paragraph-cap and path probe, and an architecture page that cannot rot
- [/never-twice](./skills/never-twice/) - Climb every repeated failure to the most durable fix reachable
- [/no-invalid-states](./skills/no-invalid-states/) - Invariants in the type system instead of runtime checks
- [/pr-and-issue-discipline](./skills/pr-and-issue-discipline/) - PRs and issues that show the change instead of describing it
- [/pr-landing-discipline](./skills/pr-landing-discipline/) - Draft flips, review rounds to convergence, line accounting, and a human-gated merge
- [/rubber-duck-review](./skills/rubber-duck-review/) - Cross-model, read-only second-opinion code review
- [/verify-with-controls](./skills/verify-with-controls/) - Controls and evidence before a zero, alarm, success claim, or stillness becomes a conclusion
- [/watch-ci-after-push](./skills/watch-ci-after-push/) - Background CI watcher after every push or merge
- [/worktree-hygiene](./skills/worktree-hygiene/) - Safe worktree removal, gated retirement of landed branches, explicit handovers, shared-repo rules

### Invoked by you

Load only when you invoke them (`/skill-name` in Claude Code, `$skill-name` in Codex):

- [/natural-writing](./skills/natural-writing/) - Prose without AI writing tells
- [/orchestrator-mode](./skills/orchestrator-mode/) - Parallel worktree subagents with gated landings, direct or PR-based

### Xeno

Xeno, from the Greek for foreign: skills written in other repositories, vendored here from their upstream at a pinned commit and refreshed nightly ([how](./xeno/README.md)):

- [/unslop](./xeno/unslop/) - Cut AI tells from any writing (from [cursor/plugins](https://github.com/cursor/plugins))
- [/frontend-design](./xeno/frontend-design/) - Distinctive visual design for new or reshaped UI, invoked by you in Claude Code (from [anthropics/skills](https://github.com/anthropics/skills))
- [/design-taste-frontend](./xeno/design-taste-frontend/) - Anti-slop frontend for landing pages, portfolios, and redesigns, invoked by you in Claude Code (from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill))

How the skills reference each other (an arrow means "mentions and hands off to, where installed"):

```mermaid
graph LR
  cbf["/codex-browser-fix"]
  dd["/docs-discipline"] --> rdr
  dd --> pid
  dd --> cs
  cs --> dd
  nw --> dd
  om["/orchestrator-mode"] --> rdr["/rubber-duck-review"]
  om --> wca["/watch-ci-after-push"]
  om --> cs["/code-standards"]
  om --> pid["/pr-and-issue-discipline"]
  om --> pld["/pr-landing-discipline"]
  om --> wh["/worktree-hygiene"]
  pid --> pld
  pld --> pid
  pld --> wca
  pld --> rdr
  cs --> rdr
  cs --> nt
  rdr --> cs
  rdr --> nis["/no-invalid-states"]
  rdr --> nt
  rdr --> vwc
  nis --> rdr
  cs --> nis
  nt["/never-twice"] --> rdr
  nt --> nis
  nt --> csm
  om --> vwc["/verify-with-controls"]
  vwc --> rdr
  csm["/craft-skills-and-memories"] --> nw["/natural-writing"]
  us["/unslop"]
  fd["/frontend-design"]
  dtf["/design-taste-frontend"]
  dd --> us
  csm --> nt
```

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

Or install everything as a Claude Code plugin:

```text
/plugin marketplace add Vivswan/skills
/plugin install vivswan-skills@vivswan-skills
/plugin install xeno@vivswan-skills
```

## Usage

Once installed, a skill fires on its own when its trigger matches the task.

Skills marked explicit-invocation-only ([`/natural-writing`](./skills/natural-writing/), [`/orchestrator-mode`](./skills/orchestrator-mode/), [`/frontend-design`](./xeno/frontend-design/), [`/design-taste-frontend`](./xeno/design-taste-frontend/)) load only when you invoke them. For the two xeno copies that holds in Claude Code; Codex reads the upstream policy, which lets the model invoke them.

**Examples:**

```bash
Rubber duck this patch before we merge it
```

```bash
Get a second opinion on this refactor
```

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

## Validation

The pre-commit hook runs the targeted checks on every commit; run them by hand with:

```bash
bun run check:staged
```

That runs the TypeScript typecheck, the Biome lint, structural validation ([the validate-skills action](./docs/validate-skills.md)), cross-file consistency checks ([`scripts/smoke-test.ts`](./scripts/smoke-test.ts)), and the unit tests a staged file reaches, by import or by name in the test's text.

CI runs the full `bun run check` (all of that plus the JSON schema lint and the whole test suite) through [`.github/workflows/checks.yml`](./.github/workflows/checks.yml), plus an end-to-end test that the real `npx skills` CLI discovers and groups every skill ([`scripts/cli-discovery-test.ts`](./scripts/cli-discovery-test.ts)).

## License

Individual and Small Organization License; the version and terms are in [LICENSE.md](./LICENSE.md).
