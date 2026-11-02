#!/usr/bin/env bun
/**
 * Launch a read-only cross-model reviewer and print its verdict as one JSON report.
 * Each reviewer CLI has a trap the launch retires; the usage text is USAGE below.
 *
 *   prompt through a shell       -> backticks and $(...) expand: spawn from an argv array
 *   stdin left open              -> a CLI reviewer blocks forever: 'ignore' for copilot, the protocol for an adapter
 *   a reviewer narrates first    -> an empty verdict reads as clean: a tool call must precede it
 *   a reviewer asks to write     -> the review refuses, the adapter ends the turn: the refusal is the failure's reason
 *   predictable prompt path      -> one agent overwrites another's: prepare mints a private dir
 *   shared tmp dir               -> captures pile up: rubber-duck-* dirs older than 24 h are purged
 *   bwrap denied in a container  -> codex's sandbox cannot start: review an unsandboxed snapshot copy
 *   cp -a of the checkout        -> venvs and nested worktrees weigh gigabytes: snapshot HEAD, the refs, the index
 *   codex reconnects mid-stream  -> an error event precedes the verdict: only a verdict-less capture fails
 *   the stream goes silent       -> a stuck child held one run for hours: --stall kills the reviewer's process group
 *   criteria pasted by hand      -> thirty rounds passed what the house rules forbid: the launcher names this collection's pages
 *   the bundle runs from .build/ -> paths off import.meta would miss scripts/: the skill root is two levels up either way
 */

import { spawn, spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AcpEnd, PermissionPolicy } from "./acp.mts";
import { removeTree, snapshotRepository, withoutGitEnv } from "./copy-mode.mts";
import type { Extraction, Tool } from "./verdict.mts";

const USAGE = [
  "usage: run-review.mts <codex|claude|copilot> <prompt-file> [--background] [--stall <seconds>] [--criteria <names>|none]",
  "codex runs through the codex-acp adapter on PATH (npm install -g @agentclientprotocol/codex-acp) in its read-only mode: a file edit it asks for is refused, codex ends the turn, and the review fails naming the refusal",
  "claude runs through the claude-agent-acp adapter on PATH (npm install -g @agentclientprotocol/claude-agent-acp) in its plan mode: its read-only tools run unasked, and whatever asks (a write, a plan approval) is refused",
  "       run-review.mts <codex|claude|copilot> --extract <output-file>",
  "       run-review.mts <codex|claude|copilot> --extract --wait <output-file> [--timeout <seconds>]  (polls every 2 s; default timeout 3600)",
  "       run-review.mts <codex|claude|copilot> <prompt-file> --capture <dir> [--stall <seconds>] [--criteria <names>|none]  (internal)",
  "       run-review.mts prepare <section>",
  "       run-review.mts criteria [--criteria <names>|none]  (prints the block a launch appends, for a review run through a dedicated tool)",
  "the prompt gets a '## Companion review criteria' section naming the SKILL.md of every installed skill of this collection (the installer's",
  "  records say which: every skills-lock.json above the skills directory and the global .skill-lock.json; a checkout of the repository counts what its plugin manifest lists) that declares '## Review Criteria',",
  "  except a skill whose frontmatter says disable-model-invocation: true, which rides in only when named;",
  "  --criteria <name>[,<name>] names skills (any installed one that declares the heading), --criteria none appends nothing; the report's criteria lists the names",
  "scratch (rubber-duck-*) lives under the OS tmp dir for 24 hours; prepare and a launch purge older ones",
  "codex whose bubblewrap sandbox cannot start reviews a snapshot copy of the repository inside its scratch dir, where the commands it asks to run are allowed; under a working sandbox only reads and searches are",
  "a reviewer silent for --stall seconds (default 900) is killed with its process group and the review fails as stalled: no stream event for <n> s",
  "prints: the JSON report (verdict, tool_calls, capture, trajectory, and sandbox only when codex fell back to copy mode); --background prints output-file: <path> and pid: <n>",
  "exits: 0 verdict printed, or a --background launch started (its verdict comes via --extract);",
  "       1 review FAILED - relaunch: no usable verdict, whatever the cause, a stall, or --wait timed out; never a clean pass;",
  "       2 usage error, the reviewer binary not installed, or codex's sandbox unavailable outside a git repository",
].join("\n");

