// The companion criteria a launch folds into the review: which installed skills declare `## Review Criteria`,
// which of those belong to this collection (the checkout's plugin manifest, else the installer's records), and
// the block that names their pages for the reviewer to read. run-review.mts parses the flag and the subcommand.

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function build(source: string, scripts: string, skill: string, built: string): boolean {
  // bun build resolves installed packages only, from a node_modules beside the entry, and two first runs at
  // once must never share one: each build gets its own scratch under .build/ and publishes by one rename.
  mkdirSync(join(skill, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(skill, ".build", "scratch-"));
  try {
    cpSync(scripts, join(scratch, "scripts"), { recursive: true });
    copyFileSync(join(skill, "package.json"), join(scratch, "package.json"));
    const entry = join(scratch, "scripts", relative(scripts, source));
    const bundle = join(scratch, "bundle.js");
    const ok =
      runBun(["install", "--production", "--no-save", "--cwd", scratch]) &&
      runBun(["build", entry, "--target", "bun", "--outfile", bundle]);
    if (!ok) return false;
    mkdirSync(dirname(built), { recursive: true });
    renameSync(bundle, built);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ensureBuilt(source: string): Promise<boolean> {
  if (!source.endsWith(".mts")) return Promise.resolve(false);
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  // The bundle runs on this process's stdio, and a signal to this process goes on to it; this process then ends as
  // the bundle did, by its status, or by the same signal once the forwarding is off and the signal's default is back.
  const run = spawn("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals) => {
    run.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  return new Promise((resolve) => {
    const settle = (status: number | null, signal: NodeJS.Signals | null) => {
      for (const name of signals) process.off(name, forward);
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = status ?? 1;
      resolve(true);
    };
    run.on("exit", settle);
    // A bundle that never started (no bun on PATH) emits error and no exit: that is the run's failure.
    run.on("error", (error) => {
      console.error(String(error));
      settle(1, null);
    });
  });
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && (await ensureBuilt(import.meta.path))) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const { isEnoent, isRecord } = await import("./verdict.mts");

const SKILL_DIR = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const SKILLS_ROOT = dirname(SKILL_DIR);
const PLUGIN_MANIFEST = join(dirname(SKILLS_ROOT), ".claude-plugin", "plugin.json");
const CRITERIA_HEADING = "Review Criteria";
const COMPANION_HEADING = "## Companion review criteria";
const COMPANION_INSTRUCTION =
  "Read the `## Review Criteria` section of each page below and apply it as part of this review:";

/** A page, a record, or a `--criteria` name this module refuses; run-review.mts reports it as its usage error. */
export class CriteriaError extends Error {}

function refuse(message: string): never {
  throw new CriteriaError(message);
}

export interface Criteria {
  /** The skill's directory name, as `--criteria` names it. */
  name: string;

  /** The page's real path, which the reviewer reads from any cwd, a snapshot copy included. */
  page: string;

  /** The skill came from the same source as this one, per the installer; only those ride in by default. */
  ours: boolean;

  /** The skill is user-invoke-only, so it is folded in only when `--criteria` names it. */
  userOnly: boolean;
}

/** A page's frontmatter (the YAML between its opening `---` lines, null without one) and the
 * Markdown body after it, whatever the line endings. A frontmatter that never closes is refused,
 * since read as a body its metadata would declare criteria and its invocation policy would be lost. */
function splitPage(page: string, pagePath: string): { frontmatter: string | null; body: string } {
  const lines = page.split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatter: null, body: lines.join("\n") };

  const end = lines.indexOf("---", 1);
  if (end === -1) refuse(`the frontmatter of ${pagePath} never closes`);

  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

/** Whether the page's frontmatter carries `disable-model-invocation: true`: automatic folding is a
 * model invocation, which such a skill forbids. Frontmatter that does not parse is refused,
 * since the silent reading would be an unwanted invocation. */
function userInvokeOnly(frontmatter: string | null, pagePath: string): boolean {
  if (frontmatter === null) return false;

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(frontmatter);
  } catch (error) {
    refuse(`cannot parse the frontmatter of ${pagePath}: ${String(error)}`);
  }
  return isRecord(parsed) && parsed["disable-model-invocation"] === true;
}

/** Whether the body declares the `## Review Criteria` heading at its root: rendered, with every
 * container dropped, so a quoted or listed example, a sample inside a code fence, a `## <Context>
 * Review Criteria`, trailing spaces, or CRLF endings read as a reader would. */
function declaresCriteria(body: string): boolean {
  // Only a heading emits the marker; a table cell, an HTML comment, or any other text never can.
  const marker = (text: string) => `\u0000${text}\u0000`;
  const rendered = Bun.markdown.render(body, {
    heading: (text, { level }) => (level === 2 ? marker(text) : ""),
    blockquote: () => "",
    list: () => "",
    listItem: () => "",
  });

  return rendered.includes(marker(CRITERIA_HEADING));
}

/** Where the skills CLI keeps its records (its dist/cli.mjs, getLocalLockPath and getSkillLockPath):
 * a project's skills-lock.json, looked for upward from the skills directory since each agent's
 * directory sits at its own depth under the project, and the one global .skill-lock.json, under
 * $XDG_STATE_HOME/skills when that is set and under ~/.agents otherwise. */
function lockfileCandidates(): { project: string[]; global: string } {
  const project: string[] = [];
  for (let dir = dirname(SKILLS_ROOT); ; dir = dirname(dir)) {
    project.push(join(dir, "skills-lock.json"));
    if (dirname(dir) === dir) break;
  }

  const stateHome = process.env.XDG_STATE_HOME;
  const global = stateHome
    ? join(stateHome, "skills", ".skill-lock.json")
    : join(homedir(), ".agents", ".skill-lock.json");
  return { project, global };
}

/** A lockfile source as the installer may spell it twice: a trailing slash or .git, a case difference. */
function sourceId(source: string): string {
  return source
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** A recorded source, comparable: a local path resolved against its lockfile and through the file
 * system (a project lockfile spells it relative, a spelling may differ in case or pass a link, and a
 * .git suffix there is part of the directory's name); a repository id as the installer may spell it twice. */
function comparableSource(entry: unknown, file: string): string | null {
  if (!isRecord(entry) || typeof entry.source !== "string") return null;

  if (entry.sourceType !== "local") return sourceId(entry.source);

  const path = resolve(dirname(file), entry.source);
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Each skill's comparable source in one lockfile. A file that does not parse is refused,
 * never a guess at the collection. */
function lockedSources(file: string, raw: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    refuse(`cannot parse ${file}: ${String(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.skills)) {
    refuse(`${file}: expected a "skills" object; the lockfile format has changed`);
  }

  const sources = new Map<string, string>();
  for (const [name, entry] of Object.entries(parsed.skills)) {
    const source = comparableSource(entry, file);
    if (source !== null) sources.set(name, source);
  }
  return sources;
}

/** Every record with an entry for this skill, as each skill's comparable source. No record says
 * where it installed to, so none can be matched to this root by path; every one that names this
 * skill speaks for it, and inclusion is the safer error. */
function installerRecords(): Map<string, string>[] {
  const { project, global } = lockfileCandidates();
  const records: Map<string, string>[] = [];
  for (const file of [...project, global]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch (error) {
      if (isEnoent(error)) continue;
      refuse(`cannot read ${file}: ${String(error)}`);
    }

    const sources = lockedSources(file, raw);
    if (sources.has(basename(SKILL_DIR))) records.push(sources);
  }
  return records;
}

/** The skills the plugin manifest beside the root lists, when its list names this skill at this
 * root: a checkout of the repository, which the installer's records say nothing about. Null for
 * another plugin's manifest or none. */
function checkoutCollection(): Set<string> | null {
  let raw: string;
  try {
    raw = readFileSync(PLUGIN_MANIFEST, "utf-8");
  } catch (error) {
    if (isEnoent(error)) return null;
    refuse(`cannot read ${PLUGIN_MANIFEST}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) return null;

  const listed = parsed.skills.filter((entry): entry is string => typeof entry === "string");
  if (!listed.some((entry) => resolve(dirname(SKILLS_ROOT), entry) === SKILL_DIR)) return null;
  return new Set(listed.map((entry) => basename(entry)));
}

/** The collection: the repository checkout's own list, else every name the installer recorded
 * under this skill's source in any record naming it, else "none", said on stderr so an empty list
 * is never silent. */
function collectionNames(): Set<string> | "none" {
  const checkout = checkoutCollection();
  if (checkout !== null) return checkout;

  const records = installerRecords();
  if (records.length === 0) {
    process.stderr.write(
      `no companion criteria: no skills-lock.json from ${dirname(SKILLS_ROOT)} upward names ${basename(SKILL_DIR)}, nor ${lockfileCandidates().global}\n`,
    );
    return "none";
  }

  const names = new Set<string>();
  for (const sources of records) {
    const own = sources.get(basename(SKILL_DIR));
    for (const [name, source] of sources) {
      if (source === own) names.add(name);
    }
  }
  return names;
}

/** An entry with no SKILL.md (a file, a dangling link, a stray directory) is no skill; any other
 * failure to read one is a broken install, since a skill silently dropped is a rule silently dropped. */
function installedCriteria(): Criteria[] {
  const collection = collectionNames();
  const found: Criteria[] = [];
  for (const name of readdirSync(SKILLS_ROOT).sort()) {
    const pagePath = join(SKILLS_ROOT, name, "SKILL.md");
    let page: string;
    try {
      page = readFileSync(pagePath, "utf-8");
    } catch (error) {
      if (isEnoent(error) || (isRecord(error) && error.code === "ENOTDIR")) continue;
      refuse(`cannot read ${pagePath}: ${String(error)}`);
    }
    const { frontmatter, body } = splitPage(page, pagePath);
    if (!declaresCriteria(body)) continue;

    const ours = collection !== "none" && collection.has(name);
    found.push({
      name,
      page: realpathSync(pagePath),
      ours,
      userOnly: userInvokeOnly(frontmatter, pagePath),
    });
  }
  return found;
}

/** The criteria a launch appends: this collection's declaring skills that allow model invocation
 * by default, the named ones (any declaring skill, user-only included) under `--criteria a,b`,
 * none under `--criteria none`. A name that declares none is refused. */
export function selectCriteria(spec: string | null): Criteria[] {
  // Opting out reads no record and no page, so a broken install cannot stop a review that asked for none.
  if (spec === "none") return [];

  const installed = installedCriteria();
  if (spec === null) return installed.filter((criteria) => criteria.ours && !criteria.userOnly);

  const chosen = spec.split(",");
  const declaring = installed.map((criteria) => criteria.name);
  const unknown = chosen.filter((name) => !declaring.includes(name));
  if (unknown.length > 0) {
    refuse(
      `--criteria: ${unknown.join(", ")} declares no ## ${CRITERIA_HEADING}; the installed skills that do: ${declaring.join(", ")}`,
    );
  }
  return installed.filter((criteria) => chosen.includes(criteria.name));
}

/** The block a launch appends to the prompt: the pages to read, never their text, so the prompt
 * stays short and the reviewer reads each skill's own words. Empty under `--criteria none`. */
export function companionBlock(criteria: Criteria[]): string {
  if (criteria.length === 0) return "";

  const pages = criteria.map(({ name, page }) => `- ${name}: ${page}`);
  return `${COMPANION_HEADING}\n${COMPANION_INSTRUCTION}\n${pages.join("\n")}\n`;
}

export function withCriteria(prompt: string, criteria: Criteria[]): string {
  const block = companionBlock(criteria);
  if (block === "") return prompt;

  return `${prompt.trimEnd()}\n\n${block}`;
}
