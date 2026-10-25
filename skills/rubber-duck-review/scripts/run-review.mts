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
 *   criteria pasted by hand      -> thirty rounds passed what the house rules forbid: the launcher appends every skill's section
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
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Extraction, extractVerdict, isRecord, isTool, type Tool } from "./verdict.mts";

const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), "verdict-schema.json");
/** The installed skills: the siblings of this skill's directory, found through any install symlink. */
const SKILLS_ROOT = dirname(dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))));
const CRITERIA_HEADING = "## Review Criteria";
const COMPANION_HEADING = "## Companion review criteria";

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
  "the prompt gets a '## Companion review criteria' section: the '## Review Criteria' section of every installed skill declaring one (the siblings of this skill's directory);",
  "  --criteria <name>[,<name>] keeps the named skills' sections alone, --criteria none appends nothing; the report's criteria lists the names that went in",
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

// A timer's delay is a 32-bit count of milliseconds; past it the timer fires at once.
const MAX_TIMER_SECONDS = 2147483;
const STALL_STATUS = /^stalled: /;
const MINT_MARKER = ".minted-by-run-review";
const SECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Revision files outside refs/ that a prompt may name as a diff base: the tip before a reset or
 * rebase, the last fetch, the heads of an operation in progress. */
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
  name: string;
  body: string;
}

/** What the launch runs under beyond the sandbox: the stall clock and the criteria appended to the prompt. */
interface Rules {
  stallSeconds: number;
  criteria: Criteria[];
}

/** The text under a page's top-level `## Review Criteria` heading, up to its next `## ` heading;
 * null when the page declares none (a `## <Context> Review Criteria` is not the heading). */
function criteriaSection(page: string): string | null {
  const lines = page.split("\n");
  const start = lines.indexOf(CRITERIA_HEADING);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return rest
    .slice(0, end === -1 ? rest.length : end)
    .join("\n")
    .trim();
}

/** An entry with no SKILL.md (a file, a dangling link, a stray directory) is no skill; any other
 * failure to read one is a broken install, since a skill silently dropped is a rule silently dropped. */
function installedCriteria(): Criteria[] {
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

    const body = criteriaSection(page);
    if (body !== null) found.push({ name, body });
  }
  return found;
}

/** The criteria a launch appends: every declaring skill by default, the named ones under
 * `--criteria a,b`, none under `--criteria none`. A name that declares none is a usage error. */
function selectCriteria(spec: string | null): Criteria[] {
  const installed = installedCriteria();
  if (spec === null) return installed;
  if (spec === "none") return [];

  const chosen = spec.split(",");
  const declaring = installed.map((criteria) => criteria.name);
  const unknown = chosen.filter((name) => !declaring.includes(name));
  if (unknown.length > 0) {
    usageError(
      `--criteria: ${unknown.join(", ")} declares no ${CRITERIA_HEADING}; the installed skills that do: ${declaring.join(", ")}`,
    );
  }
  return installed.filter((criteria) => chosen.includes(criteria.name));
}

function withCriteria(prompt: string, criteria: Criteria[]): string {
  if (criteria.length === 0) return prompt;

  const sections = criteria.map(({ name, body }) => `### ${name}\n\n${body}`);
  return `${prompt.trimEnd()}\n\n${COMPANION_HEADING}\n\n${sections.join("\n\n")}\n`;
}

interface Delivery {
  /** The reviewer's argv for the codex sandbox the launch settled on; claude
   * and copilot ignore the argument. */
  args: (sandbox: CodexSandbox) => string[];
  /** null: prompt travels as argv and stdin is 'ignore'. Otherwise the file
   * served as the reviewer's stdin (EOF-terminated, complete by construction). */
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
      /** The bwrap line that refused, for the progress line and the failure. */
      reason: string;
      /** The repository root to snapshot and the cwd's path inside it. */
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

/** codex marks the directory it is launched in as a trusted project by
 * writing a block into its config file, and a copy has a fresh path every
 * review, so the user's own config would grow by one block per run. The
 * reviewer therefore gets a scratch CODEX_HOME holding copies of the user's
 * config and credentials; the trust write lands there and dies with it. */
const CODEX_HOME_FILES = ["config.toml", "auth.json"];
const CODEX_AUTH_FILE = "auth.json";
/** codex writes each review's transcript (its session rollout) under this
 * directory of its home. Those are the user's review logs, so the scratch
 * home links it to the user's own directory instead of holding a copy that
 * dies with the review. Everything else codex writes (its sqlite state, the
 * trust block) stays scratch. */
const CODEX_SESSIONS_DIR = "sessions";

/** Absolute, since the sessions link below is read from inside the scratch home, not from the cwd. */
function realCodexHome(): string {
  return resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
}

/** Fills `home` (already created) with the user's config and credentials, each only when it exists,
 * and links its sessions directory to the user's, created if missing.
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
  onLife?: () => void;
  /** The copy mode's progress line: the refusal and where the copy lives. */
  onFallback?: (message: string) => void;
  onSpawnError: (error: Error) => void;
  /** Receives the recorded status: "0" is the only success. */
  onDone: (status: string) => void;
}

