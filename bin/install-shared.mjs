// What the two install commands share: the catalog as they read it (this repository's coordinate from the plugin
// manifest, the upstream skills from the marketplace, each a git-subdir entry whose fetched folder is the skill
// itself), the flags every `skills add` call carries, and the explicit-invocation-only mark the copies an upstream
// `skills add` wrote get right after it. bin/install.mjs (the consumer's `npx -y github:Vivswan/skills`) and scripts/link-agents.mts
// (`bun run add`) both import it, so one edit here changes both. Dependency-free node, since the bin runs before
// anything is installed.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
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

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The per-agent skills directories beside the canonical one: every `.<agent>/skills` directory under `base`
 * (the home directory for a global install, the project for a local one) that is not the canonical directory
 * or anything inside it, compared by real path, so a symlink into the canonical tree is not swept as an agent's.
 * The CLI fills each with symlinks at the canonical copies, except under `--copy`, where each entry is its own
 * copy.
 * @param {string} base
 * @param {string} canonical
 * @returns {string[]}
 */
export function agentSkillDirs(base, canonical) {
  const canonicalReal = realpathOrNull(canonical) ?? canonical;
  const insideCanonical = (path) => path === canonicalReal || path.startsWith(canonicalReal + sep);
  const dirs = [];
  for (const name of readdirSync(base).sort()) {
    if (!name.startsWith(".")) continue;
    const candidate = join(base, name, "skills");
    let isDirectory = false;
    try {
      isDirectory = statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    if (insideCanonical(candidate) || insideCanonical(realpathOrNull(candidate) ?? candidate))
      continue;
    dirs.push(candidate);
  }
  return dirs;
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

/** The mtime of a copy's SKILL.md, null where there is none. */
function skillMdMtime(dir) {
  return statSync(join(dir, "SKILL.md"), { throwIfNoEntry: false })?.mtimeMs ?? null;
}

/** The copies an install of `name` may write as they stand now: the canonical one, then one per per-agent directory. */
function copyPaths(name, skillsDir, base) {
  return [join(skillsDir, name), ...agentSkillDirs(base, skillsDir).map((dir) => join(dir, name))];
}

/**
 * The copies an install of `name` may write, by SKILL.md mtime before the call (null where absent), so the
 * call's own writes can be told from copies that were already there. A per-agent directory the call itself
 * creates is not here yet; `markWrittenCopies` discovers it afterwards and treats its copy as new.
 * @param {string} name
 * @param {string} skillsDir the canonical skills directory
 * @param {string} base the directory holding the `.agents` and per-agent dot directories: HOME or the project
 * @returns {{ name: string, skillsDir: string, base: string, mtimes: Map<string, number | null> }}
 */
export function copiesBefore(name, skillsDir, base) {
  const mtimes = new Map(
    copyPaths(name, skillsDir, base).map((path) => [path, skillMdMtime(path)]),
  );
  return { name, skillsDir, base, mtimes };
}

/**
 * Mark the copies the call just wrote: a real directory whose SKILL.md appeared or changed since `before`. A
 * canonical entry that is a symlink is someone else's wiring: a notice and no write through it. A per-agent
 * symlink is the canonical copy seen again and is skipped. When nothing was marked, one notice names the
 * canonical path, since a `--copy` install writes the per-agent copies instead.
 * @param {ReturnType<typeof copiesBefore>} before
 * @returns {{ marked: string[], notices: string[] }}
 */
export function markWrittenCopies(before) {
  const { name, skillsDir, base, mtimes } = before;
  const canonical = join(skillsDir, name);
  const marked = [];
  const notices = [];
  for (const path of copyPaths(name, skillsDir, base)) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      if (path === canonical) notices.push(`${path} is a symlink, left alone`);
      continue;
    }
    const now = skillMdMtime(path);
    if (!entry?.isDirectory() || now === null || now === (mtimes.get(path) ?? null)) continue;
    if (markExplicitOnly(path)) marked.push(path);
  }
  if (marked.length === 0 && notices.length === 0) {
    notices.push(`no fresh copy at ${canonical} to mark explicit-invocation-only`);
  }
  return { marked, notices };
}