if (import.meta.main && (process.argv[2] === "--help" || process.argv[2] === "-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

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

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const { startAcpSession } = await import("./acp.mts");
const { extractVerdict, isRecord, isTool } = await import("./verdict.mts");

const SKILL_DIR = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const SKILLS_ROOT = dirname(SKILL_DIR);
const PLUGIN_MANIFEST = join(dirname(SKILLS_ROOT), ".claude-plugin", "plugin.json");
const CRITERIA_HEADING = "Review Criteria";
const COMPANION_HEADING = "## Companion review criteria";
const COMPANION_INSTRUCTION =
  "Read the `## Review Criteria` section of each page below and apply it as part of this review:";

/** copilot runs as a CLI; codex and claude run as ACP sessions (acp.mts) and have no argv: ACP_REVIEWERS names the
 * adapter on PATH that serves each and the session mode the review needs. */
type CliTool = Extract<Tool, "copilot">;
type AcpTool = Exclude<Tool, "copilot">;

const ACP_REVIEWERS: Record<AcpTool, { adapter: string; mode: string }> = {
  // read-only: commands ask before they run, a file edit asks, and a refusal ends the turn.
  codex: { adapter: "codex-acp", mode: "read-only" },
  // plan: the read-only tools run unasked, a write or a plan approval asks, and a refusal ends the turn.
  claude: { adapter: "claude-agent-acp", mode: "plan" },
};

const TOOL_ARGS: Record<CliTool, (prompt: string) => string[]> = {
  // -p consumes the next argument, so the prompt must immediately follow it.
  // -s strips the model/stats decoration so stdout is only the response.
  // --available-tools is a visibility allow-list: view/rg/glob are the read
  // tools; shell, write, MCP, web, and subagent tools are not even available.
  // The deny flags stay as belt-and-braces (deny outranks every allow).
  // copilot does not stream JSON, so its stdout is plain text.
  copilot: (prompt) => [
    "-p",
    prompt,
    "-s",
    "--available-tools=view,rg,glob",
    "--deny-tool=write",
    "--deny-tool=shell",
    "--disable-builtin-mcps",
  ],
};

const SCRATCH_PREFIX = "rubber-duck-";
const PROMPT_DIR_PREFIX = "rubber-duck-prompt-";
const SCRATCH_RETENTION_MS = 24 * 60 * 60 * 1000;
const WAIT_POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 3600;
const DEFAULT_STALL_SECONDS = 900;
const WHOLE_SECONDS = /^[1-9][0-9]*$/;
const MAX_TIMER_SECONDS = 2147483;
const FLAGS = {
  background: { type: "boolean" },
  capture: { type: "string" },
  stall: { type: "string" },
  criteria: { type: "string" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
} as const;

const LAUNCH_FLAGS = ["background", "capture", "stall", "criteria"] as const;
const EXTRACT_FLAGS = ["wait", "timeout"] as const;
const STALL_STATUS = /^stalled: /;
const MINT_MARKER = ".minted-by-run-review";
const SECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Thrown after exit output is queued, so `never`-typed helpers stay honest. */
class SilentExit extends Error {}

function usageError(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exitCode = 2;
  throw new SilentExit();
}

/** The tmp dir is shared with other sessions' live reviews, so age alone decides and a
 * symlink is never followed. A purge that fails is reported and must never fail the review. */
function purgeStaleScratch(): void {
  const cutoff = Date.now() - SCRATCH_RETENTION_MS;
  let entries: Dirent[];
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch (error) {
    process.stderr.write(`stale scratch purge skipped: ${String(error)}\n`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SCRATCH_PREFIX)) continue;
    const dir = join(tmpdir(), entry.name);
    try {
      if (lstatSync(dir).mtimeMs >= cutoff) continue;
    } catch (error) {
      process.stderr.write(`stale scratch purge skipped ${dir}: ${String(error)}\n`);
      continue;
    }
    removeTree(dir, (line) => process.stderr.write(`stale scratch purge skipped: ${line}\n`));
  }
}

/** Mint a private directory for one review's prompt files and print the
 * section's prompt file path inside it. mkdtemp is atomic, so two callers can
 * never receive the same directory. */
function preparePrompt(section: string): void {
  if (!SECTION_NAME.test(section)) {
    usageError(`prepare: section must match ${SECTION_NAME}, got ${JSON.stringify(section)}`);
  }
  purgeStaleScratch();
  const dir = mkdtempSync(join(tmpdir(), PROMPT_DIR_PREFIX));
  writeFileSync(join(dir, MINT_MARKER), "");
  process.stdout.write(`${join(dir, `${section}.md`)}\n`);
}

/** A launch accepts only a regular, singly-linked file directly inside a
 * prepare-minted directory (prefix plus marker, and not itself a symlink), so
 * a predictable shared path cannot come back, and no symlink or hard link can
 * alias the launch onto a shared file elsewhere. */
function requireMintedPrompt(promptFile: string): void {
  const dir = dirname(promptFile);
  const notMinted = (): never =>
    usageError(
      `prompt file must live in a directory minted by \`run-review.mts prepare <section>\`, got ${promptFile}`,
    );
  if (!basename(dir).startsWith(PROMPT_DIR_PREFIX) || !existsSync(join(dir, MINT_MARKER))) {
    notMinted();
  }
  let dirStat: ReturnType<typeof lstatSync>;
  let stat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(dir);
    stat = lstatSync(promptFile);
  } catch (error) {
    usageError(`cannot read prompt file ${promptFile}: ${String(error)}`);
  }
  if (dirStat.isSymbolicLink()) notMinted();
  if (!stat.isFile() || stat.nlink !== 1) {
    usageError(
      `prompt file must be a regular file with a single link in its minted directory, not a symlink or hard link: ${promptFile}`,
    );
  }
}

/** --capture is the monitor half of --background: it may consume only the
 * prompt snapshot inside a scratch dir whose launch record names this
 * reviewer. A caller cannot use it to launch an unminted prompt. */
function requireCaptureProvenance(tool: Tool, promptFile: string, captureDir: string): void {
  const scratch = scratchPaths(captureDir, tool);
  const refuse = (): never =>
    usageError(
      `--capture is internal to --background: ${captureDir} has no matching launch record`,
    );
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(scratch.statusFile, "utf-8"));
  } catch {
    refuse();
  }
  if (
    !isRecord(record) ||
    record.tool !== tool ||
    record.output !== basename(scratch.outFile) ||
    promptFile !== join(captureDir, "prompt.txt")
  ) {
    refuse();
  }
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

interface Criteria {
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
  if (end === -1) usageError(`the frontmatter of ${pagePath} never closes`);

  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

/** Whether the page's frontmatter carries `disable-model-invocation: true`: automatic folding is a
 * model invocation, which such a skill forbids. Frontmatter that does not parse is a usage error,
 * since the silent reading would be an unwanted invocation. */
function userInvokeOnly(frontmatter: string | null, pagePath: string): boolean {
  if (frontmatter === null) return false;

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(frontmatter);
  } catch (error) {
    usageError(`cannot parse the frontmatter of ${pagePath}: ${String(error)}`);
  }
  return isRecord(parsed) && parsed["disable-model-invocation"] === true;
}

/** What the launch runs under beyond the sandbox: the stall clock and the criteria appended to the prompt. */
interface Rules {
  stallSeconds: number;
  criteria: Criteria[];
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

/** Each skill's comparable source in one lockfile. A file that does not parse is a usage error,
 * never a guess at the collection. */
function lockedSources(file: string, raw: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    usageError(`cannot parse ${file}: ${String(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.skills)) {
    usageError(`${file}: expected a "skills" object; the lockfile format has changed`);
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
      usageError(`cannot read ${file}: ${String(error)}`);
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
    usageError(`cannot read ${PLUGIN_MANIFEST}: ${String(error)}`);
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
      usageError(`cannot read ${pagePath}: ${String(error)}`);
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
 * none under `--criteria none`. A name that declares none is a usage error. */
function selectCriteria(spec: string | null): Criteria[] {
  // Opting out reads no record and no page, so a broken install cannot stop a review that asked for none.
  if (spec === "none") return [];

  const installed = installedCriteria();
  if (spec === null) return installed.filter((criteria) => criteria.ours && !criteria.userOnly);

  const chosen = spec.split(",");
  const declaring = installed.map((criteria) => criteria.name);
  const unknown = chosen.filter((name) => !declaring.includes(name));
  if (unknown.length > 0) {
    usageError(
      `--criteria: ${unknown.join(", ")} declares no ## ${CRITERIA_HEADING}; the installed skills that do: ${declaring.join(", ")}`,
    );
  }
  return installed.filter((criteria) => chosen.includes(criteria.name));
}

