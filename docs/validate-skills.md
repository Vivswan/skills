# The validate-skills action

`.github/actions/validate-skills` is this repository's validator for repositories that host agent skills. The fleet CI (Vivswan/repo-platform's `ci.yml`) calls it on every skills-hosting repository; this repository runs it on itself in `checks.yml`.

The layout it validates:

```text
skills/             # the skills directory (input skills-dir, default `skills`)
  README.md         # index of the hosted skills; required as soon as the directory exists
  my-skill/
    SKILL.md        # YAML frontmatter: name (= folder, kebab-case), description
    ...             # whatever else the skill carries
.claude-plugin/
  plugin.json       # the published catalog (input plugin-manifest); its `skills` array lists `./skills/my-skill`
  marketplace.json  # optional; checked for consistency with plugin.json when present
```

A skill folder is unpublished until `plugin.json` lists it. Installers and discovery mode read the manifest, not the disk, so an unlisted folder validates green and never ships.

## Inputs

| Input | Meaning | Default |
|---|---|---|
| `skills-dir` | Directory holding the skills, relative to the repo root | `skills` |
| `plugin-manifest` | Path of the plugin manifest listing the published skills | `.claude-plugin/plugin.json` |
| `mode` | `structure` or `discovery` | `structure` |

Both paths must be plain relative paths inside the checkout: no absolute paths, no `.` or `..` segments.

## What each mode checks

An empty catalog (`"skills": []`) passes both modes: a freshly adopted repository publishes nothing yet.

| Mode | Network | What a red means |
|---|---|---|
| `structure` | offline | the catalog structure is broken; cheap, so it belongs in the merge gate |
| `discovery` | needs npm | the real `npx -y skills add . --list` does not list every skill in `plugin.json` |

Structure mode, in the order it reports:

- `plugin.json` parses and has a kebab-case `name`.
- Each path in its `skills` array is a real direct child of the skills directory with a `SKILL.md`.
- The skills directory is a real directory or absent. Anything else at the path is an error.
- The skills directory carries an index `README.md` at its root.
- Every folder under the skills directory, listed or not, has a `SKILL.md` with frontmatter.
- Its `name` equals the folder and is kebab-case, 64 characters max.
- Its `description` is nonempty, 1024 characters max.
- A `.mcp.json` in a skill folder, when present, parses as JSON.
- `marketplace.json`, when present next to the manifest, has a kebab-case `name` and a non-empty `plugins` list.
- Each marketplace plugin's `source` stays inside the repository.
- A marketplace plugin's `skills` (one path or a list) resolve under its `source` and must stay inside it, each a kebab-case folder with a `SKILL.md`; the root plugin (`source: "./"`) keeps the repository's skills directory rule.
- A plugin publishing the repository root carries the same `name` as `plugin.json`.
- Symlinks are rejected anywhere on a validated path, ancestors included. A link can point outside the checkout, so what ships would not be what was validated.
- The one exception: a marketplace plugin's `source` may pass through in-repo links while its physical path stays inside the repository.

Discovery mode downloads the CLI from the npm registry, makes up to three attempts, and matches each published skill name on word boundaries in the listing. Give it its own job outside the merge gate so a registry hiccup cannot block merges.

Exit codes:

| Exit | Meaning |
|---|---|
| `0` | clean |
| `1` | one `error:` line per finding, then a count |
| `2` | unknown mode |

The full rule set is the source, [validate_skills.ts](../.github/actions/validate-skills/validate_skills.ts). Its tests are [tests/validate-skills-action.test.ts](../tests/validate-skills-action.test.ts).

## How repo-platform calls it

The fleet CI pins the action to a commit on `main` (the comment records which main it took) and passes the repository's registered skills directory:

```yaml
- uses: Vivswan/skills/.github/actions/validate-skills@<sha> # main, <date>
  with:
    skills-dir: skills
    mode: structure
```

The action sets up its own bun from the `.bun-version` next to `action.yml`, so the caller needs no bun step and no install step.

## How this repository runs it on itself

- CI: the `validate-skills-action` job in `.github/workflows/checks.yml` runs the action on this checkout in `structure` mode, inside the all-green gate.
- Locally, from the repo root:

```sh
SKILLS_DIR=skills PLUGIN_MANIFEST=.claude-plugin/plugin.json MODE=structure bun .github/actions/validate-skills/validate_skills.ts
```

- Discovery, the same command with `MODE=discovery` (needs network).
- `bun run test` covers the action's unit tests along with the rest of the suite.

This repository's own richer checks (`bun run validate`, `bun run smoke`) stay in `scripts/`; the action is the fleet-wide baseline every skills repository shares.
