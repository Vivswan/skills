#!/usr/bin/env bun
/**
 * Launch a read-only cross-model reviewer and print its verdict as one JSON report.
 * Each reviewer CLI has a trap the launch retires; the usage text is USAGE below.
 *
 *   prompt through a shell       -> backticks and $(...) expand: spawn from an argv array
 *   stdin left open              -> codex and claude block forever: 'ignore', or a file (EOF-ended)
 *   codex narrates in the schema -> an empty verdict reads as clean: a tool call must precede it
 *   predictable prompt path      -> one agent overwrites another's: prepare mints a private dir
 *   shared tmp dir               -> captures pile up: rubber-duck-* dirs older than 24 h are purged
 *   bwrap denied in a container  -> codex's sandbox cannot start: review an unsandboxed snapshot copy
 *   cp -a of the checkout        -> venvs and nested worktrees weigh gigabytes: snapshot HEAD, the refs, the index
 *   codex reconnects mid-stream  -> an error event precedes the verdict: only a verdict-less capture fails
 *   the stream goes silent       -> a stuck child held one run for hours: --stall kills the reviewer's process group
 *   criteria pasted by hand      -> thirty rounds passed what the house rules forbid: the launcher names this collection's pages
 */

import { spawn, spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  closeSync,
  copyFileSync,
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Extraction, extractVerdict, isRecord, isTool, type Tool } from "./verdict.mts";

// The skill's directory is resolved through any install symlink, so its siblings are the installed skills.

const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), "verdict-schema.json");
const SKILL_DIR = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const SKILLS_ROOT = dirname(SKILL_DIR);
const PLUGIN_MANIFEST = join(dirname(SKILLS_ROOT), ".claude-plugin", "plugin.json");
const CRITERIA_HEADING = "Review Criteria";
const COMPANION_HEADING = "## Companion review criteria";
const COMPANION_INSTRUCTION =
  "Read the `## Review Criteria` section of each page below and apply it as part of this review:";

/** Read once at launch; a missing or malformed schema beside the script is a
 * broken install, not a review failure. */
function schemaText(): string {
  return readFileSync(SCHEMA_FILE, "utf-8");
}

/** codex's filesystem policy for the review: read-only under its own sandbox,
 * or none at all inside a snapshot copy when that sandbox cannot start. */
type CodexSandbox = "read-only" | "danger-full-access";