/** The block a launch appends to the prompt: the pages to read, never their text, so the prompt
 * stays short and the reviewer reads each skill's own words. Empty under `--criteria none`. */
function companionBlock(criteria: Criteria[]): string {
  if (criteria.length === 0) return "";

  const pages = criteria.map(({ name, page }) => `- ${name}: ${page}`);
  return `${COMPANION_HEADING}\n${COMPANION_INSTRUCTION}\n${pages.join("\n")}\n`;
}

function withCriteria(prompt: string, criteria: Criteria[]): string {
  const block = companionBlock(criteria);
  if (block === "") return prompt;

  return `${prompt.trimEnd()}\n\n${block}`;
}

/** The `criteria` subcommand: the same block for a review run through a dedicated tool, which the
 * launcher never sees, so that path cannot omit the companion criteria either. */
function printCriteria(args: string[]): void {
  let spec: string | null = null;
  if (args.length === 2 && args[0] === "--criteria") spec = args[1] ?? null;
  else if (args.length !== 0)
    usageError("criteria takes at most --criteria <name>[,<name>] or none");
  process.stdout.write(companionBlock(selectCriteria(spec)));
}

/** The CLI reviewer's argv; the prompt travels as one element, so backticks and $() stay literal. */
interface Delivery {
  args: string[];
}

function argvDelivery(tool: CliTool, prompt: string): Delivery {
  return { args: TOOL_ARGS[tool](prompt) };
}

/** How the reviewer is confined. `read-only` is every reviewer's own sandbox.
 * `copy` is codex with no sandbox at all, run inside a snapshot of the
 * repository under the scratch dir: nothing enforces read-only there. The
 * copy keeps a write the prompt forbade out of the checkout under review by
 * path alone (an absolute symlink into the real checkout is the exception),
 * and dies with the review. The report and the launch record name the mode. */
type Launch =
  | { sandbox: "read-only" }
  | {
      sandbox: "copy";
      reason: string;
      root: string;
      subdir: string;
    };

const SANDBOX_PROBE_TIMEOUT_MS = 15000;
const BWRAP_REFUSAL = /^bwrap: .*$/m;

/** codex runs every sandboxed command under bubblewrap, and a container whose
 * AppArmor profile denies mount propagation refuses it at start (`bwrap:
 * Failed to make / slave: Permission denied`). A no-op under the sandbox
 * shows that before the reviewer does. Only that refusal selects the copy:
 * a codex too old for the subcommand, or one not installed, keeps the
 * read-only launch and reports its own failure there. */
function planLaunch(tool: Tool): Launch {
  if (tool !== "codex") return { sandbox: "read-only" };
  const probe = spawnSync("codex", ["sandbox", "--", "true"], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: SANDBOX_PROBE_TIMEOUT_MS,
  });
  if (probe.status === 0 || probe.error !== undefined) return { sandbox: "read-only" };
  const refusal = BWRAP_REFUSAL.exec(probe.stderr.toString())?.[0];
  if (refusal === undefined) return { sandbox: "read-only" };
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (toplevel.status !== 0) {
    usageError(
      `codex sandbox unavailable (${refusal}) and ${process.cwd()} is not inside a git repository: nothing to snapshot for an unsandboxed review`,
    );
  }
  const root = toplevel.stdout.toString().trim();
  // git reports the toplevel by real path; a cwd reached through a symlink,
  // or one outside the toplevel it reported (GIT_DIR and GIT_WORK_TREE point
  // elsewhere), gets the copy's root rather than a twin outside the copy.
  const rel = relative(root, realpathSync(process.cwd()));
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const subdir = outside ? "" : rel;
  return { sandbox: "copy", reason: refusal, root, subdir };
}

/** A kill of this process reaches the reviewer, so neither it nor its copy
 * outlives the launcher. Installed before the probe and the snapshot: a
 * signal during those synchronous steps is held until they return, by which
 * time the reviewer exists (or its spawn failure is already recorded) and the
 * kill settles it, copy removed and status recorded. Signal listeners do not
 * hold the event loop open, so a finished launcher still exits normally. */
function forwardSignals(): { child: ReturnType<typeof spawn> | null } {
  const holder: { child: ReturnType<typeof spawn> | null } = { child: null };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (holder.child !== null) killTree(holder.child, signal);
    });
  }
  return holder;
}

/** The reviewer leads its own process group (spawned detached), so the signal reaches the
 * children it leaves behind: a stuck helper of codex's once held a silent review for hours.
 * The child alone is the fallback once its group is gone. */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** A stall is the launcher's own verdict and is reported as itself; any other failure is the reviewer's. */
function failureReason(status: string, otherwise: string): string {
  return STALL_STATUS.test(status) ? status : otherwise;
}

