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
  package.json           # optional: the scripts' dependencies, exact versions (Dependencies, below)
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

A skill whose scripts import a package ships `package.json` at the skill root: exact versions under `dependencies`, nothing else. No lockfile, no `node_modules`, nothing generated is committed. A skill with no dependencies ships no `package.json`.

The root `package.json` pins the same version as a devDependency, so `tsc` checks the code that runs.

```text
skills/my-skill/
  package.json           { "name": "my-skill-dependencies", "private": true, "dependencies": { "yaml": "2.9.1" } }
  scripts/x.mts          the block, then await import() of its packages, then the program
  .build/x.js            the bundle, written on first run; .build/ is gitignored
```

The script bundles itself on first run. Run as source (`bun scripts/x.mts`), the block installs the pins into the skill folder, bundles the script and everything it imports into the `.build` folder with `bun build`, removes the install, and runs the bundle with the same arguments. Later runs go straight to the bundle until a file in `scripts/` or the `package.json` is newer.

An entry below `scripts/` bundles to the same relative path under the `.build` folder; the block finds the skill root by walking up to the `scripts/` directory with the `package.json` beside it.

`bun build` resolves installed packages only, which is why the install step exists. A failed install or build prints bun's error and exits 2. A user may install any one skill alone, so no script imports from another skill.

The block needs `spawnSync` from `node:child_process`, `existsSync`, `readdirSync`, `rmSync`, `statSync` from `node:fs`, and `basename`, `dirname`, `join`, `relative` from `node:path` among the script's imports. Every script that loads a package, directly or through a relative import, carries it byte for byte; the smoke test holds the copies to this text, and a dependency-free script carries none.

Below the guard, the program loads its packages and sibling scripts with `await import("yaml")`, never a static import: ESM hoists a static import above the guard, where the source path would resolve the package through bun's unpinned auto-install. Type-only imports stay static; they are erased. The smoke test refuses a hoisted import, and a load placed above the block.

```ts
// --- Self-build: run as source, bundle into <skill>/.build/ and run the bundle; run as the bundle, do nothing.
// docs/authoring.md > Dependencies owns this block; the smoke test keeps every copy identical.

function buildPaths(source: string) {
  // An entry may sit below scripts/: the skill root is the parent of the scripts/ with the manifest beside it.
  let scripts = dirname(source);
  while (basename(scripts) !== "scripts" || !existsSync(join(dirname(scripts), "package.json"))) {
    if (dirname(scripts) === scripts) {
      console.error(
        `${source}: no scripts/ directory with a package.json beside it above the script`,
      );
      process.exit(2);
    }
    scripts = dirname(scripts);
  }
  const skill = dirname(scripts);
  const built = join(skill, ".build", relative(scripts, source).replace(/\.mts$/, ".js"));
  return { scripts, skill, built };
}

function buildIsStale(scripts: string, skill: string, built: string): boolean {
  if (!existsSync(built)) return true;
  // An entry imports its siblings, and a pin bump changes the bundle, so every script and the manifest count.
  const inputs = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mts"))
    .map((name) => join(scripts, name));
  inputs.push(join(skill, "package.json"));
  const newest = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  return statSync(built).mtimeMs < newest;
}

function runBun(args: string[]): boolean {
  const step = spawnSync("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.status !== 0) process.stderr.write(step.stderr);
  return step.status === 0;
}

function build(source: string, skill: string, built: string): void {
  // bun build resolves installed packages only: install the pins for the build's duration, then remove them.
  const ok =
    runBun(["install", "--production", "--no-save", "--cwd", skill]) &&
    runBun(["build", source, "--target", "bun", "--outfile", built]);
  rmSync(join(skill, "node_modules"), { recursive: true, force: true });
  if (!ok) process.exit(2);
}

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built)) build(source, skill, built);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();
```

Why a bundle: bun's auto-install ignores a `package.json` pin, an inline `pkg@1.2.3` specifier fails once a second version of the package was ever fetched on the machine, and a `node_modules` in a user's project is theirs, not the skill's.

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
- a skill with dependencies pins exact versions in `package.json`, mirrored by the root devDependency, commits no lockfile or `node_modules`, and every script loading a package carries the ensureBuilt block

## Template Notes

The files in [`template/`](../template) are intentionally marked internal or placeholder-only. They are for authors, not for public installation.
