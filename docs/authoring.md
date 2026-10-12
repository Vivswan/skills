# Authoring Guide

This repository is built around a simple rule:

- every skill must work as a plain `SKILL.md`
- plugin manifests are optional enhancements
- MCP is optional and must never be the only path

## Repository Model

Use a shared skill core with agent-specific plugin layers:

```text
skills/<skill-name>/
  SKILL.md
  README.md
  .codex-plugin/plugin.json
  agents/openai.yaml     # required Codex sidecar: interface; policy when explicit-invocation-only
  .mcp.json              # optional
  references/            # optional
  scripts/               # optional
  package.json           # optional, with bun.lock: the scripts' dependencies (Dependencies, below)
  bun.lock
  vale/                  # optional: Vale rules the skill ships (docs/vale.md)
```

This keeps the repo compatible with:

- Claude Code through `npx skills add ...` and optional marketplace/plugin metadata
- Codex through `npx skills add ...` and optional `.codex-plugin/plugin.json`
- GitHub Copilot through the installed skill content itself

## Adding a New Skill

1. Copy the starter files from [`template/`](../template).
2. Create `skills/<skill-name>/`.
3. Rename placeholders so the skill name, folder name, and plugin manifest name match.
4. Fill in `SKILL.md` with activation criteria, workflow steps, and fallback behavior. Keep the frontmatter `description` a short trigger ("Use when ..."), and lead with worked examples, scenarios, or concrete commands rather than abstract prose.
5. Create `agents/openai.yaml` with an `interface` block mirroring the codex manifest (required; add `policy.allow_implicit_invocation: false` for explicit-invocation-only skills).
6. Add a human-facing `README.md`.
7. Update the root [`README.md`](../README.md) catalog: the Available Skills entry under the matching invocation heading, linking to the skill's `SKILL.md`, and a node in the mermaid skill-reference graph with a `click` line to that page and edges only for hand-offs the skill's text actually makes.
8. List the new skill in [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json).
9. Add the skill to the `skill` dropdown in [`.github/ISSUE_TEMPLATE/bug_report.yml`](../.github/ISSUE_TEMPLATE/bug_report.yml).
10. Ship a byte-identical copy of the root `LICENSE.md` in the skill folder, set frontmatter `metadata.author` to the plugin author's first name, and never set `metadata.internal` or add a `metadata.json` (the install CLI drops both silently).
11. Explicit-invocation-only skills set `disable-model-invocation: true` in the frontmatter AND `policy.allow_implicit_invocation: false` in `agents/openai.yaml`; the README entry then goes under "Invoked by you", otherwise under "Automatic".
12. Commit; the pre-commit hook's `bun run check:staged` runs the validator and smoke test, which enforce every item above plus frontmatter limits (`name` <= 64 characters, `description` <= 1024), the codex manifest's `homepage` and `keywords`, and `interface.short_description` at 25 to 64 characters. It also runs the docs probe: paragraphs and list items in first-party `SKILL.md` and `references/*.md` files and the template are capped at 70 words.

## Xeno Skills

A skill written elsewhere ships from this catalog as a vendored copy under `xeno/<name>/`, pinned to an upstream commit in `xeno/sources.yaml` and rewritten only by `bun run sync-xeno`. The layout above does not apply to a copy; [`xeno/README.md`](../xeno/README.md) has the steps to add one and the nightly refresh.

## Contributing Criteria to Reviews

A skill contributes to `/rubber-duck-review` second-opinion passes by declaring a `## Review Criteria` section in its `SKILL.md`. That alone joins it to every review of the user's own change; there is no registry to update. On someone else's PR, the `/reply-and-review-discipline` skill's lens choice selects which sections are expanded.

Keep the section short: a few bullets the reviewer can act on, plus a pointer to the skill's own workflow for triaging findings. The smoke test rejects a section without list items.

Criteria that only apply in a specific context use a differently named heading (e.g. `## Orchestration Review Criteria`) and are folded into reviews by the skill that owns that context instead of being auto-discovered.

## Dependencies

A skill whose scripts import a package ships `package.json` (exact versions) and `bun.lock` at the skill root; a skill with no dependencies ships neither. The root `package.json` pins the same version as a devDependency, so `tsc` checks the code that runs. Generate the lock with `bun install --lockfile-only --cwd skills/<name>`; never commit a `node_modules`.