const TOOL_ARGS: Record<Tool, (prompt: string, sandbox: CodexSandbox) => string[]> = {
  // --sandbox read-only: the reviewer can grep/diff/typecheck but not write.
  // --output-schema: the final message must be the verdict object.
  codex: (prompt, sandbox) => [
    "exec",
    "--json",
    "--sandbox",
    sandbox,
    "--output-schema",
    SCHEMA_FILE,
    prompt,
  ],
  // --verbose is REQUIRED with --output-format stream-json; without it claude
  // errors to stderr and stdout stays empty. --json-schema takes the schema
  // inline and delivers the verdict as the result's structured_output.
  claude: (prompt) => [
    "-p",
    "--permission-mode",
    "plan",
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    schemaText(),
    prompt,
  ],
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

const USAGE = [
  "usage: run-review.mts <codex|claude|copilot> <prompt-file> [--background] [--stdin-prompt] [--stall <seconds>] [--criteria <names>|none]",
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
  "codex whose bubblewrap sandbox cannot start reviews an unsandboxed snapshot copy of the repository inside its scratch dir",
  "a reviewer silent for --stall seconds (default 900) is killed with its process group and the review fails as stalled: no stream event for <n> s",
  "prints: the JSON report (verdict, tool_calls, capture, trajectory, and sandbox only when codex fell back to copy mode); --background prints output-file: <path> and pid: <n>",
  "exits: 0 verdict printed, or a --background launch started (its verdict comes via --extract);",
  "       1 review FAILED - relaunch: no usable verdict, whatever the cause, a stall, or --wait timed out; never a clean pass;",
  "       2 usage error, the reviewer binary not installed, or codex's sandbox unavailable outside a git repository",
].join("\n");

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
  "stdin-prompt": { type: "boolean" },
  capture: { type: "string" },
  stall: { type: "string" },
  criteria: { type: "string" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
} as const;

const LAUNCH_FLAGS = ["background", "stdin-prompt", "capture", "stall", "criteria"] as const;
const EXTRACT_FLAGS = ["wait", "timeout"] as const;
const STALL_STATUS = /^stalled: /;
const MINT_MARKER = ".minted-by-run-review";
const SECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION_FILES = [
  "ORIG_HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
];

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

interface Delivery {
  /** The reviewer's argv for the codex sandbox the launch settled on; claude and copilot ignore the argument. */
  args: (sandbox: CodexSandbox) => string[];

  /** null: the prompt travels as argv and stdin is 'ignore'; otherwise the file served as the reviewer's stdin, EOF-terminated and complete by construction. */
  stdinFile: string | null;
}

function argvDelivery(tool: Tool, prompt: string): Delivery {
  return { args: (sandbox) => TOOL_ARGS[tool](prompt, sandbox), stdinFile: null };
}

/** codex reads "-" from stdin; claude -p reads stdin when no prompt argument
 * is given. copilot has no stdin form: -p requires the prompt argument. */
function stdinDelivery(tool: Tool, promptFile: string): Delivery {
  if (tool === "codex") {
    return { args: (sandbox) => TOOL_ARGS.codex("-", sandbox), stdinFile: promptFile };
  }
  if (tool === "claude") {
    return { args: (sandbox) => TOOL_ARGS.claude("", sandbox).slice(0, -1), stdinFile: promptFile };
  }
  usageError("copilot does not support --stdin-prompt (-p requires the prompt as an argument)");
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

interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
}

/** Runs one git command and returns its stdout. A failure throws, naming the
 * command and what git said; with `absentOk`, exit 1 is git's "nothing to
 * say" (`config --get` of an unset key) and returns null. Node passes `input`
 * only through a piped stdin (an ignored one drops it; bun passes it either
 * way). */
function git(args: string[], options?: GitOptions & { absentOk?: false }): Buffer;
function git(args: string[], options: GitOptions & { absentOk: true }): Buffer | null;
function git(args: string[], options: GitOptions & { absentOk?: boolean } = {}): Buffer | null {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: Number.MAX_SAFE_INTEGER,
  });
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && options.absentOk === true) return null;
  const detail = result.error?.message ?? result.stderr.toString().trim();
  throw new Error(`git ${args.join(" ")}: ${detail}`);
}

/** The copy is what git has committed or would commit, its object store
 * shared with the checkout through an alternates link, so `git diff --cached`
 * and `git diff <base>...HEAD` there show the change the prompt names. A
 * `cp -a` of the toplevel also carried the ignored trees (virtualenvs, nested
 * worktrees) and failed midway on a checkout of gigabytes; a linked worktree
 * is no copy, its `.git` points into the repository. SKILL.md names what
 * travels and what stays behind. */
function snapshotRepository(
  launch: Extract<Launch, { sandbox: "copy" }>,
  scratch: Scratch,
  warn: (line: string) => void,
) {
  const copy = join(scratch.dir, "repo");
  try {
    buildSnapshot(copy);
  } catch (error) {
    // A copy that failed midway is still a copy: it goes with the failure,
    // not into a capture dir that is kept for a day.
    removeTree(copy, warn);
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false as const, reason: `snapshot of ${launch.root} failed: ${detail}` };
  }
  // The cwd's twin is a directory inside the copy when the cwd holds something
  // tracked; from an untracked or ignored directory, or one a staged file or
  // symlink replaced (itself or an ancestor), the reviewer starts at the
  // copy's root.
  return { ok: true as const, copy, cwd: directoryInside(copy, launch.subdir) ?? copy };
}