// Exits go through process.exitCode + a natural event-loop drain, never
// process.exit(): an explicit exit can truncate a large pending stream write.
function reportVerdict(
  extraction: Extraction,
  outputFile: string,
  sandbox?: "copy",
  criteria: string[] = [],
): void {
  if (extraction.ok) {
    const { verdict, toolCalls, trajectory } = extraction.review;
    const report = {
      verdict,
      tool_calls: toolCalls,
      capture: outputFile,
      ...(sandbox === undefined ? {} : { sandbox }),
      criteria,
      trajectory,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }
  // Name the capture only when it is there to read: an --extract whose
  // stream was already deleted must not point at a path that is gone.
  const kept = existsSync(outputFile) ? `; output kept at ${outputFile}` : "";
  process.stderr.write(`review FAILED - relaunch (${extraction.reason}${kept})\n`);
  process.exitCode = 1;
}

interface Scratch {
  dir: string;
  outFile: string;
  errFile: string;
  statusFile: string;
}

function scratchPaths(dir: string, tool: Tool): Scratch {
  return {
    dir,
    outFile: join(dir, tool === "copilot" ? "review.out" : "review.jsonl"),
    errFile: join(dir, "review.err"),
    statusFile: join(dir, "review.status"),
  };
}

/** review.status binds a capture to its reviewer and output file, so
 * --extract cannot be pointed at another reviewer's stream (or a non-stream
 * file) and read it with the wrong rules. Written without `status` at launch;
 * rewritten with it on completion. `sandbox: "copy"` travels with it so an
 * --extract report says how the reviewer was confined. */
function recordStatus(
  scratch: Scratch,
  tool: Tool,
  fields: { criteria: string[]; status?: string; sandbox?: "copy" },
): void {
  // Write-then-rename: a concurrent --extract must never observe a truncated
  // record (writeFileSync truncates before writing).
  const pending = `${scratch.statusFile}.tmp`;
  writeFileSync(
    pending,
    JSON.stringify({
      tool,
      output: basename(scratch.outFile),
      criteria: fields.criteria,
      ...(fields.sandbox === undefined ? {} : { sandbox: fields.sandbox }),
      ...(fields.status === undefined ? {} : { status: fields.status }),
    }),
  );
  renameSync(pending, scratch.statusFile);
}

interface ReviewerHooks {
  /** Fires once, on the reviewer's first stdout byte or ACP event. */
  onLife?: () => void;

  /** The copy mode's progress line: the refusal and where the copy lives. */
  onFallback?: (message: string) => void;

  /** The reviewer never ran: the spawn failed, or in copy mode the snapshot did; onDone never follows it. */
  onSpawnError: (error: Error) => void;

  /** Receives the recorded status: "0" is the only success. */
  onDone: (status: string) => void;
}

/** The descriptors one run holds until it settles: the stream capture and its stderr. */
interface CaptureFds {
  out: number;
  err: number;
}

/** What the copy mode adds to a run: the snapshot and the cwd inside it. */
interface CopyMode {
  copy: string;
  cwd: string;
}

/** What a run holds while the reviewer works: where the bytes go, what the close handler records, and what settling releases. */
interface Run {
  tool: Tool;
  scratch: Scratch;
  criteria: string[];
  sandbox: "copy" | undefined;
  stallSeconds: number;
  fds: CaptureFds;
  copyMode: CopyMode | null;
  warn: (line: string) => void;
}

function openCaptureFds(scratch: Scratch): CaptureFds {
  return { out: openSync(scratch.outFile, "w"), err: openSync(scratch.errFile, "w") };
}

/** A snapshot that failed midway is removed with the failure and named, for the caller to report as a spawn failure. */
function prepareCopyMode(
  launch: Extract<Launch, { sandbox: "copy" }>,
  scratch: Scratch,
  warn: (line: string) => void,
): { ok: true; copyMode: CopyMode } | { ok: false; reason: string } {
  const snapshot = snapshotRepository(launch, scratch.dir, warn);
  if (!snapshot.ok) return snapshot;

  return { ok: true, copyMode: { copy: snapshot.copy, cwd: snapshot.cwd } };
}

/** Let go together on every path: the copy, then the descriptors. */
function releaseRun(
  fds: CaptureFds,
  copyMode: CopyMode | null,
  warn: (line: string) => void,
): void {
  if (copyMode !== null) removeTree(copyMode.copy, warn);

  closeSync(fds.out);
  closeSync(fds.err);
}

/** A warning lands in review.err, which outlives the run and is named by a failure, as well as on stderr (ignored for a detached monitor). */
function warner(fds: CaptureFds): (line: string) => void {
  return (line) => {
    writeFileSync(fds.err, `${line}\n`);
    process.stderr.write(`${line}\n`);
  };
}

/** Every byte or event from the reviewer winds the stall clock. When it runs out, the reviewer's whole process
 * group is killed and the run is a stall: a stuck browser-extension host codex spawned once held a silent review
 * for three hours while a 3600 s wait ran. */
function stallClock(
  child: ReturnType<typeof spawn>,
  run: Run,
  onStall: () => void,
): { wind: () => void; stop: () => void } {
  let clock: ReturnType<typeof setTimeout> | null = null;
  const wind = () => {
    if (clock !== null) clearTimeout(clock);
    clock = setTimeout(() => {
      onStall();
      run.warn(
        `review stalled: no stream event for ${run.stallSeconds} s; killing the reviewer (pid ${child.pid})`,
      );
      killTree(child, "SIGKILL");
    }, run.stallSeconds * 1000);
  };
  wind();
  return {
    wind,
    stop: () => {
      if (clock !== null) clearTimeout(clock);
    },
  };
}

/** The one settling of a run: the status recorded, the copy and the descriptors released, the hook told. A spawn
 * failure emits 'error' and may still emit 'close', and an ACP end and the adapter's close both arrive, so the
 * first caller wins. */
function settler(
  run: Run,
  hooks: ReviewerHooks,
  clock: { stop: () => void },
  onRelease: () => void = () => {},
): { done: (status: string) => void; failed: (error: Error) => void } {
  let settled = false;
  const once = (handle: () => void) => {
    if (settled) return;
    settled = true;
    clock.stop();
    onRelease();
    releaseRun(run.fds, run.copyMode, run.warn);
    handle();
  };
  return {
    done: (status) =>
      once(() => {
        recordStatus(run.scratch, run.tool, {
          criteria: run.criteria,
          status,
          sandbox: run.sandbox,
        });
        hooks.onDone(status);
      }),
    failed: (error) => once(() => hooks.onSpawnError(error)),
  };
}

function stallStatus(run: Run): string {
  return `stalled: no stream event for ${run.stallSeconds} s`;
}

/** A CLI reviewer's stream is its stdout: every byte lands in the capture and winds the clock, and its exit code is the status. */
function watchCli(child: ReturnType<typeof spawn>, run: Run, hooks: ReviewerHooks): void {
  let sawLife = false;
  let stalled = false;
  const clock = stallClock(child, run, () => {
    stalled = true;
  });
  const settle = settler(run, hooks, clock);
  // stdio[1] and stdio[2] are "pipe" in the spawn call, so both streams exist; the null in their types only
  // covers other stdio configurations.
  child.stdout!.on("data", (chunk: Buffer) => {
    if (!sawLife) {
      sawLife = true;
      hooks.onLife?.();
    }
    clock.wind();
    writeFileSync(run.fds.out, chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    clock.wind();
    writeFileSync(run.fds.err, chunk);
  });
  child.on("error", (error) => settle.failed(error));
  child.on("close", (code) => settle.done(stalled ? stallStatus(run) : String(code ?? "signal")));
}

function runCliReviewer(
  tool: CliTool,
  delivery: Delivery,
  scratch: Scratch,
  rules: Rules,
  hooks: ReviewerHooks,
): ReturnType<typeof spawn> | null {
  const criteria = rules.criteria.map((entry) => entry.name);
  const fds = openCaptureFds(scratch);
  recordStatus(scratch, tool, { criteria });
  const warn = warner(fds);

  // spawn can also throw synchronously (e.g. a NUL byte in an argv element);
  // that must reach onSpawnError like an async spawn failure, not crash.
  let child: ReturnType<typeof spawn>;
  try {
    // stdin is 'ignore', never an open pipe a reviewer could wait on.
    child = spawn(tool, delivery.args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (error) {
    releaseRun(fds, null, warn);
    hooks.onSpawnError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }

  const run: Run = {
    tool,
    scratch,
    criteria,
    sandbox: undefined,
    stallSeconds: rules.stallSeconds,
    fds,
    copyMode: null,
    warn,
  };
  watchCli(child, run, hooks);
  return child;
}

/** realpath(3) over `relative` from `root`, as codex canonicalizes CODEX_HOME: each symlink is followed before a later
 * `..` steps out of it. bun's realpathSync drops `link/..` by the text first, landing beside the link, not in its target. */
function physicalPath(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    current = part === ".." ? dirname(current) : realpathSync(`${current}/${part}`);
  }
  return current;
}

/** The adapter's environment inside the copy: no GIT_* variable, which would name the live repository, and a relative
 * CODEX_HOME made absolute from the launcher's cwd, as codex reads it there; a path realpath cannot walk is taken by
 * its text. An empty one is unset to codex. */
function copyEnv(): NodeJS.ProcessEnv {
  const env = withoutGitEnv(process.env);
  if (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME)) {
    try {
      env.CODEX_HOME = physicalPath(process.cwd(), env.CODEX_HOME);
    } catch {
      env.CODEX_HOME = resolve(process.cwd(), env.CODEX_HOME);
    }
  }
  return env;
}

/** What a reviewer may do when it asks. claude's plan mode runs its read-only tools unasked, so whatever asks is
 * a write or a plan approval: refused. codex under its own read-only sandbox asks for a command the sandbox
 * would refuse (a write, the network), so only reads and searches are allowed there; inside the snapshot copy
 * nothing confines an allowed command, and the copy is what keeps a write out of the checkout, so commands are
 * allowed; a file edit is refused under every confinement, and so is a request whose kind no message named. */
function policyFor(tool: AcpTool, launch: Launch): PermissionPolicy {
  if (tool === "claude") return () => "deny";

  const allowed = new Set(
    launch.sandbox === "copy" ? ["read", "search", "execute", "fetch"] : ["read", "search"],
  );
  return (toolCall) => (allowed.has(toolCall.kind) ? "allow" : "deny");
}

const ADAPTER_CLOSE_GRACE_MS = 1000;

function runAcpReviewer(
  tool: AcpTool,
  launch: Launch,
  prompt: string,
  scratch: Scratch,
  rules: Rules,
  hooks: ReviewerHooks,
): ReturnType<typeof spawn> | null {
  const criteria = rules.criteria.map((entry) => entry.name);
  const fds = openCaptureFds(scratch);
  const sandbox = launch.sandbox === "copy" ? "copy" : undefined;
  recordStatus(scratch, tool, { criteria, sandbox });
  const warn = warner(fds);

  let copyMode: CopyMode | null = null;
  if (launch.sandbox === "copy") {
    const built = prepareCopyMode(launch, scratch, warn);
    if (!built.ok) {
      releaseRun(fds, null, warn);
      hooks.onSpawnError(new Error(built.reason));
      return null;
    }
    copyMode = built.copyMode;
    hooks.onFallback?.(
      `codex sandbox unavailable (${launch.reason}): reviewing a snapshot copy at ${copyMode.copy}`,
    );
  }

  const run: Run = {
    tool,
    scratch,
    criteria,
    sandbox,
    stallSeconds: rules.stallSeconds,
    fds,
    copyMode,
    warn,
  };
  // A spawn failure settles the run and closes its descriptors before the session reports the broken stream,
  // so a line after the settling has nowhere to go and is dropped.
  const wound = { wind: () => {}, released: false };
  let sawLife = false;
  const capture = (line: Record<string, unknown>) => {
    if (wound.released) return;
    // Life is the adapter answering; the failure line is the launcher's own.
    if (!sawLife && line.event !== "failed") {
      sawLife = true;
      hooks.onLife?.();
    }
    writeFileSync(fds.out, `${JSON.stringify(line)}\n`);
  };
  let session: ReturnType<typeof startAcpSession>;
  try {
    session = startAcpSession({
      adapter: ACP_REVIEWERS[tool].adapter,
      args: [],
      cwd: copyMode?.cwd,
      env: copyMode === null ? undefined : copyEnv(),
      mode: ACP_REVIEWERS[tool].mode,
      prompt,
      policy: policyFor(tool, launch),
      capture: (line) => {
        capture(line);
        wound.wind();
      },
      stderr: (chunk) => {
        if (wound.released) return;
        writeFileSync(fds.err, chunk);
        wound.wind();
      },
    });
  } catch (error) {
    releaseRun(fds, copyMode, warn);
    hooks.onSpawnError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  wound.wind = watchAcp(session, run, hooks, capture, () => {
    wound.released = true;
  });
  return session.child;
}

/** The session's end is the review's: a stop the verdict reads, or a failure the capture names. The adapter idles
 * after the turn, so the launcher ends it, and the run settles once both the session and the adapter are done.
 * An adapter that dies first gets ADAPTER_CLOSE_GRACE_MS for the session to report the broken stream before the
 * exit itself is written as the failure. Returns the stall clock's wind, for the capture and the stderr to call. */
function watchAcp(
  session: ReturnType<typeof startAcpSession>,
  run: Run,
  hooks: ReviewerHooks,
  capture: (line: Record<string, unknown>) => void,
  onRelease: () => void,
): () => void {
  const { child } = session;
  let stalled = false;
  let ended: AcpEnd | null = null;
  let closed = false;
  const clock = stallClock(child, run, () => {
    stalled = true;
  });
  const settle = settler(run, hooks, clock, onRelease);
  const maybeSettle = () => {
    if (ended === null || !closed) return;
    settle.done(stalled ? stallStatus(run) : "0");
  };
  session.done.then((end) => {
    ended = end;
    if (end.kind === "failed") capture({ event: "failed", reason: end.reason });
    killTree(child, "SIGTERM");
    maybeSettle();
  });
  child.on("error", (error) => settle.failed(error));
  child.on("close", (code) => {
    closed = true;
    maybeSettle();
    setTimeout(() => {
      if (ended !== null) return;
      ended = {
        kind: "failed",
        reason: `the adapter exited (${code ?? "signal"}) before the turn ended`,
      };
      capture({ event: "failed", reason: ended.reason });
      maybeSettle();
    }, ADAPTER_CLOSE_GRACE_MS);
  });
  return clock.wind;
}

/** What one launch runs: the tool, how codex is confined, and the prompt as the CLI delivery or as the ACP request's text. */
interface Reviewer {
  tool: Tool;
  launch: Launch;
  delivery: Delivery | null;
  prompt: string;
}

/** The binary a tool needs on PATH: its adapter for an ACP reviewer, itself for a CLI one. */
function binaryOf(tool: Tool): string {
  return tool === "copilot" ? tool : ACP_REVIEWERS[tool].adapter;
}

/** The reviewer behind one tool: copilot as the CLI the delivery names, the others as an ACP session. */
function runReviewer(
  reviewer: Reviewer,
  scratch: Scratch,
  rules: Rules,
  hooks: ReviewerHooks,
): ReturnType<typeof spawn> | null {
  const { tool, launch, delivery, prompt } = reviewer;
  if (tool !== "copilot") return runAcpReviewer(tool, launch, prompt, scratch, rules, hooks);
  if (delivery === null) throw new Error(`${tool} needs a delivery`);

  return runCliReviewer(tool, delivery, scratch, rules, hooks);
}

function runForeground(
  reviewer: Reviewer,
  scratch: Scratch,
  rules: Rules,
): ReturnType<typeof spawn> | null {
  const { tool, launch } = reviewer;
  return runReviewer(reviewer, scratch, rules, {
    onLife: () => process.stderr.write("review stream alive\n"),
    onFallback: (message) => process.stderr.write(`${message}\n`),
    onSpawnError: (error) => {
      // Nothing was captured; a retained empty scratch dir would be noise.
      removeTree(scratch.dir, (line) => process.stderr.write(`${line}\n`));
      if (isEnoent(error)) {
        process.stderr.write(`reviewer binary not found: ${binaryOf(tool)}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`review FAILED - relaunch (spawn failed: ${String(error)})\n`);
      process.exitCode = 1;
    },
    onDone: (status) => {
      process.stderr.write(`reviewer exited (status=${status})\n`);
      let extraction = extractVerdict(tool, readFileSync(scratch.outFile, "utf-8"));
      if (STALL_STATUS.test(status) || (status !== "0" && extraction.ok)) {
        extraction = {
          ok: false,
          reason: failureReason(
            status,
            `reviewer status: ${status} (stderr kept at ${scratch.errFile})`,
          ),
        };
      }
      // The capture stays on success too: the printed report names it, so a
      // surprising verdict can be traced to the exact reviewer message.
      reportVerdict(
        extraction,
        scratch.outFile,
        launch.sandbox === "copy" ? "copy" : undefined,
        rules.criteria.map((entry) => entry.name),
      );
    },
  });
}

/** Detached monitor: capture the stream and record the exit status, silently. */
function runCapture(
  reviewer: Reviewer,
  scratch: Scratch,
  rules: Rules,
): ReturnType<typeof spawn> | null {
  return runReviewer(reviewer, scratch, rules, {
    onSpawnError: (error) => {
      recordStatus(scratch, reviewer.tool, {
        criteria: rules.criteria.map((entry) => entry.name),
        status: isEnoent(error) ? "not-found" : `spawn failed: ${String(error)}`,
      });
    },
    onDone: () => {},
  });
}

function runBackground(
  tool: Tool,
  launch: Launch,
  prompt: string,
  rules: Rules,
  criteriaSpec: string | null,
): void {
  const scratch = scratchPaths(mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)), tool);
  // Snapshot the prompt: the caller's file may be edited or deleted before
  // the detached monitor gets around to reading it.
  const promptSnapshot = join(scratch.dir, "prompt.txt");
  writeFileSync(promptSnapshot, prompt);
  // The launch record is what lets the monitor's --capture prove its
  // provenance (and what --extract reads while the run is still pending).
  recordStatus(scratch, tool, {
    criteria: rules.criteria.map((entry) => entry.name),
    sandbox: launch.sandbox === "copy" ? "copy" : undefined,
  });
  // The monitor re-reads the snapshot and appends the criteria itself, so it takes the same selection.
  const monitorArgs = [
    fileURLToPath(import.meta.url),
    tool,
    promptSnapshot,
    "--capture",
    scratch.dir,
    "--stall",
    String(rules.stallSeconds),
  ];
  if (criteriaSpec !== null) monitorArgs.push("--criteria", criteriaSpec);
  const monitor = spawn(process.execPath, monitorArgs, { detached: true, stdio: "ignore" });
  monitor.on("error", (error) => {
    process.stderr.write(`review FAILED - relaunch (failed to detach monitor: ${String(error)})\n`);
    process.exitCode = 1;
  });
  monitor.on("spawn", () => {
    monitor.unref();
    process.stdout.write(`output-file: ${scratch.outFile}\npid: ${monitor.pid}\n`);
  });
}

interface LaunchRecord {
  /** The skills whose Review Criteria the launch appended to the prompt. */
  criteria: string[];

  /** Absent until the monitor records the reviewer's exit. */
  status?: string;

  /** Present when the reviewer ran unsandboxed in a snapshot copy. */
  sandbox?: "copy";
}

/** The record beside the output file, once its reviewer and output name are
 * checked against this invocation; null when there is no record at all.
 * A record that is present but not a matching launch record is a usage error. */
function readLaunchRecord(tool: Tool, outputFile: string): LaunchRecord | null {
  let recordText: string;
  try {
    recordText = readFileSync(join(dirname(outputFile), "review.status"), "utf-8");
  } catch {
    return null;
  }
  // Typed as a variable so the compiler narrows `parsed` through the call.
  const notCapture: () => never = () =>
    usageError(`unrecognized review.status beside ${outputFile}: not a run-review capture`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordText);
  } catch {
    notCapture();
  }
  if (!isRecord(parsed)) notCapture();
  // A record from before the launcher appended criteria carries none; its capture still reads.
  const { tool: recordedTool, output: recordedOutput, status, sandbox, criteria = [] } = parsed;
  if (typeof recordedTool !== "string" || typeof recordedOutput !== "string") notCapture();
  if (!Array.isArray(criteria) || criteria.some((name) => typeof name !== "string")) notCapture();
  if (recordedTool !== tool) {
    usageError(
      `this capture was launched with reviewer '${recordedTool}', not '${tool}'; extract with the same reviewer`,
    );
  }
  if (recordedOutput !== basename(outputFile)) {
    usageError(`this capture's output file is '${recordedOutput}', not '${basename(outputFile)}'`);
  }
  if ("sandbox" in parsed && sandbox !== "copy") {
    usageError(`unrecognized review.status beside ${outputFile}: unknown sandbox`);
  }
  const record: LaunchRecord = sandbox === "copy" ? { criteria, sandbox } : { criteria };
  if (!("status" in parsed)) return record;
  if (typeof status !== "string") {
    usageError(`unrecognized review.status beside ${outputFile}: non-string status`);
  }
  return { ...record, status };
}

function reportRecordedRun(
  tool: Tool,
  outputFile: string,
  status: string,
  sandbox: "copy" | undefined,
  criteria: string[],
): void {
  if (status === "not-found") {
    process.stderr.write(`reviewer binary not found: ${binaryOf(tool)}\n`);
    process.exitCode = 2;
    return;
  }
  if (status !== "0") {
    const reason = failureReason(status, `recorded reviewer status: ${status}`);
    reportVerdict({ ok: false, reason }, outputFile);
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(outputFile, "utf-8");
  } catch (error) {
    reportVerdict({ ok: false, reason: `cannot read output file: ${String(error)}` }, outputFile);
    return;
  }
  reportVerdict(extractVerdict(tool, raw), outputFile, sandbox, criteria);
}

function extractRecorded(tool: Tool, outputFile: string): void {
  // Before the monitor records completion (or even creates the stream),
  // extraction must fail as an unfinished review, not a usage error.
  const record = readLaunchRecord(tool, outputFile);
  if (record?.status === undefined) {
    reportVerdict(
      { ok: false, reason: "no exit status recorded (reviewer still running?)" },
      outputFile,
    );
    return;
  }
  reportRecordedRun(tool, outputFile, record.status, record.sandbox, record.criteria);
}

/** A whole number of seconds up to MAX_TIMER_SECONDS: a timer's delay is a 32-bit count of milliseconds, and
 * past it the timer fires at once. */
function secondsArg(flag: string, value: string | undefined): number {
  if (value === undefined || !WHOLE_SECONDS.test(value) || Number(value) > MAX_TIMER_SECONDS) {
    usageError(`${flag} requires a whole number of seconds, 1 to ${MAX_TIMER_SECONDS}`);
  }
  return Number(value);
}

type FlagForm = "launch" | "extract";

/** The other form's flags, which this form refuses by name. */
function foreignFlags(form: FlagForm): readonly (keyof typeof FLAGS)[] {
  return form === "launch" ? EXTRACT_FLAGS : LAUNCH_FLAGS;
}

function refuseForeignFlag(flag: string, form: FlagForm): never {
  const belongsTo = form === "launch" ? "--extract" : "a launch";
  return usageError(`--${flag} applies only to ${belongsTo}`);
}

/** node's refusal of the argv as this tool's own usage error, which the tests pin, with the flag read out of
 * node's message. A refusal of another kind is rethrown. */
function refuseArgv(error: unknown, form: FlagForm): never {
  const message = isRecord(error) ? String(error.message) : String(error);
  const flag = /'(-[^ ']+)/.exec(message)?.[1] ?? "";
  const code = isRecord(error) ? error.code : undefined;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") usageError(`unknown flag: ${flag}`);
  if (code !== "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") throw error;

  const name = flag.slice(2);
  if (foreignFlags(form).some((foreign) => foreign === name)) refuseForeignFlag(name, form);
  if (flag === "--capture") usageError("--capture requires a directory");
  if (flag === "--criteria") usageError("--criteria requires <name>[,<name>] or none");
  if (flag === "--timeout" || flag === "--stall") secondsArg(flag, undefined);
  usageError(message);
}

/** The flags of one form, parsed by node over FLAGS, which holds both forms: a flag of the other form is
 * refused by name, never as unknown. */
function parseFlags(args: string[], form: FlagForm) {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: FLAGS, allowPositionals: true, strict: true });
  } catch (error) {
    refuseArgv(error, form);
  }

  for (const flag of foreignFlags(form)) {
    if (parsed.values[flag] !== undefined) refuseForeignFlag(flag, form);
  }
  return parsed;
}

/** The launch writes the record before it prints the output-file line, so
 * a missing record on the first read is a wrong path, never an early read. */
function extractAfterWait(tool: Tool, outputFile: string, timeoutSeconds: number): void {
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  const noRecord = (): never =>
    usageError(
      `no launch record beside ${outputFile}: --wait needs the output-file a --background launch printed`,
    );
  let record = readLaunchRecord(tool, outputFile) ?? noRecord();
  while (record.status === undefined) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      reportVerdict(
        {
          ok: false,
          reason: `--wait timed out: no exit status recorded beside ${outputFile} after ${elapsed} s`,
        },
        outputFile,
      );
      return;
    }
    Bun.sleepSync(Math.min(WAIT_POLL_MS, remaining));
    record = readLaunchRecord(tool, outputFile) ?? noRecord();
  }
  reportRecordedRun(tool, outputFile, record.status, record.sandbox, record.criteria);
}