```text
skills/my-skill/
  package.json           { "name": "my-skill-dependencies", "private": true, "dependencies": { "yaml": "2.9.1" } }
  bun.lock
  scripts/x.mts
```

Each entry script starts with the bootstrap below. It installs the lock once into `${XDG_CACHE_HOME:-~/.cache}/skills-deps/<skill>-<first 12 hex of sha256(package.json + bun.lock)>/`, so a user's project never gains a `node_modules`; a changed pin or lock means a new directory, and old ones can be deleted. `bun install --frozen-lockfile` refusing a lock that disagrees with `package.json` is the intended failure: exit 2, with the command to run.

```ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "..");
const SKILL = basename(SKILL_DIR);
if (!existsSync(join(SKILL_DIR, "package.json")) || !existsSync(join(SKILL_DIR, "bun.lock"))) {
  console.error(`${SKILL} scripts need the skill's package.json and bun.lock beside scripts/`);
  process.exit(2);
}
const DEPS_HASH = createHash("sha256")
  .update(readFileSync(join(SKILL_DIR, "package.json")))
  .update(readFileSync(join(SKILL_DIR, "bun.lock")))
  .digest("hex")
  .slice(0, 12);
const DEPS_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "skills-deps", `${SKILL}-${DEPS_HASH}`);
if (!existsSync(join(DEPS_DIR, "node_modules"))) {
  mkdirSync(DEPS_DIR, { recursive: true });
  for (const file of ["package.json", "bun.lock"]) copyFileSync(join(SKILL_DIR, file), join(DEPS_DIR, file));
  const install = spawnSync("bun", ["install", "--frozen-lockfile", "--cwd", DEPS_DIR], { encoding: "utf8" });
  if (install.status !== 0) {
    process.stderr.write(install.stderr ?? "");
    console.error(`${SKILL} dependencies did not install; run: bun install --frozen-lockfile --cwd ${DEPS_DIR}`);
    process.exit(2);
  }
}
// Bun.resolveSync falls through to auto-install when DEPS_DIR holds no node_modules, so check the directory first.
if (!existsSync(join(DEPS_DIR, "node_modules", "yaml"))) {
  console.error(`${SKILL} scripts need yaml: bun install --frozen-lockfile --cwd ${DEPS_DIR}`);
  process.exit(2);
}
const yaml: typeof import("yaml") = await import(Bun.resolveSync("yaml", DEPS_DIR));
```

Why not a plain pin: bun's auto-install ignores a `package.json` version, and an inline `pkg@1.2.3` specifier fails once a second version of that package was ever fetched on the machine. The smoke test holds the layout and import rules above, a static import of a dependency included; the bootstrap itself is the author's to copy.

## Compatibility Rules

- `npx skills add Vivswan/skills` is the primary install path.
- A skill must remain useful even if no plugin host is available.
- `SKILL.md` should contain the real workflow, with pointers to MCP tools only as a supplement.
- Plugin manifests should improve discovery and UX, not hold the only business logic.
- GitHub Copilot should be treated as skill-first, not plugin-first.

## MCP Conventions

When a skill needs MCP:

- Keep the MCP config in the skill folder as `.mcp.json`.
- Add a `.mcp.json.example` first when the real config needs secrets or environment-specific commands.
- Describe required environment variables in the skill `README.md`.
- Add a "Fallback Without MCP" section in `SKILL.md`.
- Never require MCP to understand the skill's primary task.

Recommended pattern:

```text
skills/my-skill/
  SKILL.md
  README.md
  .codex-plugin/plugin.json
  .mcp.json.example
  references/
```

## Validation Checklist

- `SKILL.md` has valid frontmatter with `name` and `description`
- folder name matches the public skill name
- `README.md` exists for each public skill
- `.codex-plugin/plugin.json` exists and parses as JSON
- `agents/openai.yaml` exists and its interface mirrors the codex manifest
- `.claude-plugin/plugin.json` lists the skill directory, and `.claude-plugin/marketplace.json` stays consistent with it
- the catalog version lives only in `.claude-plugin/marketplace.json` (`metadata.version`); no `version` in any `SKILL.md`, `.codex-plugin/plugin.json`, or `.claude-plugin/plugin.json`
- optional MCP files parse as JSON when present
- a skill with dependencies pins exact versions in `package.json`, commits `bun.lock`, matches the root devDependency, and loads them through the bootstrap

## Template Notes

The files in [`template/`](../template) are intentionally marked internal or placeholder-only. They are for authors, not for public installation.