/** The real path of `copy/subdir` when it is a directory inside the copy,
 * else null: a missing path, a path under a file (ENOTDIR), or one a staged
 * symlink on the way (the leaf or an ancestor) resolves out of the copy, into
 * the live checkout. The resolved path decides, never the lexical one. */
function directoryInside(copy: string, subdir: string): string | null {
  try {
    const root = realpathSync(copy);
    const real = realpathSync(join(copy, subdir));
    const inside = real === root || real.startsWith(`${root}${sep}`);
    return inside && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The remote's effective fetch URL (the first of several, `insteadOf`
 * applied), made absolute when it is a relative local path, since the copy
 * lives elsewhere. git reads such a path from the top level, and its local
 * transport is a chdir into the path and a discovery there, so the same
 * chdir asks git for the repository it finds (symlinks and `..` as the
 * kernel reads them). A `~` path git expands itself, in the copy too, and a
 * path with no repository is left as it is. */
function absoluteRemoteUrl(remote: string): string {
  const url = git(["ls-remote", "--get-url", remote]).toString().trim();
  const isLocalPath = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^[^/]+:/.test(url);
  if (!isLocalPath || isAbsolute(url) || url.startsWith("~")) return url;
  const top = git(["rev-parse", "--show-toplevel"]).toString().trim();
  const discover = [
    "-C",
    top,
    "-C",
    url,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ];
  try {
    return git(discover, { env: withoutGitEnv(process.env) })
      .toString()
      .trim();
  } catch {
    return url;
  }
}

/** The config that makes the copy fetch from the checkout's promisor remotes
 * as the checkout would (a partial clone reads a blob it lacks from them on
 * first use): each promisor remote's flag, its effective fetch URL, and its
 * partial-clone filter. git answers every question, so its boolean spellings
 * and URL rewrites hold. */
function promisorConfig(): [string, string][] {
  const config: [string, string][] = [];
  for (const remote of git(["remote"]).toString().split("\n").filter(Boolean)) {
    const promisorKey = `remote.${remote}.promisor`;
    const promisor = git(["config", "--type=bool", "--get", promisorKey], { absentOk: true });
    if (promisor?.toString().trim() !== "true") continue;
    config.push([promisorKey, "true"]);
    config.push([`remote.${remote}.url`, absoluteRemoteUrl(remote)]);
    const filterKey = `remote.${remote}.partialclonefilter`;
    const filter = git(["config", "--get", filterKey], { absentOk: true });
    if (filter !== null) config.push([filterKey, filter.toString().trim()]);
  }
  return config;
}

/** Reads of the checkout run where the launcher runs, with its environment:
 * a `GIT_DIR` there, relative or absolute, may be how the caller names the
 * repository. Every write into the copy drops the `GIT_*` variables, or it
 * would land in the checkout. */
function buildSnapshot(copy: string): void {
  const read = (...args: string[]) => git(args).toString().trim();
  const copyEnv = withoutGitEnv(process.env);
  const write = (args: string[], input?: Buffer) => git(args, { cwd: copy, env: copyEnv, input });

  const objectFormat = read("rev-parse", "--show-object-format");
  const objects = read("rev-parse", "--path-format=absolute", "--git-path", "objects");
  const shallow = read("rev-parse", "--path-format=absolute", "--git-path", "shallow");
  const index = read("rev-parse", "--path-format=absolute", "--git-path", "index");
  const gitDir = read("rev-parse", "--absolute-git-dir");
  const refs = git(["for-each-ref", "--format=update %(refname) %(objectname)"]);
  // Empty for a detached HEAD; an unborn branch has a name and no commit.
  const branch = read("branch", "--show-current");

  mkdirSync(copy);
  write(["init", "-q", `--object-format=${objectFormat}`]);
  writeFileSync(join(copy, ".git", "objects", "info", "alternates"), `${objects}\n`);
  // A shallow clone's boundary travels too, or a walk of the history in the
  // copy dies at the first missing parent.
  if (existsSync(shallow)) copyFileSync(shallow, join(copy, ".git", "shallow"));
  write(["update-ref", "--stdin"], refs);
  if (branch === "") {
    write(["update-ref", "--no-deref", "HEAD", read("rev-parse", "--verify", "HEAD")]);
  } else {
    write(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }
  // A branch diff in the copy may need a blob the checkout never read (a base
  // blob of a partial clone): with the promisor remotes along, the copy fetches
  // it as the checkout would, into its own store.
  for (const [key, value] of promisorConfig()) {
    write(["config", key, value]);
  }
  // Outside refs/, yet a prompt may name one as a diff base: the tip before a reset or rebase, the last fetch, the heads of an operation in progress.
  for (const name of REVISION_FILES) {
    if (existsSync(join(gitDir, name))) copyFileSync(join(gitDir, name), join(copy, ".git", name));
  }
  // The index file itself, so an intent-to-add, skip-worktree, or unmerged
  // entry keeps its flags (a listing of the entries would stage an
  // intent-to-add file outright); a split index's shared halves sit beside it.
  if (existsSync(index)) copyFileSync(index, join(copy, ".git", "index"));
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith("sharedindex.")) copyFileSync(join(gitDir, name), join(copy, ".git", name));
  }
  // The working tree as the checkout's own: a skip-worktree entry stays
  // absent, as under sparse checkout, where a partial clone may not even hold
  // its blob. `-u` points the copied stat data at the files just written, or
  // every status re-hashes them. Large-file pointers stay pointers: a smudge
  // filter would fetch what a review never reads.
  git(["checkout-index", "-a", "-u"], { cwd: copy, env: { ...copyEnv, GIT_LFS_SKIP_SMUDGE: "1" } });
}