/** The `--extract` form: the recorded verdict of a capture, after a wait for it under `--wait`. */
function extractCommand(tool: Tool, args: string[]): void {
  const { values, positionals } = parseFlags(args, "extract");
  const wait = values.wait === true;
  const timeoutSeconds =
    values.timeout === undefined ? null : secondsArg("--timeout", values.timeout);
  if (timeoutSeconds !== null && !wait) usageError("--timeout applies only to --extract --wait");

  const outputFile = positionals[0];
  if (outputFile === undefined || positionals.length !== 1) {
    usageError("--extract takes exactly one <output-file>");
  }
  if (wait) extractAfterWait(tool, outputFile, timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS);
  else extractRecorded(tool, outputFile);
}

interface LaunchOptions {
  background: boolean;
  captureDir: string | null;
  stallSeconds: number;
  criteriaSpec: string | null;
  promptFile: string;
}

function launchOptions(args: string[]): LaunchOptions {
  const { values, positionals } = parseFlags(args, "launch");
  const background = values.background === true;
  const captureDir = values.capture ?? null;
  const stallSeconds =
    values.stall === undefined ? DEFAULT_STALL_SECONDS : secondsArg("--stall", values.stall);
  if (background && captureDir !== null) {
    usageError("--background and --capture are mutually exclusive");
  }

  const promptFile = positionals[0];
  if (promptFile === undefined || positionals.length !== 1) {
    usageError("expected exactly one <prompt-file>");
  }

  return {
    background,
    captureDir,
    stallSeconds,
    criteriaSpec: values.criteria ?? null,
    promptFile,
  };
}

