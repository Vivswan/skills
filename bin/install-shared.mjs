// What the two install commands share: the catalog as they read it (this repository's coordinate from the plugin
// manifest, the upstream skills from the marketplace, each a git-subdir entry whose fetched folder is the skill
// itself), the flags every `skills add` call carries, and the explicit-invocation-only mark an upstream copy gets
// after install. bin/install.mjs (the consumer's `npx -y github:Vivswan/skills`) and scripts/link-agents.mts
// (`bun run add`) both import it, so one edit here changes both. Dependency-free node, since the bin runs before
// anything is installed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = new URL("../.claude-plugin/plugin.json", import.meta.url);
const MARKETPLACE = new URL("../.claude-plugin/marketplace.json", import.meta.url);

/** A catalog file that does not read, parse, or hold what the commands need; the message names the file. */
export class CatalogError extends Error {}

/**
 * @typedef {object} UpstreamSkill
 * @property {string} name the marketplace entry's name, which is the skill's install name, lowercased as the
 *   skills CLI compares names
 * @property {string} target the `skills add` target, `<owner/repo>/<path>`
 * @property {boolean} explicitOnly the entry's `metadata["disable-model-invocation"]`: after install the copy is
 *   marked to load only when the user invokes it
 */

/** The JSON object in one catalog file. */
function loadObject(url) {
  const path = fileURLToPath(url);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CatalogError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CatalogError(`${path}: the root must be an object`);
  }
  return data;
}

/**
 * The flags with `-y` appended unless they already say yes (`-y`, `--yes`, `--all`): the skills CLI otherwise
 * asks "Proceed with installation?" before it overwrites an installed copy, and both commands run unattended.
 * @param {readonly string[]} flags
 * @returns {string[]}
 */
export function withYes(flags) {
  const yes = flags.some((flag) => flag === "-y" || flag === "--yes" || flag === "--all");
  return yes ? [...flags] : [...flags, "-y"];
}

/** This catalog as GitHub owner/repo, read from the plugin manifest's repository URL. */
export function repoCoordinate() {
  const path = fileURLToPath(MANIFEST);
  const { repository } = loadObject(MANIFEST);
  if (typeof repository !== "string")
    throw new CatalogError(`${path}: repository must be a URL string`);
  if (!URL.canParse(repository)) {
    throw new CatalogError(`${path}: repository is not a URL: ${repository}`);
  }
  return new URL(repository).pathname.replace(/^\/|\.git$/g, "");
}

/**
 * The upstream skills, in marketplace order.
 * @returns {UpstreamSkill[]}
 */
export function upstreamSkills() {
  const path = fileURLToPath(MARKETPLACE);
  const { plugins } = loadObject(MARKETPLACE);
  if (!Array.isArray(plugins)) throw new CatalogError(`${path}: plugins must be an array`);
  return plugins
    .filter((plugin) => plugin.source?.source === "git-subdir")
    .map(({ name, source, metadata }) => {
      if (typeof source.url !== "string" || typeof source.path !== "string") {
        throw new CatalogError(
          `${path}: plugin '${name}' git-subdir source needs url and path strings`,
        );
      }
      const explicitOnly = metadata?.["disable-model-invocation"] === true;
      return {
        name: String(name).toLowerCase(),
        target: `${source.url}/${source.path}`,
        explicitOnly,
      };
    });
}

/**
 * Where the skills CLI keeps the canonical copy of a skill for these flags: under the home directory with `-g` or
 * `--global`, else under the current directory (the CLI's default once `-y` skips its scope prompt).
 * @param {readonly string[]} flags
 * @returns {string}
 */
export function installedSkillsDir(flags) {
  const global = flags.includes("-g") || flags.includes("--global");
  return join(global ? homedir() : process.cwd(), ".agents", "skills");
}

const EXPLICIT_KEY = "disable-model-invocation";
const POLICY_LINE = "  allow_implicit_invocation: false";

/** The lines of a text, line endings dropped; a trailing newline adds no empty last line. */
function linesOf(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The SKILL.md text with `disable-model-invocation: true` in its frontmatter: the block between an opening `---`
 * line and the next line that is `---` alone (a trailing newline or none), a block added when the file has none.
 */
function withExplicitFrontmatter(text) {
  const lines = linesOf(text);
  const isFence = (line) => line.trim() === "---";
  const close = isFence(lines[0] ?? "") ? lines.findIndex((line, i) => i > 0 && isFence(line)) : -1;
  if (close === -1) return `---\n${EXPLICIT_KEY}: true\n---\n${text}`;
  const block = lines.slice(1, close).filter((line) => !line.startsWith(`${EXPLICIT_KEY}:`));
  return [...["---", ...block, `${EXPLICIT_KEY}: true`, "---"], ...lines.slice(close + 1), ""].join(
    "\n",
  );
}

/**
 * The agents/openai.yaml text with `policy.allow_implicit_invocation: false`: the line replaced inside the
 * top-level `policy:` block (its indented lines), inserted when the block has none, the block put first when
 * the file has none. Everything else stays as it was.
 */
function withExplicitPolicy(yaml) {
  const lines = linesOf(yaml);
  const start = lines.findIndex((line) => /^policy:\s*$/.test(line));
  if (start === -1) return `policy:\n${POLICY_LINE}\n${yaml === "" ? "" : `\n${yaml}`}`;
  let end = start + 1;
  while (end < lines.length && /^(\s+\S|\s*$)/.test(lines[end] ?? "")) end++;
  const inBlock = lines.slice(start + 1, end);
  const at = inBlock.findIndex((line) => /^\s+allow_implicit_invocation:/.test(line));
  if (at === -1) lines.splice(start + 1, 0, POLICY_LINE);
  else lines[start + 1 + at] = POLICY_LINE;
  return `${lines.join("\n")}\n`;
}

/**
 * Mark an installed skill copy explicit-invocation-only: `disable-model-invocation: true` in SKILL.md's
 * frontmatter (what Claude Code reads) and `policy.allow_implicit_invocation: false` in agents/openai.yaml (what
 * Codex reads), the rest of both files kept. Idempotent. False when the directory holds no SKILL.md.
 * @param {string} dir
 * @returns {boolean}
 */
export function markExplicitOnly(dir) {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return false;
  writeFileSync(skillMd, withExplicitFrontmatter(readFileSync(skillMd, "utf8")));

  const yamlPath = join(dir, "agents", "openai.yaml");
  mkdirSync(dirname(yamlPath), { recursive: true });
  const yaml = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : "";
  writeFileSync(yamlPath, withExplicitPolicy(yaml));
  return true;
}

/**
 * Mark every explicit-only upstream's installed copy under `skillsDir`.
 * @param {readonly UpstreamSkill[]} upstream
 * @param {string} skillsDir
 * @returns {{ marked: string[], missing: string[] }} the directories marked, and those with no copy to mark
 */
export function markExplicitOnlyUpstreams(upstream, skillsDir) {
  const marked = [];
  const missing = [];
  for (const { name, explicitOnly } of upstream) {
    if (!explicitOnly) continue;
    const dir = join(skillsDir, name);
    (markExplicitOnly(dir) ? marked : missing).push(dir);
  }
  return { marked, missing };
}