/** writeSync may write FEWER bytes than asked (pipes and signal interruption
 * make short writes legal); dropping the remainder would tear the captured
 * stream, and a torn error line can then parse as a clean review. Loop until
 * every byte lands. The injectable `write` exists for the unit test, which
 * cannot force a real partial write deterministically. */
export function writeAllSync(
  fd: number,
  chunk: Buffer,
  write: (fd: number, chunk: Buffer, offset: number, length: number) => number = writeSync,
): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += write(fd, chunk, offset, chunk.length - offset);
  }
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
  const { stallSeconds } = rules;
  let stdinFd: number | null = null;
  if (delivery.stdinFile !== null) {
    try {
      stdinFd = openSync(delivery.stdinFile, "r");
    } catch (error) {
      usageError(`cannot open prompt file for stdin delivery: ${String(error)}`);
    }
  }
  const outFd = openSync(scratch.outFile, "w");
  const errFd = openSync(scratch.errFile, "w");
  const sandbox = launch.sandbox === "copy" ? "copy" : undefined;
  recordStatus(scratch, tool, { criteria, sandbox });
  // A warning lands in review.err, which outlives the run and is named by a
  // failure, as well as on stderr (ignored for a detached monitor).
  const warn = (line: string) => {
    writeAllSync(errFd, Buffer.from(`${line}\n`));
    process.stderr.write(`${line}\n`);
  };
  // The copy and the scratch codex home, when there are any, die with the
  // review on every path below: the home holds copied credentials.
  let copy: string | null = null;
  let codexHome: string | null = null;
  let originalAuth: Buffer | null = null;
  const closeFds = () => {
    if (copy !== null) removeTree(copy, warn);
    if (codexHome !== null) {
      returnRefreshedAuth(codexHome, originalAuth, warn);
      removeTree(codexHome, warn);
    }
    closeSync(outFd);
    closeSync(errFd);
    if (stdinFd !== null) closeSync(stdinFd);
  };
  let cwd: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let args = delivery.args("read-only");
  if (launch.sandbox === "copy") {
    const snapshot = snapshotRepository(launch, scratch, warn);
    if (!snapshot.ok) {
      closeFds();
      hooks.onSpawnError(new Error(snapshot.reason));
      return null;
    }
    copy = snapshot.copy;
    cwd = snapshot.cwd;
    // Assigned before it is filled, so a copy that fails midway is still removed.
    codexHome = join(scratch.dir, "codex-home");
    try {
      mkdirSync(codexHome);
      originalAuth = fillCodexHome(codexHome);
    } catch (error) {
      closeFds();
      hooks.onSpawnError(new Error(`scratch codex home failed: ${String(error)}`));
      return null;
    }
    env = { ...withoutGitEnv(process.env), CODEX_HOME: codexHome };
    args = delivery.args("danger-full-access");
    hooks.onFallback?.(
      `codex sandbox unavailable (${launch.reason}): reviewing an unsandboxed snapshot copy at ${copy}`,
    );
  }
  // spawn can also throw synchronously (e.g. a NUL byte in an argv element);
  // that must reach onSpawnError like an async spawn failure, not crash.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(tool, args, {
      cwd,
      env,
      stdio: [stdinFd ?? "ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    closeFds();
    hooks.onSpawnError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  let sawLife = false;
  let stalled = false;
  let stallClock: ReturnType<typeof setTimeout> | null = null;
  /** Every byte from the reviewer winds the clock. When it runs out, the reviewer's whole
   * process group is killed and the run is a stall: a stuck browser-extension host codex spawned
   * once held a silent review for three hours while a 3600 s wait ran. */
  const windStallClock = () => {
    if (stallClock !== null) clearTimeout(stallClock);
    stallClock = setTimeout(() => {
      stalled = true;
      warn(
        `review stalled: no stream event for ${stallSeconds} s; killing the reviewer (pid ${child.pid})`,
      );
      killTree(child, "SIGKILL");
    }, stallSeconds * 1000);
  };
  windStallClock();
  // stdio[1] and stdio[2] are "pipe" in the spawn call above, so both streams
  // exist; the null in their types only covers other stdio configurations.
  child.stdout!.on("data", (chunk: Buffer) => {
    if (!sawLife) {
      sawLife = true;
      hooks.onLife?.();
    }
    windStallClock();
    writeAllSync(outFd, chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    windStallClock();
    writeAllSync(errFd, chunk);
  });
  // A spawn failure emits 'error' and may still emit 'close'; settle once.
  let settled = false;
  const settle = (handle: () => void) => {
    if (settled) return;
    settled = true;
    if (stallClock !== null) clearTimeout(stallClock);
    closeFds();
    handle();
  };
  child.on("error", (error) => {
    settle(() => hooks.onSpawnError(error));
  });
  child.on("close", (code) => {
    settle(() => {
      const status = stalled
        ? `stalled: no stream event for ${stallSeconds} s`
        : String(code ?? "signal");
      recordStatus(scratch, tool, { criteria, status, sandbox });
      hooks.onDone(status);
    });
  });
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

function secondsArg(flag: string, value: string | undefined): number {
  if (value === undefined || !WHOLE_SECONDS.test(value) || Number(value) > MAX_TIMER_SECONDS) {
    usageError(`${flag} requires a whole number of seconds, 1 to ${MAX_TIMER_SECONDS}`);
  }
  return Number(value);
}

/** Blocks the main thread; a timer callback could not route a usage error
 * through SilentExit, and the wait has nothing else to do. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    sleepSync(Math.min(WAIT_POLL_MS, remaining));
    record = readLaunchRecord(tool, outputFile) ?? noRecord();
  }
  reportRecordedRun(tool, outputFile, record.status, record.sandbox, record.criteria);
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
  const toolArg = argv[0];
  if (toolArg === undefined || !isTool(toolArg)) {
    usageError(`unknown reviewer: ${toolArg ?? "(none)"}`);
  }
  const tool = toolArg;
  const rest = argv.slice(1);

  if (rest[0] === "--extract") {
    let wait = false;
    let timeoutSeconds: number | null = null;
    const files: string[] = [];
    for (let i = 1; i < rest.length; i += 1) {
      const arg = rest[i] as string;
      if (arg === "--wait") wait = true;
      else if (arg === "--timeout") {
        i += 1;
        timeoutSeconds = secondsArg(arg, rest[i]);
      } else if (arg === "--stall" || arg === "--criteria") {
        usageError(`${arg} applies only to a launch`);
      } else if (arg.startsWith("--")) usageError(`unknown flag: ${arg}`);
      else files.push(arg);
    }
    if (timeoutSeconds !== null && !wait) usageError("--timeout applies only to --extract --wait");
    const outputFile = files[0];
    if (outputFile === undefined || files.length !== 1) {
      usageError("--extract takes exactly one <output-file>");
    }
    if (wait) extractAfterWait(tool, outputFile, timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS);
    else extractRecorded(tool, outputFile);
    return;
  }

  let background = false;
  let stdinPrompt = false;
  let captureDir: string | null = null;
  let stallSeconds = DEFAULT_STALL_SECONDS;
  let criteriaSpec: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--background") background = true;
    else if (arg === "--stdin-prompt") stdinPrompt = true;
    else if (arg === "--capture") {
      i += 1;
      captureDir = rest[i] ?? usageError("--capture requires a directory");
    } else if (arg === "--stall") {
      i += 1;
      stallSeconds = secondsArg(arg, rest[i]);
    } else if (arg === "--criteria") {
      i += 1;
      criteriaSpec = rest[i] ?? usageError("--criteria requires <name>[,<name>] or none");
    } else if (arg === "--wait" || arg === "--timeout") {
      usageError(`${arg} applies only to --extract`);
    } else if (arg.startsWith("--")) usageError(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (background && captureDir !== null) {
    usageError("--background and --capture are mutually exclusive");
  }
  const promptFile = positional[0];
  if (promptFile === undefined || positional.length !== 1) {
    usageError("expected exactly one <prompt-file>");
  }
  if (captureDir === null) requireMintedPrompt(promptFile);
  else requireCaptureProvenance(tool, promptFile, captureDir);
  let prompt: string;
  try {
    prompt = readFileSync(promptFile, "utf-8");
  } catch (error) {
    usageError(`cannot read prompt file ${promptFile}: ${String(error)}`);
  }
  if (prompt.trim() === "") usageError(`prompt file is empty: ${promptFile}`);
  // Selected in the parent of a --background launch too, so an unknown name is its usage error.
  const rules: Rules = { stallSeconds, criteria: selectCriteria(criteriaSpec) };

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
  const scratch = scratchPaths(captureDir ?? mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)), tool);
  // Snapshot the prompt, criteria appended, into the scratch dir (in capture
  // mode this rewrites the snapshot the parent already made): everything the
  // launcher writes, including any code excerpts in the prompt, lives and dies
  // with the capture. The caller's own prompt file stays theirs.
  const fullPrompt = withCriteria(prompt, rules.criteria);
  const promptSnapshot = join(scratch.dir, "prompt.txt");
  writeFileSync(promptSnapshot, fullPrompt);
  const delivery = stdinPrompt
    ? stdinDelivery(tool, promptSnapshot)
    : argvDelivery(tool, fullPrompt);
  const child =
    captureDir !== null
      ? runCapture(tool, launch, delivery, scratch, rules)
      : runForeground(tool, launch, delivery, scratch, rules);
  if (forwarded !== null) forwarded.child = child;
}

// Guarded so importing the exported helpers (unit tests) runs nothing.
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof SilentExit)) throw error;
  }
}