function readPrompt(promptFile: string): string {
  let prompt: string;
  try {
    prompt = readFileSync(promptFile, "utf-8");
  } catch (error) {
    usageError(`cannot read prompt file ${promptFile}: ${String(error)}`);
  }
  if (prompt.trim() === "") usageError(`prompt file is empty: ${promptFile}`);

  return prompt;
}

/** How the CLI reviewer gets its prompt; an ACP reviewer gets it in the request and has no delivery. */
function deliveryFor(tool: Tool, fullPrompt: string): Delivery | null {
  return tool === "copilot" ? argvDelivery(tool, fullPrompt) : null;
}

/** The reviewer run in this process: the foreground run that prints the verdict, or under `--capture` the
 * detached monitor's silent one. */
function runInThisProcess(
  tool: Tool,
  launch: Launch,
  options: LaunchOptions,
  prompt: string,
  rules: Rules,
): ReturnType<typeof spawn> | null {
  const scratch = scratchPaths(
    options.captureDir ?? mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)),
    tool,
  );
  // The snapshot lives and dies with the capture; the caller's own prompt file stays theirs.
  const fullPrompt = withCriteria(prompt, rules.criteria);
  const promptSnapshot = join(scratch.dir, "prompt.txt");
  writeFileSync(promptSnapshot, fullPrompt);
  const reviewer: Reviewer = {
    tool,
    launch,
    delivery: deliveryFor(tool, fullPrompt),
    prompt: fullPrompt,
  };
  if (options.captureDir === null) return runForeground(reviewer, scratch, rules);

  return runCapture(reviewer, scratch, rules);
}

