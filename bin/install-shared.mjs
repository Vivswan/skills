// What the two install commands share: the catalog (this repository's coordinate, the marketplace's upstream
// skills), the flags every `skills add` call carries and the agents it names, the explicit-invocation-only mark for an upstream's fresh
// copies, one call run with its output kept, and the summary of the failed calls. bin/install.mjs and
// scripts/link-agents.mts both import it. Dependency-free node, since the bin runs before anything is installed.

import { spawn } from "node:child_process";
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
import { stripVTControlCharacters } from "node:util";

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
 * The values the flags give a repeatable option, in the skills CLI's grammar: each occurrence of one of `names`
 * takes every following argument up to the next flag or an empty argument.
 * @param {readonly string[]} flags
 * @param {readonly string[]} names
 * @returns {string[]}
 */
export function flagValues(flags, names) {
  const values = [];
  for (let i = 0; i < flags.length; i++) {
    if (!names.includes(flags[i])) continue;
    while (i + 1 < flags.length && flags[i + 1] !== "" && !flags[i + 1].startsWith("-")) {
      values.push(flags[++i]);
    }
  }
  return values;
}

const AGENT_FLAGS = ["-a", "--agent"];

/**
 * The flags every call carries: the caller's, then `-y` unless they say yes (the CLI otherwise asks before
 * overwriting an installed copy), then `-a universal` unless `--all`, `-a '*'`, or a named `universal` covers
 * it. `universal` is the one `~/.agents/skills` directory, the canonical copy every other agent's symlink points
 * at; without it the CLI under `-y` installs to every agent it detects plus the twenty-odd that read it.
 * @param {readonly string[]} flags
 * @returns {string[]}
 */
export function callFlags(flags) {
  const yes = flags.some((flag) => flag === "-y" || flag === "--yes" || flag === "--all");
  const agents = flagValues(flags, AGENT_FLAGS);
  const covered = flags.includes("--all") || agents.includes("universal") || agents.includes("*");
  return [...flags, ...(yes ? [] : ["-y"]), ...(covered ? [] : ["-a", "universal"])];
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

/**
 * @typedef {object} CallResult
 * @property {number | null} status the exit status, null when a signal ended the call
 * @property {string | null} signal the signal that ended the call, else null
 * @property {Error} [error] the error that kept the call from running at all
 * @property {string} stdout what the call printed on stdout
 * @property {string} stderr what the call printed on stderr
 */

/**
 * Run one `skills add` call, its output streamed through as it comes and kept for the run's summary. The
 * child's streams are pipes, so the environment hands it what a terminal would have: color (`FORCE_COLOR`,
 * when this process writes to a terminal and the user set neither `FORCE_COLOR` nor `NO_COLOR`), and no npm
 * update notice (`npm_config_update_notifier`, five stderr lines after any command that say nothing about it).
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<CallResult>}
 */
export function runCall(file, args, options = {}) {
  const env = { ...process.env, npm_config_update_notifier: "false" };
  if (process.stdout.isTTY && !("FORCE_COLOR" in env) && !("NO_COLOR" in env))
    env.FORCE_COLOR = "1";
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, env, stdio: ["inherit", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      err.push(chunk);
    });
    const text = (chunks) => Buffer.concat(chunks).toString("utf8");
    child.on("error", (error) =>
      resolve({ status: null, signal: null, error, stdout: text(out), stderr: text(err) }),
    );
    child.on("close", (status, signal) =>
      resolve({ status, signal, stdout: text(out), stderr: text(err) }),
    );
  });
}

/** The non-blank lines of a stream, terminal escapes stripped. */
function spokenLines(text) {
  return stripVTControlCharacters(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

/**
 * The lines a summary quotes for a failed call: the CLI's stderr (a skipped SKILL.md and why), then its closing
 * stdout line (`No valid skills found`, `Failed to install from`). Earlier stdout lines are progress, and npm's
 * notice and warning lines (`npm warn exec ... will be installed` on a cold cache) are about npx, not the call.
 * An `npm error` line stays: then npx itself is what failed.
 * @param {CallResult} result
 * @returns {string[]}
 */
export function callDiagnostics(result) {
  const said = spokenLines(result.stderr ?? "").filter(
    (line) => !/^npm (notice|warn)( |$)/.test(line),
  );
  const closing = spokenLines(result.stdout ?? "").at(-1);
  return [...said, ...(closing === undefined ? [] : [closing])];
}

/**
 * The summary of a run's failed calls as one block: how many of the run's calls failed, then per call its target,
 * how it ended, and the lines it said, indented under it.
 * @param {readonly { target: string, result: CallResult }[]} failures
 * @param {number} total how many calls the run made
 * @returns {string}
 */
export function failureSummary(failures, total) {
  const block = [`${failures.length} of ${total} skills add calls failed`];
  for (const { target, result } of failures) {
    const ended = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
    block.push(`  ${target}: ${ended}`, ...callDiagnostics(result).map((line) => `    ${line}`));
  }
  return block.join("\n");
}