/** `force` skips what is missing, not what a tree's own modes refuse (a
 * populated 0555 directory copied as-is), so a refusal gets one retry with
 * every directory in the tree made writable by its owner first. What still
 * refuses is reported through `warn` and must never take the verdict or the
 * failure with it. */
function removeTree(path: string, warn: (line: string) => void): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    // retried below with the modes repaired
  }
  try {
    makeDirectoriesWritable(path);
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    warn(`not removed ${path}: ${String(error)}`);
  }
}

function makeDirectoriesWritable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) makeDirectoriesWritable(join(path, entry.name));
  }
}

/** `GIT_DIR` and its siblings name the real repository by absolute path, and
 * `GIT_CONFIG_COUNT` with a `core.worktree` entry does the same by another
 * route, so a reviewer inheriting any `GIT_*` variable could read the live
 * index from inside the copy. Discovery from the copy's cwd is what the
 * snapshot is for, so none of them travel. */
function withoutGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith("GIT_")) stripped[name] = value;
  }
  return stripped;
}

const CODEX_HOME_FILES = ["config.toml", "auth.json"];
const CODEX_AUTH_FILE = "auth.json";
const CODEX_SESSIONS_DIR = "sessions";

/** Absolute, since the sessions link below is read from inside the scratch home, not from the cwd. */
function realCodexHome(): string {
  return resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
}

/** Fills `home` (already created) as the reviewer's scratch CODEX_HOME. codex marks the directory it is launched
 * in as a trusted project by writing a block into its config file, and a copy has a fresh path every review, so
 * the user's own config would grow by one block per run; in the scratch home the trust write dies with it.
 *
 *   config.toml, auth.json  -> copied, each only when it exists
 *   sessions/               -> linked to the user's own (created if missing): the transcripts codex writes there are the user's review logs
 *
 * Everything else codex writes (its sqlite state, the trust block) stays scratch.
 * Returns the credentials bytes as copied, so a later refresh is told apart from them. */