function launchCommand(tool: Tool, args: string[]): void {
  const options = launchOptions(args);
  const { background, captureDir, criteriaSpec, promptFile } = options;
  if (captureDir === null) requireMintedPrompt(promptFile);
  else requireCaptureProvenance(tool, promptFile, captureDir);
  const prompt = readPrompt(promptFile);
  // Selected in the parent of a --background launch too, so an unknown name is its usage error.
  const rules: Rules = {
    stallSeconds: options.stallSeconds,
    criteria: selectCriteria(criteriaSpec),
  };

  // The parent of a --background launch runs no reviewer; every other
  // process forwards its kill to the one it is about to launch, listening
  // from here so the probe and the snapshot below are covered too.
  const forwarded = background ? null : forwardSignals();
  // Settled in every process, parent and monitor alike, so a --background
  // launch outside a repository is the parent's usage error, not a monitor
  // that dies silently with the record left pending.
  const launch = planLaunch(tool);
  if (captureDir === null) purgeStaleScratch();
  if (background) {
    runBackground(tool, launch, prompt, rules, criteriaSpec);
    return;
  }

  const child = runInThisProcess(tool, launch, options, prompt, rules);
  if (forwarded !== null) forwarded.child = child;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv[0] === "prepare") {
    const section = argv[1];
    if (section === undefined || argv.length !== 2)
      usageError("prepare takes exactly one <section>");
    preparePrompt(section);
    return;
  }
  if (argv[0] === "criteria") {
    printCriteria(argv.slice(1));
    return;
  }

  const toolArg = argv[0];
  if (toolArg === undefined || !isTool(toolArg)) {
    usageError(`unknown reviewer: ${toolArg ?? "(none)"}`);
  }
  const rest = argv.slice(1);
  if (rest[0] === "--extract") {
    extractCommand(toolArg, rest.slice(1));
    return;
  }

  launchCommand(toolArg, rest);
}

try {
  main();
} catch (error) {
  if (!(error instanceof SilentExit)) throw error;
}