function fillCodexHome(home: string): Buffer | null {
  const real = realCodexHome();
  let auth: Buffer | null = null;
  for (const name of CODEX_HOME_FILES) {
    const source = join(real, name);
    if (!statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    copyFileSync(source, join(home, name));
    if (name === CODEX_AUTH_FILE) auth = readFileSync(join(home, name));
  }
  const realSessions = join(real, CODEX_SESSIONS_DIR);
  mkdirSync(realSessions, { recursive: true });
  symlinkSync(realSessions, join(home, CODEX_SESSIONS_DIR));
  return auth;
}

/** codex refreshes expiring login tokens into auth.json and expects the
 * refreshed file to persist, so a scratch copy that changed goes back to the
 * user's home by write-then-rename. Only when the user's file still holds the
 * bytes this review copied: a parallel review that refreshed first must not
 * be rolled back by an unchanged or older copy. The config never goes back:
 * its only change is the trust block the scratch home exists to absorb. */
function returnRefreshedAuth(
  home: string,
  original: Buffer | null,
  warn: (line: string) => void,
): void {
  if (original === null) return;
  const scratchAuth = join(home, CODEX_AUTH_FILE);
  const realAuth = join(realCodexHome(), CODEX_AUTH_FILE);
  if (!statSync(scratchAuth, { throwIfNoEntry: false })?.isFile()) return;
  if (!statSync(realAuth, { throwIfNoEntry: false })?.isFile()) return;
  try {
    const refreshed = readFileSync(scratchAuth);
    if (refreshed.equals(original)) return;
    if (!readFileSync(realAuth).equals(original)) {
      warn(
        `codex credentials changed elsewhere during the review; the scratch refresh is not returned to ${realAuth}`,
      );
      return;
    }
    const pending = `${realAuth}.rubber-duck-tmp`;
    writeFileSync(pending, refreshed, { mode: 0o600 });
    renameSync(pending, realAuth);
  } catch (error) {
    warn(`refreshed codex credentials not returned to ${realAuth}: ${String(error)}`);
  }
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
  /** Fires once, on the reviewer's first stdout byte. */
  onLife?: () => void;

  /** The copy mode's progress line: the refusal and where the copy lives. */
  onFallback?: (message: string) => void;

  /** The reviewer never ran: the spawn failed, or in copy mode the snapshot or the scratch home did; onDone never follows it. */
  onSpawnError: (error: Error) => void;

  /** Receives the recorded status: "0" is the only success. */
  onDone: (status: string) => void;
}

/** The descriptors one run holds until it settles: the stream capture, its stderr, and the prompt file when the delivery is by stdin. */
interface CaptureFds {
  out: number;
  err: number;
  stdin: number | null;
}

/** What the copy mode adds to a run: the snapshot and the cwd inside it, and the scratch CODEX_HOME with the credentials as copied. */
interface CopyMode {
  copy: string;
  cwd: string;
  codexHome: string;
  originalAuth: Buffer | null;
}

/** What the stream watcher needs of its run: where the bytes go, what the close handler records, and what settling releases. */
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

function openCaptureFds(delivery: Delivery, scratch: Scratch): CaptureFds {
  let stdin: number | null = null;
  if (delivery.stdinFile !== null) {
    try {
      stdin = openSync(delivery.stdinFile, "r");
    } catch (error) {
      usageError(`cannot open prompt file for stdin delivery: ${String(error)}`);
    }
  }

  return { out: openSync(scratch.outFile, "w"), err: openSync(scratch.errFile, "w"), stdin };
}

/** A failure removes what was built and names it, for the caller to report as a spawn failure. The home's
 * path is fixed before it is filled, so a fill that fails midway is removed with the copy. */
function prepareCopyMode(
  launch: Extract<Launch, { sandbox: "copy" }>,
  scratch: Scratch,
  warn: (line: string) => void,
): { ok: true; copyMode: CopyMode } | { ok: false; reason: string } {
  const snapshot = snapshotRepository(launch, scratch, warn);
  if (!snapshot.ok) return snapshot;

  const codexHome = join(scratch.dir, "codex-home");
  try {
    mkdirSync(codexHome);
    const originalAuth = fillCodexHome(codexHome);
    return {
      ok: true,
      copyMode: { copy: snapshot.copy, cwd: snapshot.cwd, codexHome, originalAuth },
    };
  } catch (error) {
    removeTree(snapshot.copy, warn);
    removeTree(codexHome, warn);
    return { ok: false, reason: `scratch codex home failed: ${String(error)}` };
  }
}

/** Let go together on every path, the copy and the scratch home first: the home holds copied credentials, and
 * a token codex refreshed there goes back to the user's before it dies. */
function releaseRun(
  fds: CaptureFds,
  copyMode: CopyMode | null,
  warn: (line: string) => void,
): void {
  if (copyMode !== null) {
    removeTree(copyMode.copy, warn);
    returnRefreshedAuth(copyMode.codexHome, copyMode.originalAuth, warn);
    removeTree(copyMode.codexHome, warn);
  }

  closeSync(fds.out);
  closeSync(fds.err);
  if (fds.stdin !== null) closeSync(fds.stdin);
}

/** Every byte from the reviewer winds the stall clock and lands in the capture. When the clock runs out, the
 * reviewer's whole process group is killed and the run is a stall: a stuck browser-extension host codex spawned
 * once held a silent review for three hours while a 3600 s wait ran. A spawn failure emits 'error' and may still
 * emit 'close', so the run settles once. */
function watchReviewer(child: ReturnType<typeof spawn>, run: Run, hooks: ReviewerHooks): void {
  let sawLife = false;
  let stalled = false;
  let stallClock: ReturnType<typeof setTimeout> | null = null;
  const windStallClock = () => {
    if (stallClock !== null) clearTimeout(stallClock);
    stallClock = setTimeout(() => {
      stalled = true;
      run.warn(
        `review stalled: no stream event for ${run.stallSeconds} s; killing the reviewer (pid ${child.pid})`,
      );
      killTree(child, "SIGKILL");
    }, run.stallSeconds * 1000);
  };
  windStallClock();

  // stdio[1] and stdio[2] are "pipe" in runReviewer's spawn call, so both streams
  // exist; the null in their types only covers other stdio configurations.
  child.stdout!.on("data", (chunk: Buffer) => {
    if (!sawLife) {
      sawLife = true;
      hooks.onLife?.();
    }
    windStallClock();
    writeFileSync(run.fds.out, chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    windStallClock();
    writeFileSync(run.fds.err, chunk);
  });

  let settled = false;
  const settle = (handle: () => void) => {
    if (settled) return;
    settled = true;
    if (stallClock !== null) clearTimeout(stallClock);
    releaseRun(run.fds, run.copyMode, run.warn);
    handle();
  };
  child.on("error", (error) => {
    settle(() => hooks.onSpawnError(error));
  });
  child.on("close", (code) => {
    settle(() => {
      const status = stalled
        ? `stalled: no stream event for ${run.stallSeconds} s`
        : String(code ?? "signal");
      recordStatus(run.scratch, run.tool, { criteria: run.criteria, status, sandbox: run.sandbox });
      hooks.onDone(status);
    });
  });
}

function runReviewer(
  tool: Tool,
  launch: Launch,
  delivery: Delivery,
  scratch: Scratch,
  rules: Rules,
  hooks: ReviewerHooks,
): ReturnType<typeof spawn> | null {
  const criteria = rules.criteria.map((entry) => entry.name);
  const fds = openCaptureFds(delivery, scratch);
  const sandbox = launch.sandbox === "copy" ? "copy" : undefined;
  recordStatus(scratch, tool, { criteria, sandbox });
  // A warning lands in review.err, which outlives the run and is named by a
  // failure, as well as on stderr (ignored for a detached monitor).
  const warn = (line: string) => {
    writeFileSync(fds.err, `${line}\n`);
    process.stderr.write(`${line}\n`);
  };

  let copyMode: CopyMode | null = null;
  let args = delivery.args("read-only");
  let env: NodeJS.ProcessEnv | undefined;
  if (launch.sandbox === "copy") {
    const built = prepareCopyMode(launch, scratch, warn);
    if (!built.ok) {
      releaseRun(fds, null, warn);
      hooks.onSpawnError(new Error(built.reason));
      return null;
    }
    copyMode = built.copyMode;
    env = { ...withoutGitEnv(process.env), CODEX_HOME: copyMode.codexHome };
    args = delivery.args("danger-full-access");
    hooks.onFallback?.(
      `codex sandbox unavailable (${launch.reason}): reviewing an unsandboxed snapshot copy at ${copyMode.copy}`,
    );
  }

  // spawn can also throw synchronously (e.g. a NUL byte in an argv element);
  // that must reach onSpawnError like an async spawn failure, not crash.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(tool, args, {
      cwd: copyMode?.cwd,
      env,
      stdio: [fds.stdin ?? "ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    releaseRun(fds, copyMode, warn);
    hooks.onSpawnError(error instanceof Error ? error : new Error(String(error)));
    return null;
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
  watchReviewer(child, run, hooks);
  return child;
}

function runForeground(
  tool: Tool,
  launch: Launch,
  delivery: Delivery,
  scratch: Scratch,
  rules: Rules,
): ReturnType<typeof spawn> | null {
  return runReviewer(tool, launch, delivery, scratch, rules, {
    onLife: () => process.stderr.write("review stream alive\n"),
    onFallback: (message) => process.stderr.write(`${message}\n`),
    onSpawnError: (error) => {
      // Nothing was captured; a retained empty scratch dir would be noise.
      removeTree(scratch.dir, (line) => process.stderr.write(`${line}\n`));
      if (isEnoent(error)) {
        process.stderr.write(`reviewer binary not found: ${tool}\n`);
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
  tool: Tool,
  launch: Launch,
  delivery: Delivery,
  scratch: Scratch,
  rules: Rules,
): ReturnType<typeof spawn> | null {
  return runReviewer(tool, launch, delivery, scratch, rules, {
    onSpawnError: (error) => {
      recordStatus(scratch, tool, {
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
  stdinPrompt: boolean,
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
  if (stdinPrompt) monitorArgs.push("--stdin-prompt");
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
    process.stderr.write(`reviewer binary not found: ${tool}\n`);
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
  stdinPrompt: boolean;
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
    stdinPrompt: values["stdin-prompt"] === true,
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
  const delivery = options.stdinPrompt
    ? stdinDelivery(tool, promptSnapshot)
    : argvDelivery(tool, fullPrompt);
  if (options.captureDir === null) return runForeground(tool, launch, delivery, scratch, rules);

  return runCapture(tool, launch, delivery, scratch, rules);
}

function launchCommand(tool: Tool, args: string[]): void {
  const options = launchOptions(args);
  const { background, stdinPrompt, captureDir, criteriaSpec, promptFile } = options;
  if (captureDir === null) requireMintedPrompt(promptFile);
  else requireCaptureProvenance(tool, promptFile, captureDir);
  const prompt = readPrompt(promptFile);
  // Selected in the parent of a --background launch too, so an unknown name is its usage error.
  const rules: Rules = {
    stallSeconds: options.stallSeconds,
    criteria: selectCriteria(criteriaSpec),
  };

  // stdinDelivery owns the copilot rejection; validate up front (against the
  // caller's path) so a bad tool/flag combination is a parent-side usage
  // error even for --background, not a silent failure in the monitor.
  if (stdinPrompt) stdinDelivery(tool, promptFile);
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
    runBackground(tool, launch, prompt, stdinPrompt, rules, criteriaSpec);
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
