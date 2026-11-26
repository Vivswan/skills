#!/usr/bin/env bun
// The fleet source: what each agent of a Claude Code session is stuck on, read from its transcript,
// and what moved in each worktree no agent claims, delivered by the session-events daemon installed
// beside this skill. An alert is a message to the lead; a note is a line in the events log, read
// with `wait`, and `status` lists the alerts in force. The daemon says what holds and for how long;
// judgment stays the lead's.
//
//   bun "<skill-dir>/scripts/fleet-events.mts" daemon                              # once per session, as a BACKGROUND task
//   bun "<skill-dir>/scripts/fleet-events.mts" watch session --repo /abs/repo
//   bun "<skill-dir>/scripts/fleet-events.mts" watch /abs/session-dir --quiet-after 5

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { infer as Infer } from "zod/mini";
import type {
  EventInput,
  Io,
  Level,
  PollResult,
} from "../../session-events/scripts/session-events.mts";
import { discoverWorktrees, type WorktreeRow, worktreeRow } from "./fleet/git.mts";
import { attributeProcesses, type ProcessRow } from "./fleet/processes.mts";
import { readTail } from "./fleet/transcript-tail.mts";
import {
  type Activity,
  type Child,
  displayName,
  initialTranscript,
  isStopped,
  locateSession,
  type PendingCall,
  projectsRoot,
  readSidecar,
  readTranscript,
  realPath,
  type Sidecar,
  type Transcript,
} from "./fleet/transcripts.mts";

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
const z = await import("zod/mini");

// The command that puts the session-events skill beside this one, where the import below resolves it.
const INSTALL = "npx skills add Vivswan/skills -g --skill session-events";

// The script a user runs. The self-build runs this file as its bundle in `.build/`, beside `scripts/`.
const ENTRY = join(dirname(import.meta.dir), "scripts", "fleet-events.mts");

// The source process that spawned this bundle and waits on it; null when this file runs as source.
const WRAPPER_PID = import.meta.path.endsWith(".mts") ? null : process.ppid;

// The `--quiet-after` default; `--help` shows it, and tests/repo/usage-blocks.test.ts holds a page's fence equal to `--help`.
const DEFAULT_QUIET_AFTER_MINUTES = 10;

// An unclaimed worktree that worked is idle after this many polls with no worker and no change.
const IDLE_POLLS = 2;

// A pending call that names its own timeout is stuck this long past it.
const TOOL_GRACE_MINUTES = 10;

// A pending call that names no timeout is stuck past this plain bound.
const TOOL_STUCK_MINUTES = 30;

// A child whose own transcript has not moved for this long is stuck; a moving child never is.
const CHILD_STILL_MINUTES = 30;

// An ended turn is said once this old: its signal takes a moment to reach the one waiting on it.
const ENDED_GRACE_MINUTES = 5;

// A stillness already older than this when first judged is history, one note and never an alert; one that crosses it under the watch stays an alert.
const STALE_HOURS = 24;

// A worktree the lead's own command named stays the lead's this long after the newest such command.
const LEAD_CLAIM_MINUTES = 30;

// A stuck or idle alert is repeated as its duration doubles, this many times, then held in silence.
const MAX_REPEATS = 3;

// Where the harness keeps its per-user temp root when CLAUDE_CODE_TMPDIR names none: never the OS temp dir, which macOS puts elsewhere.
const HARNESS_TMP = "/tmp";

// The harness closes a background job's output file with this line.
const EXIT_LINE = /^\[exited with code \d+\]$/;

// Bytes read off the end of a job's output file for its exit line, which is under thirty bytes.
const OUTPUT_TAIL_BYTES = 256;

// A lone shell parked on a worktree is presence, not work; anything else beside it (a sleep too) is alive.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"]);

// Claude Code names a subagent's transcript by its agentId; the sidecar beside it is `agent-<agentId>.meta.json`.
const TRANSCRIPT_NAME = /^agent-([^/]+)\.jsonl$/;

// Sha characters an event text shows for a head; git resolves the prefix.
const SHORT_SHA = 12;

// The bounds above are in minutes, and the transcripts' ISO timestamps compare in milliseconds.
const MINUTE_MS = 60_000;

/** An alert in force: what was said, when it began, the duration said (null for one said once), and how many repeats went out. */
const STANDING = z.strictObject({
  level: z.literal("alert"),
  key: z.string(),
  text: z.string(),
  since: z.string(),
  duration: z.nullable(z.number()),
  repeats: z.number(),
});

type Standing = Infer<typeof STANDING>;

/** A note said about a state that holds (a stop, a shutdown, an ended turn whose signal arrived), so it is said once. */
const NOTED = z.strictObject({ level: z.literal("note"), key: z.string() });

/** The reducer's `PendingCall`: a tool call with no result yet. */
const PENDING_CALL = z.strictObject({
  tool: z.string(),
  at: z.string(),
  taskId: z.nullable(z.string()),
  timeoutMs: z.nullable(z.number()),
  shutdown: z.boolean(),
});

/** The reducer's `Child`: an agent this one spawned. */
const CHILD = z.strictObject({
  name: z.nullable(z.string()),
  at: z.string(),
  since: z.string(),
  outcome: z.enum(["running", "finished", "stopped"]),
  finishedAt: z.nullable(z.string()),
});

/** The reducer's `Transcript`. The reducer loads no package, so `toZod` holds the schema to its type: a key that differs, in presence or in being optional, fails the typecheck. */
const TRANSCRIPT = z.toZod<Transcript>()(
  z.strictObject({
    cursor: z.strictObject({ offset: z.number(), ino: z.nullable(z.number()), size: z.number() }),
    state: z.strictObject({
      lastMovedAt: z.nullable(z.string()),
      runSince: z.nullable(z.string()),
      runPending: z.boolean(),
      turn: z.enum(["open", "ended"]),
      pending: z.record(z.string(), PENDING_CALL),
      jobs: z.record(z.string(), z.strictObject({ at: z.string() })),
      children: z.record(z.string(), CHILD),
      stops: z.record(z.string(), z.string()),
      named: z.record(z.string(), z.string()),
      lines: z.number(),
      skipped: z.number(),
    }),
  }),
);

/** The reducer's `Sidecar`: who an agent is and where it works, as `readSidecar` read it from the file beside the transcript. */
const SIDECAR = z.toZod<Sidecar>()(
  z.strictObject({
    name: z.nullable(z.string()),
    description: z.nullable(z.string()),
    agentType: z.nullable(z.string()),
    parentAgentId: z.nullable(z.string()),
    worktreePath: z.nullable(z.string()),
    worktreeBranch: z.nullable(z.string()),
    toolUseId: z.nullable(z.string()),
    spawnedAt: z.string(),
  }),
);

/** One agent as the daemon remembers it: the transcript cursor and state, the sidecar, and what stands said. */
const AGENT = z.strictObject({
  ...TRANSCRIPT.shape,
  path: z.string(),
  sidecar: z.nullable(SIDECAR),
  said: z.nullable(z.discriminatedUnion("level", [STANDING, NOTED])),
});

type AgentEntry = Infer<typeof AGENT>;

/** One worktree's last reading: the head, the tree size, the activity fingerprint, the dirty-tree reading, and the idle count. */
const WORKTREE = z.strictObject({
  /** The branch checked out, null on a detached head; it names the worktree in the event texts. */
  branch: z.nullable(z.string()),

  /** The head at the last reading; a different one now is a `head` note. */
  headSha: z.nullable(z.string()),

  /** Files at HEAD at the last reading; fewer than half now is a `wipe` alert. */
  treeFileCount: z.nullable(z.number()),

  /** The head and the dirty-tree reading together; a change in either is movement, the daemon's busy flag. */
  fingerprint: z.nullable(z.string()),

  /** The dirty-tree reading alone (newest dirty mtime and status hash): what the idle count watches. */
  tree: z.nullable(z.string()),

  /** Workers and shells counted at the last reading, kept with the row; the idle judgment reads the fresh count, never this. */
  processes: z.strictObject({ workers: z.number(), shells: z.number() }),

  /** Polls in a row with no worker process and an unchanged dirty tree. */
  idlePolls: z.number(),

  /** Whether a worker process or a dirty-tree change was ever seen here in this watch; a worktree that never worked never goes idle. */
  workSeen: z.boolean(),

  /** The idle alert in force, null while none is. */
  said: z.nullable(STANDING),
});

type WorktreeEntry = Infer<typeof WORKTREE>;

/** A trouble condition in force, with when it was first said. */
const STANDING_TROUBLE = z.strictObject({ text: z.string(), url: z.string(), since: z.string() });

type StandingTrouble = Infer<typeof STANDING_TROUBLE>;

/** Whole minutes, one or more: what `--quiet-after` takes, and what a saved target holds. */
const QUIET_AFTER = z.int().check(z.positive());

/** What `watch` was told: kept when the reading beside it is in another shape, so the target starts over on the same fleet. */
const CONFIG = z.object({
  /** How the target was named: `session`, found by CLAUDE_CODE_SESSION_ID, or a directory path given whole. */
  form: z.enum(["session", "dir"]),

  /** The lead's own transcript, `<project dir>/<session id>.jsonl`. */
  sessionFile: z.string(),

  /** Where Claude Code writes each subagent's transcript and sidecar, `<project dir>/<session id>/subagents`. */
  subagentsDir: z.string(),

  /** Where the harness writes this session's background job output: `<tmp root>/<project slug>/<session id>/tasks`. */
  tasksDir: z.string(),

  /** The repository whose unclaimed worktrees are read, from `--repo`; null reads the agents alone. */
  repo: z.nullable(z.string()),

  /** From `--quiet-after`: an open turn with nothing pending is stuck after this long. */
  quietAfterMinutes: QUIET_AFTER,
});

/** One watched fleet as carried from poll to poll: what `watch` was told, and the reading the polls keep. */
const TARGET = z.strictObject({
  ...CONFIG.shape,

  /** Polls done so far; an agent present at the first is not started. */
  polls: z.number(),

  /** Every fleet agent read so far, by agentId; one the listing dropped stays, its claims and its alert cleared. */
  agents: z.record(z.string(), AGENT),

  /** The lead's own transcript: its children and stops judge the agents, its named paths claim worktrees. */
  lead: TRANSCRIPT,

  /** The last reading of every unclaimed worktree, by path; one discovery no longer lists is dropped, with a `gone` note unless an agent claims it. */
  worktrees: z.record(z.string(), WORKTREE),

  /** The trouble conditions in force, by key. */
  trouble: z.record(z.string(), STANDING_TROUBLE),

  /** Whether the subagents directory has ever been listed; before the first worker is spawned it does not exist, and that is an empty fleet. */
  subagentsListed: z.boolean(),
});

type Target = Infer<typeof TARGET>;

interface Trouble {
  text: string;
  url: string;
}

type Situation =
  | { kind: "fine" }
  | { kind: "unread" }
  | { kind: "stopped" }
  | { kind: "shutdown" }
  | { kind: "tool"; id: string; tool: string; since: string }
  | { kind: "child"; id: string; name: string; moved: string; since: string }
  | { kind: "stranded"; job: string }
  | { kind: "stall"; since: string }
  | { kind: "ended"; since: string; signalled: boolean };

/** One agent's read this poll: the entry read onto a copy, or the file that failed with the sidecar the poll holds for the agent. */
type AgentRead =
  | { ok: true; entry: AgentEntry; moved: boolean }
  | { ok: false; file: string; reason: string; sidecar: Sidecar | null };

interface WorktreeActivity {
  working: boolean;
  workSeen: boolean;
  idle: boolean;
  idlePolls: number;
}

/** The process reading over the discovered worktrees; `attributionOk` is false under a degraded or downed lsof, when no process list is verified. */
interface ProcessReading {
  processesByWorktree: Map<string, ProcessRow[]>;
  attributionOk: boolean;
}

/** A read the whole poll depends on failed, so nothing this poll saw can be judged; `key` names the condition in the trouble ledger. */
class FleetReadError extends Error {
  constructor(
    readonly key: string,
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

let base: typeof import("../../session-events/scripts/session-events.mts");
try {
  base = await import("../../session-events/scripts/session-events.mts");
} catch {
  console.error(
    `the session-events skill is not installed beside this one; install it beside this skill: ${INSTALL}`,
  );
  process.exit(2);
}
const { runEvents, UsageError } = base;

function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

function minutesBetween(nowMs: number, at: string): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(at)) / MINUTE_MS));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A comparator by the time `since` reads off an entry, oldest first. */
function byTime<T>(since: (entry: T) => string): (a: T, b: T) => number {
  return (a, b) => Date.parse(since(a)) - Date.parse(since(b));
}

// --- the target -------------------------------------------------------------------

function flagValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  return value;
}

function repoOf(value: string): string {
  if (!isAbsolute(value)) throw new UsageError(`--repo must be an absolute path, got: ${value}`);
  return resolve(value);
}

function quietAfterOf(value: string): number {
  const minutes = QUIET_AFTER.safeParse(/^\d+$/.test(value) ? Number(value) : null);
  if (!minutes.success) {
    throw new UsageError(`--quiet-after must be a positive whole number of minutes, got: ${value}`);
  }
  return minutes.data;
}

function parseFlags(flags: string[]): { repo: string | null; quietAfterMinutes: number } {
  let repo: string | null = null;
  let quietAfterMinutes = DEFAULT_QUIET_AFTER_MINUTES;
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i] as string;
    if (flag !== "--repo" && flag !== "--quiet-after") {
      throw new UsageError(`unknown option: ${flag}`);
    }

    const value = flagValue(flag, flags[i + 1]);
    if (flag === "--repo") repo = repoOf(value);
    else quietAfterMinutes = quietAfterOf(value);
  }
  return { repo, quietAfterMinutes };
}

/** The harness's tasks directory for a session: its temp root (`CLAUDE_CODE_TMPDIR`, else `/tmp` whatever the OS temp dir is), `claude-<uid>`, the project slug, the session id, `tasks`. */
function tasksDirOf(sessionDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = join(env.CLAUDE_CODE_TMPDIR || HARNESS_TMP, `claude-${process.getuid?.() ?? 0}`);
  return join(root, basename(dirname(sessionDir)), basename(sessionDir), "tasks");
}

/** A target's reading before its first poll: nothing read, nothing said. */
function emptyReading(): Omit<Target, keyof typeof CONFIG.shape> {
  return {
    polls: 0,
    agents: {},
    lead: initialTranscript(),
    worktrees: {},
    trouble: {},
    subagentsListed: false,
  };
}

/** `session` resolves here, in the CLI process, by the session id under the user's home; a path must be an existing absolute directory. */
function parseTarget(args: string[]): Target {
  const [text, ...flags] = args;
  const options = parseFlags(flags);

  let form: Target["form"];
  let paths: { sessionFile: string; subagentsDir: string };
  if (text === "session") {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    if (sessionId === undefined || sessionId === "") {
      throw new UsageError(
        "CLAUDE_CODE_SESSION_ID is unset: not a Claude Code session; pass the session directory instead",
      );
    }
    form = "session";
    const home = homedir();
    const found = locateSession(sessionId, home, process.cwd());
    if (found === null) {
      throw new UsageError(
        `no transcript ${sessionId}.jsonl under ${projectsRoot(home)}: CLAUDE_CODE_SESSION_ID names a session this home has not written`,
      );
    }
    paths = found;
  } else {
    const dir = text as string;
    if (!isAbsolute(dir))
      throw new UsageError(`target must be session or an absolute path, got: ${dir}`);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new UsageError(`not a directory: ${dir}`);
    }
    form = "dir";
    const sessionDir = resolve(dir);
    paths = {
      sessionFile: join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`),
      subagentsDir: join(sessionDir, "subagents"),
    };
  }

  return {
    form,
    ...paths,
    tasksDir: tasksDirOf(dirname(paths.subagentsDir)),
    ...options,
    ...emptyReading(),
  };
}

// --- the agents -------------------------------------------------------------------

function agentName(agentId: string, entry: AgentEntry | undefined): string {
  return oneLine(displayName(agentId, entry?.sidecar ?? null));
}

/** The fleet agent a pending Agent call spawned, joined through the child's sidecar `toolUseId`: one read, or one listed whose read failed this poll. */
function childOfCall(
  target: Target,
  toolUseId: string,
  failed: ReadonlyMap<string, Sidecar | null>,
): string | undefined {
  const known = Object.keys(target.agents).find(
    (agentId) => target.agents[agentId]?.sidecar?.toolUseId === toolUseId,
  );
  if (known !== undefined) return known;
  for (const [agentId, sidecar] of failed) {
    if (sidecar?.toolUseId === toolUseId) return agentId;
  }
  return undefined;
}

/**
 * The activity of whoever spawned this agent and waits on its signal: the lead's for a sidecar
 * naming no parent or the lead's session, else the fleet agent named, undefined when the fleet
 * never read it.
 */
function parentState(target: Target, entry: AgentEntry): Activity | undefined {
  const parent = entry.sidecar?.parentAgentId ?? null;
  if (parent === null || parent === basename(target.sessionFile, ".jsonl")) {
    return target.lead.state;
  }
  return target.agents[parent]?.state;
}

/**
 * When a child last moved, if its transcript has been still past the bound; null for a moving
 * child or one the fleet has no reading of. A child whose read failed this poll is `unread`: its
 * cached activity is stale, so the parent is not judged from it.
 */
function stillChild(
  target: Target,
  childId: string,
  nowMs: number,
  failed: ReadonlyMap<string, Sidecar | null>,
): string | null | "unread" {
  if (failed.has(childId)) return "unread";
  const moved = target.agents[childId]?.state.lastMovedAt ?? null;
  if (moved === null || nowMs - Date.parse(moved) < CHILD_STILL_MINUTES * MINUTE_MS) return null;
  return moved;
}

/**
 * Whether the harness has closed the job's output file: its last line is the exit line. A file
 * not there yet is a job still running; one that cannot be read is logged and read as running. A
 * job whose own last line spells that footer reads as ended too: the bytes alone say who wrote them.
 */
function jobEnded(path: string, io: Io): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      io.log(`${path}: ${reasonOf(error)}`);
    }
    return false;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const last = readTail(fd, stat.size, OUTPUT_TAIL_BYTES).trimEnd().split("\n").at(-1) ?? "";
    return EXIT_LINE.test(last);
  } finally {
    closeSync(fd);
  }
}

// A finish closes the run it reached the parent in. A message from a sibling resumes the agent in
// its own transcript alone (the sender's map moves, the parent's does not), so a run begun after
// the finish is judged on its own. The run's start is its first assistant line, stamped when
// written; an input's own stamp can be its enqueue time, well behind, and an input still waiting
// for its first line leaves the known start in place.
function finishHolds(child: Child, state: Activity): boolean {
  if (child.outcome !== "finished") return false;
  if (child.finishedAt === null || state.runSince === null) return true;
  return Date.parse(state.runSince) <= Date.parse(child.finishedAt);
}

/**
 * Whether the agent's finish reached the one waiting on it: a spawned child is finished in its
 * parent's child map (an idle notification, a task notice) with no newer input of its own; a
 * foreground child's result closed the parent's call that spawned it. Nothing read of the parent
 * is no signal.
 */
function signalReached(target: Target, agentId: string, entry: AgentEntry): boolean {
  const waiting = parentState(target, entry);
  if (waiting === undefined) return false;
  const child = waiting.children[agentId];
  if (child !== undefined) return finishHolds(child, entry.state);
  const call = entry.sidecar?.toolUseId ?? null;
  return call !== null && !Object.hasOwn(waiting.pending, call);
}

/** The stuck bound of a pending call: its own timeout plus the grace, or the plain bound when it names none. */
function callBoundMs(call: PendingCall): number {
  if (call.timeoutMs === null) return TOOL_STUCK_MINUTES * MINUTE_MS;
  return call.timeoutMs + TOOL_GRACE_MINUTES * MINUTE_MS;
}

/** What a child the agent waits on says: still past the bound, unread when its read failed this poll, null while it moves. */
function childSituation(
  target: Target,
  childId: string,
  since: string,
  nowMs: number,
  failed: ReadonlyMap<string, Sidecar | null>,
): Situation | null {
  const moved = stillChild(target, childId, nowMs, failed);
  if (moved === "unread") return { kind: "unread" };
  if (moved === null) return null;
  return {
    kind: "child",
    id: childId,
    name: agentName(childId, target.agents[childId]),
    moved,
    since,
  };
}

/** What the pending calls say, oldest first: a call on a fleet child still past the bound, or any other call past its bound; fine while every call is within bounds; null with none pending. */
function pendingSituation(
  target: Target,
  state: Activity,
  nowMs: number,
  failed: ReadonlyMap<string, Sidecar | null>,
): Situation | null {
  const pending = Object.entries(state.pending).sort(byTime(([, call]) => call.at));
  for (const [id, call] of pending) {
    const childId = call.tool === "Agent" ? childOfCall(target, id, failed) : undefined;
    if (childId !== undefined) {
      const child = childSituation(target, childId, call.at, nowMs, failed);
      if (child !== null) return child;
      continue;
    }
    if (nowMs - Date.parse(call.at) >= callBoundMs(call)) {
      return { kind: "tool", id, tool: call.tool, since: call.at };
    }
  }
  return pending.length > 0 ? { kind: "fine" } : null;
}

/** What the running children say, oldest first: one still past the bound; fine while every one moves; null with none running. */
function childrenSituation(
  target: Target,
  state: Activity,
  nowMs: number,
  failed: ReadonlyMap<string, Sidecar | null>,
): Situation | null {
  const running = Object.entries(state.children)
    .filter(([, child]) => child.outcome === "running")
    .sort(byTime(([, child]) => child.since));
  for (const [id, child] of running) {
    const situation = childSituation(target, id, child.since, nowMs, failed);
    if (situation !== null) return situation;
  }
  return running.length > 0 ? { kind: "fine" } : null;
}

/** Whether `path` is a directory this process can reach: one under a parent it cannot search is not. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the transcript has been still past `--quiet-after`, the bound an open turn is given; false for one never read. */
function quiet(target: Target, state: Activity, nowMs: number): boolean {
  if (state.lastMovedAt === null) return false;
  return nowMs - Date.parse(state.lastMovedAt) >= target.quietAfterMinutes * MINUTE_MS;
}

/** Whether the agent is idle: its turn ended, or an open turn is quiet. */
function agentIdle(target: Target, state: Activity, nowMs: number): boolean {
  return state.turn === "ended" || quiet(target, state, nowMs);
}

/**
 * What the background jobs say, oldest first: fine while the agent runs; for an idle agent,
 * stranded once one's output ended with no notice, fine while every one runs, and unread while the
 * tasks directory is not there, since no job can be read; null with none.
 */
function jobsSituation(target: Target, state: Activity, nowMs: number, io: Io): Situation | null {
  const jobs = Object.entries(state.jobs).sort(byTime(([, job]) => job.at));
  if (jobs.length === 0) return null;

  // The harness hands a running agent a job's notice at its next tool round and holds an idle agent's until its next input.
  if (!agentIdle(target, state, nowMs)) return { kind: "fine" };

  if (!isDirectory(target.tasksDir)) return { kind: "unread" };

  for (const [job] of jobs) {
    if (jobEnded(join(target.tasksDir, `${job}.output`), io)) return { kind: "stranded", job };
  }
  return { kind: "fine" };
}

/**
 * The trouble of a tasks directory that is not there while a listed agent waits on a job: every
 * such job would read as running for good, and an ended one would never be stranded. The harness
 * makes the directory with the session's first job, so its absence before any job is no trouble,
 * and a stopped or shut-down agent waits on nothing, whatever jobs its transcript left open.
 */
function jobsOutputTrouble(target: Target, listed: string[]): Trouble | null {
  const waiting = listed.some((agentId) => {
    const entry = target.agents[agentId];
    if (entry === undefined || Object.keys(entry.state.jobs).length === 0) return false;
    return stopOf(target, agentId, entry) === null;
  });
  if (!waiting || isDirectory(target.tasksDir)) return null;
  return {
    text: `fleet: cannot read job output: ${target.tasksDir} is no directory`,
    url: fileUrl(target.tasksDir),
  };
}

/** What a transcript with nothing pending says by its stillness: a stall past `--quiet-after` while the turn is open and no signal reached the one waiting, an ended turn past the grace, else fine. */
function stillnessSituation(
  target: Target,
  agentId: string,
  entry: AgentEntry,
  nowMs: number,
): Situation {
  const movedAt = entry.state.lastMovedAt;
  if (movedAt === null) return { kind: "fine" };

  const signalled = signalReached(target, agentId, entry);
  if (entry.state.turn === "open" && !signalled) {
    if (!quiet(target, entry.state, nowMs)) return { kind: "fine" };
    return { kind: "stall", since: movedAt };
  }

  const stillMs = nowMs - Date.parse(movedAt);
  if (stillMs < ENDED_GRACE_MINUTES * MINUTE_MS) return { kind: "fine" };
  return { kind: "ended", since: movedAt, signalled };
}

/** Whether the lead stopped the agent: by its id, or, for the lead's own child, by the name its sidecar gives it. */
function stoppedByLead(target: Target, agentId: string, entry: AgentEntry): boolean {
  const ownChild = parentState(target, entry) === target.lead.state;
  return isStopped(target.lead.state, agentId, ownChild ? (entry.sidecar?.name ?? null) : null);
}

/**
 * What ended the agent, null while it runs: the lead's stop, or a shutdown request it approved,
 * whose call stays pending for good since its process ended inside it.
 */
function stopOf(target: Target, agentId: string, entry: AgentEntry): "stopped" | "shutdown" | null {
  if (stoppedByLead(target, agentId, entry)) return "stopped";
  if (Object.values(entry.state.pending).some((call) => call.shutdown)) return "shutdown";
  return null;
}

/**
 * What stands for one agent now, read off its transcript against the bounds: a stop, a shutdown
 * it approved, a stuck call (past its own timeout plus the grace, or the plain bound), a child
 * still past the bound, a job whose output ended with no notice, a stall past `--quiet-after`, an
 * ended turn past the grace; else fine, which is moving or waiting within bounds. A turn the
 * transcript leaves open is over once the one waiting on the agent holds its finish: the harness
 * omits the final stop reason when a hook closes the turn, and a completed fork is never a stall.
 */
function situationOf(
  target: Target,
  agentId: string,
  entry: AgentEntry,
  nowMs: number,
  io: Io,
  failed: ReadonlyMap<string, Sidecar | null>,
): Situation {
  // A parent whose read failed this poll is stale: nothing read of it judges this agent.
  const parent = entry.sidecar?.parentAgentId ?? null;
  if (parent !== null && failed.has(parent)) return { kind: "unread" };

  const stop = stopOf(target, agentId, entry);
  if (stop !== null) return { kind: stop };

  const pending = pendingSituation(target, entry.state, nowMs, failed);
  if (pending !== null) return pending;

  const children = childrenSituation(target, entry.state, nowMs, failed);
  if (children !== null) return children;

  const jobs = jobsSituation(target, entry.state, nowMs, io);
  if (jobs !== null) return jobs;

  return stillnessSituation(target, agentId, entry, nowMs);
}

function situationKey(situation: Situation): string {
  switch (situation.kind) {
    case "fine":
    case "unread":
    case "stopped":
    case "shutdown":
      return situation.kind;
    case "tool":
      return `tool:${situation.id}`;
    case "child":
      // The run too: a child finished and resumed between two polls is a new wait, not the old one.
      return `child:${situation.id}:${situation.since}`;
    case "stranded":
      return `stranded:${situation.job}`;
    case "stall":
    case "ended":
      return `${situation.kind}:${situation.since}`;
  }
}

function situationText(name: string, situation: Situation, nowMs: number): string {
  switch (situation.kind) {
    case "fine":
      return `agent ${name}: fine again`;
    case "unread":
      return `agent ${name}: a read its judgment rests on failed`;
    case "stopped":
      return `agent ${name}: stopped by the lead`;
    case "shutdown":
      return `agent ${name}: shut down on request`;
    case "tool":
      return `agent ${name}: stuck ${minutesBetween(nowMs, situation.since)} min on ${situation.tool}`;
    case "child":
      return `agent ${name}: stuck on agent ${situation.name}, ${situation.name} last moved ${minutesBetween(nowMs, situation.moved)} min ago`;
    case "stranded":
      return `agent ${name}: stranded, job ${situation.job} ended with no notice`;
    case "stall":
      return `agent ${name}: stuck ${minutesBetween(nowMs, situation.since)} min mid-turn, nothing pending`;
    case "ended": {
      const head = `agent ${name}: ended ${minutesBetween(nowMs, situation.since)} min ago`;
      return situation.signalled
        ? `${head}, report received`
        : `${head}, no signal reached the lead`;
    }
  }
}

/** The minutes a situation's stillness has held: a stuck call or a stall since it began, a still child since it last moved, an ended turn since it ended; null for one with no duration. */
function heldMinutes(situation: Situation, nowMs: number): number | null {
  switch (situation.kind) {
    case "tool":
    case "stall":
    case "ended":
      return minutesBetween(nowMs, situation.since);
    case "child":
      return minutesBetween(nowMs, situation.moved);
    default:
      return null;
  }
}

/** The minutes a stuck situation has held, the duration its repeats double on; null for an alert said once (an ended turn, a stranded job). */
function stuckMinutes(situation: Situation, nowMs: number): number | null {
  return situation.kind === "ended" ? null : heldMinutes(situation, nowMs);
}

/** The one note for a stillness judged history: how long it has held, and that it predates the watch. */
function historyText(name: string, situation: Situation, held: number): string {
  const head = situation.kind === "ended" ? `ended ${held} min ago` : `still ${held} min`;
  return `agent ${name}: ${head}, long before this watch`;
}

/**
 * The standing alert after this reading: a new one when the key changed, the same one with a
 * repeat when its duration doubled (at most MAX_REPEATS times; never for an alert with no
 * duration), else unchanged. `announce` is whether the alert goes out this poll.
 */
function restate(
  said: Standing | null,
  key: string,
  text: string,
  duration: number | null,
  nowMs: number,
): { said: Standing; announce: boolean } {
  if (said === null || said.key !== key) {
    const since = new Date(nowMs).toISOString();
    return { said: { level: "alert", key, text, since, duration, repeats: 0 }, announce: true };
  }
  const doubled =
    duration !== null &&
    said.duration !== null &&
    said.repeats < MAX_REPEATS &&
    duration >= 2 * said.duration;
  if (!doubled) return { said, announce: false };
  return { said: { ...said, text, duration, repeats: said.repeats + 1 }, announce: true };
}

/**
 * The event for one agent this poll, or null. A stop, a shutdown, and an ended turn whose signal
 * arrived are notes, said once while they hold; a return to fine retracts a standing alert with a
 * note; an alert is said on entering and repeated as its duration doubles. A stillness already
 * past the horizon when first judged is history: a note, said once, with nothing to retract. A
 * judgment that rests on a read that failed this poll (a parent, a child, a job's output) is held:
 * nothing said, nothing changed.
 */
function agentTransition(
  target: Target,
  agentId: string,
  entry: AgentEntry,
  nowMs: number,
  io: Io,
  failed: ReadonlyMap<string, Sidecar | null>,
): EventInput | null {
  const situation = situationOf(target, agentId, entry, nowMs, io, failed);
  if (situation.kind === "unread") return null;
  const name = agentName(agentId, entry);
  const key = situationKey(situation);
  const event = (level: Level, text: string): EventInput => ({
    kind: "agent",
    level,
    text,
    url: fileUrl(entry.path),
    agentId,
  });
  const note = (text: string): EventInput | null => {
    if (entry.said?.level === "note" && entry.said.key === key) return null;
    entry.said = { level: "note", key };
    return event("note", text);
  };

  const over =
    situation.kind === "stopped" ||
    situation.kind === "shutdown" ||
    (situation.kind === "ended" && situation.signalled);
  if (over) return note(situationText(name, situation, nowMs));

  if (situation.kind === "fine") {
    const retract = entry.said?.level === "alert";
    entry.said = null;
    return retract ? event("note", situationText(name, situation, nowMs)) : null;
  }

  // History is a stillness first judged (no alert stands on it) already past the horizon: the
  // lead has nothing left to act on, and a watch started over an old session finds many.
  const standing = entry.said?.level === "alert" ? entry.said : null;
  const held = heldMinutes(situation, nowMs);
  if (standing?.key !== key && held !== null && held >= STALE_HOURS * 60) {
    return note(historyText(name, situation, held));
  }

  const next = restate(
    standing,
    key,
    situationText(name, situation, nowMs),
    stuckMinutes(situation, nowMs),
    nowMs,
  );
  entry.said = next.said;
  return next.announce ? event("alert", next.said.text) : null;
}

/** The subagents directory's entries, null while it has never existed; its absence after a listing is a failed read. */
function listSubagents(target: Target): string[] | null {
  try {
    return readdirSync(target.subagentsDir);
  } catch (error) {
    // The lead may watch before spawning anyone: a directory that has never existed is an empty
    // fleet, so the first poll happens with no agents. Once listed, its absence is a failed read.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !target.subagentsListed) return null;
    throw new FleetReadError(
      "subagents",
      `fleet: cannot list ${target.subagentsDir}: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
      fileUrl(target.subagentsDir),
    );
  }
}

/**
 * One agent's sidecar and transcript, read onto a copy of its known entry and kept only when both
 * succeed: a sidecar read that returned (null for a removed one) before the transcript read failed
 * must not reach the known entry. A failure carries the sidecar the poll holds for the agent: the
 * one just read, else the known one, else null.
 */
function readAgent(target: Target, agentId: string, name: string): AgentRead {
  const path = join(target.subagentsDir, name);
  const known = target.agents[agentId];
  const entry: AgentEntry =
    known === undefined
      ? { ...initialTranscript(), path, sidecar: null, said: null }
      : structuredClone(known);
  const sidecarName = `agent-${agentId}.meta.json`;

  try {
    entry.sidecar = readSidecar(join(target.subagentsDir, sidecarName));
  } catch (error) {
    return { ok: false, file: sidecarName, reason: reasonOf(error), sidecar: entry.sidecar };
  }

  try {
    return { ok: true, entry, moved: readTranscript(entry, path) };
  } catch (error) {
    return { ok: false, file: name, reason: reasonOf(error), sidecar: entry.sidecar };
  }
}

// The listing is the truth: an agent it no longer shows is gone, with its worktree claims (by
// sidecar and by its commands) and its standing alert; one it still shows whose read failed
// keeps its last good sidecar (the per-agent trouble).
function forgetUnlisted(target: Target, listed: ReadonlySet<string>): void {
  for (const [agentId, entry] of Object.entries(target.agents)) {
    if (listed.has(agentId)) continue;
    entry.sidecar = null;
    entry.said = null;
    entry.state.named = {};
  }
}

/**
 * Reads every transcript under the subagents dir into `target.agents` and returns the ids read
 * this poll. A read that failed is no observation: that agent is not judged from a reading nobody
 * refreshed.
 */
function readAgents(
  target: Target,
  trouble: Map<string, Trouble>,
  io: Io,
): {
  events: EventInput[];
  busy: boolean;
  refreshed: string[];
  failed: Map<string, Sidecar | null>;
} {
  const events: EventInput[] = [];
  const refreshed: string[] = [];
  // The agents whose read failed this poll, each with the sidecar the poll holds for it (the one
  // just read, else a known agent's saved one, else null): a parent's call finds a child the fleet
  // has not read yet, and holds with it.
  const failed = new Map<string, Sidecar | null>();
  let busy = false;

  const names = listSubagents(target);
  if (names === null) return { events, busy, refreshed, failed };
  target.subagentsListed = true;

  const listed = new Set<string>();
  for (const name of names.sort()) {
    const agentId = TRANSCRIPT_NAME.exec(name)?.[1];
    if (agentId === undefined) continue;
    listed.add(agentId);
    const fresh = target.agents[agentId] === undefined;
    const read = readAgent(target, agentId, name);
    if (!read.ok) {
      // A read that fails is this one agent's trouble, never the poll's: the rest of the fleet is still read.
      io.log(`${agentId}: ${read.reason}`);
      failed.set(agentId, read.sidecar);
      trouble.set(`agent:${agentId}`, {
        text: `fleet: cannot read ${read.file}: ${read.reason}`,
        url: fileUrl(join(target.subagentsDir, read.file)),
      });
      continue;
    }

    // An agent joins the fleet on its first readable poll, so its start is never lost to a failed one.
    target.agents[agentId] = read.entry;
    refreshed.push(agentId);
    busy ||= read.moved;
    if (fresh && target.polls > 0) {
      events.push({
        kind: "agent",
        level: "note",
        text: `agent ${agentName(agentId, read.entry)}: started`,
        url: fileUrl(read.entry.path),
        agentId,
      });
    }
  }

  forgetUnlisted(target, listed);
  return { events, busy, refreshed, failed };
}

// --- the worktrees ----------------------------------------------------------------

function treeOf(row: WorktreeRow & { ok: true }): string {
  return `${row.newestDirtyMtime ?? "-"} ${row.statusHash}`;
}

function fingerprintOf(row: WorktreeRow & { ok: true }): string {
  return `${row.headSha} ${treeOf(row)}`;
}

// The daemon's own rows, itself and the process that wraps it, are never workers, wherever they stand.
function countProcesses(processes: ProcessRow[]): { workers: number; shells: number } {
  let workers = 0;
  let shells = 0;
  for (const row of processes) {
    if (row.pid === process.pid || row.pid === WRAPPER_PID) continue;
    if (SHELLS.has(basename(row.command))) shells += 1;
    else workers += 1;
  }
  return { workers, shells };
}

/**
 * The worktrees agents claim, by a sidecar's path or by naming the path (or one under it) in a
 * tool call's input at any time in the watch. The lead's own tool calls claim the same way, for
 * LEAD_CLAIM_MINUTES after the newest one naming the worktree: a gate or a restack names every
 * builder's worktree in passing, and a permanent claim would hide a worker's idle line. The
 * repository's main checkout is never claimed by a command: every agent reads files there.
 */
function claimedWorktrees(
  target: Target,
  paths: string[],
  repo: string,
  nowMs: number,
): Set<string> {
  const claimed = new Set<string>();
  const checkout = realPath(resolve(repo));
  const roots = paths.map((path) => realPath(resolve(path))).filter((root) => root !== checkout);
  const claim = (named: string): void => {
    for (const root of roots) {
      if (named === root || named.startsWith(`${root}/`)) claimed.add(root);
    }
  };
  for (const entry of Object.values(target.agents)) {
    if (entry.sidecar?.worktreePath) claimed.add(realPath(resolve(entry.sidecar.worktreePath)));
    for (const named of Object.keys(entry.state.named)) claim(named);
  }
  for (const [named, at] of Object.entries(target.lead.state.named)) {
    if (nowMs - Date.parse(at) < LEAD_CLAIM_MINUTES * MINUTE_MS) claim(named);
  }
  return claimed;
}

/** The head and wipe transitions against the last reading: a head that moved is a note, a tree with under half its files at HEAD is an alert. */
function headTransitions(
  previous: WorktreeEntry | undefined,
  row: WorktreeRow & { ok: true },
  label: string,
  url: string,
): EventInput[] {
  const events: EventInput[] = [];
  if (previous?.headSha != null && previous.headSha !== row.headSha) {
    events.push({
      kind: "head",
      level: "note",
      text: `${label}: head moved to ${row.headSha.slice(0, SHORT_SHA)}`,
      url,
      worktree: row.worktree,
      sha: row.headSha,
    });
  }
  if (previous?.treeFileCount != null && row.treeFileCount < previous.treeFileCount / 2) {
    events.push({
      kind: "wipe",
      level: "alert",
      text: `${label}: ${previous.treeFileCount} files at HEAD -> ${row.treeFileCount}`,
      url,
      worktree: row.worktree,
      sha: row.headSha,
    });
  }
  return events;
}

// Work is a worker in the row or a dirty-tree change; a bare head move with a clean tree and no
// process (the lead restacking from outside) is not. Under a downed or degraded lsof an empty
// process list is not verified inactivity, so the idle count holds at zero.
function activityOf(
  previous: WorktreeEntry | undefined,
  workers: number,
  tree: string,
  attributionOk: boolean,
): WorktreeActivity {
  const working = workers > 0 || (previous !== undefined && previous.tree !== tree);
  const workSeen = (previous?.workSeen ?? false) || working;
  const idle = attributionOk && !working && previous !== undefined;
  const idlePolls = idle ? previous.idlePolls + 1 : 0;
  return { working, workSeen, idle, idlePolls };
}

/** The head, wipe, idle, and active transitions of one worktree against its last reading; the first reading says nothing. */
function worktreeTransitions(
  target: Target,
  row: WorktreeRow & { ok: true },
  attributionOk: boolean,
  nowMs: number,
): { events: EventInput[]; moved: boolean } {
  const label = `worktree ${row.branch ?? row.headSha.slice(0, SHORT_SHA)}`;
  const url = fileUrl(row.worktree);
  const fingerprint = fingerprintOf(row);
  const tree = treeOf(row);
  const processes = countProcesses(row.processes);
  const previous = target.worktrees[row.worktree];
  const moved = previous?.fingerprint !== fingerprint;
  const events = headTransitions(previous, row, label, url);
  const activity = activityOf(previous, processes.workers, tree, attributionOk);

  let said = previous?.said ?? null;
  if (said !== null && activity.working) {
    events.push({
      kind: "active",
      level: "note",
      text: `${label}: active again`,
      url,
      worktree: row.worktree,
    });
    said = null;
  }
  if (activity.idle && activity.workSeen && (said !== null || activity.idlePolls >= IDLE_POLLS)) {
    const next = restate(
      said,
      "idle",
      `${label}: idle ${activity.idlePolls} polls after work`,
      activity.idlePolls,
      nowMs,
    );
    said = next.said;
    if (next.announce) {
      events.push({ kind: "idle", level: "alert", text: said.text, url, worktree: row.worktree });
    }
  }

  target.worktrees[row.worktree] = {
    branch: row.branch,
    headSha: row.headSha,
    treeFileCount: row.treeFileCount,
    fingerprint,
    tree,
    processes,
    idlePolls: activity.idlePolls,
    workSeen: activity.workSeen,
    said,
  };
  return { events, moved };
}

/** The process reading for the unclaimed worktrees; a degraded or downed lsof is trouble, and no process list read under it is verified. */
async function processReading(
  paths: string[],
  trouble: Map<string, Trouble>,
  repo: string,
): Promise<ProcessReading> {
  const attributed = await attributeProcesses(paths);
  const lsof = attributed.lsofLine?.lsof ?? null;
  if (lsof?.ok === true) {
    trouble.set("lsof", {
      text: `fleet: process attribution degraded: ${lsof.note}`,
      url: fileUrl(repo),
    });
  }
  if (lsof?.ok === false) {
    trouble.set("lsof", {
      text: `fleet: process attribution is down: ${lsof.error}`,
      url: fileUrl(repo),
    });
  }
  return { processesByWorktree: attributed.processesByWorktree, attributionOk: lsof === null };
}

/** The `gone` note for each saved worktree the discovery no longer lists, dropped from the saved rows; one claimed since its last reading is its agent's, gone or not, and says nothing. */
function goneTransitions(
  target: Target,
  seen: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
): EventInput[] {
  const events: EventInput[] = [];
  for (const [path, entry] of Object.entries(target.worktrees)) {
    if (seen.has(path)) continue;
    delete target.worktrees[path];
    if (claimed.has(resolve(path))) continue;
    events.push({
      kind: "gone",
      level: "note",
      text: `worktree ${entry.branch ?? path}: gone`,
      url: fileUrl(path),
      worktree: path,
      sha: entry.headSha,
    });
  }
  return events;
}

async function readWorktrees(
  target: Target,
  repo: string,
  trouble: Map<string, Trouble>,
  nowMs: number,
): Promise<{ events: EventInput[]; busy: boolean }> {
  const events: EventInput[] = [];
  let busy = false;

  const discovered = await discoverWorktrees(repo);
  if (!discovered.ok) {
    throw new FleetReadError("worktrees", `fleet: ${discovered.reason}`, fileUrl(repo));
  }

  // A claimed worktree is its agent's: no reading while the claim holds, a fresh one after, and
  // no process reading at all when every worktree is claimed, so a downed lsof is trouble only
  // when an unclaimed worktree needs it. The claims are read against the rows saved too, so a
  // worktree claimed and removed between two polls says no `gone`. Attribution still runs over
  // every discovered path: a worker in a claimed nested worktree must not land on its ancestor.
  const claimed = claimedWorktrees(
    target,
    [...discovered.paths, ...Object.keys(target.worktrees)],
    repo,
    nowMs,
  );
  const unclaimed = discovered.paths.filter((path) => !claimed.has(resolve(path)));
  let reading: ProcessReading = { processesByWorktree: new Map(), attributionOk: true };
  if (unclaimed.length > 0) reading = await processReading(discovered.paths, trouble, repo);

  const seen = new Set<string>();
  for (const path of unclaimed) {
    seen.add(path);
    const row = await worktreeRow(path, null, reading.processesByWorktree.get(path) ?? []);
    if (!row.ok) {
      trouble.set(`worktree:${path}`, {
        text: `fleet: worktree ${path}: ${row.error}`,
        url: fileUrl(path),
      });
      const known = target.worktrees[path];
      if (known !== undefined) known.idlePolls = 0;
      continue;
    }
    const outcome = worktreeTransitions(target, row, reading.attributionOk, nowMs);
    events.push(...outcome.events);
    busy ||= outcome.moved;
  }

  // A successful discovery is the truth: a worktree it no longer lists is gone, said once, with
  // its last head so the lead can find the branch; a failed discovery threw above and says nothing.
  events.push(...goneTransitions(target, seen, claimed));
  return { events, busy };
}

// --- the poll ----------------------------------------------------------------------

/** The trouble events: each condition is an alert once when it begins, and a restored note once when it is gone. */
function troubleTransitions(
  target: Target,
  trouble: Map<string, Trouble>,
  nowMs: number,
): EventInput[] {
  const events: EventInput[] = [];
  const since = new Date(nowMs).toISOString();
  const ledger: Record<string, StandingTrouble> = {};
  for (const [key, { text, url }] of trouble) {
    const known = target.trouble[key];
    if (known === undefined) events.push({ kind: "trouble", level: "alert", text, url });
    ledger[key] = { text, url, since: known?.since ?? since };
  }
  for (const [key, { url }] of Object.entries(target.trouble)) {
    if (trouble.has(key)) continue;
    events.push({ kind: "restored", level: "note", text: "fleet: reading restored", url });
  }
  target.trouble = ledger;
  return events;
}

/** Every reading and judgment of one poll, on `draft`; a fleet-wide read that fails throws before anything is judged. */
async function readFleet(
  draft: Target,
  nowMs: number,
  io: Io,
): Promise<{ events: EventInput[]; busy: boolean; trouble: Map<string, Trouble> }> {
  const trouble = new Map<string, Trouble>();
  let busy = false;

  try {
    busy = readTranscript(draft.lead, draft.sessionFile);
  } catch (error) {
    const reason = reasonOf(error);
    throw new FleetReadError(
      "session",
      `fleet: cannot read the session transcript: ${reason}`,
      fileUrl(draft.sessionFile),
    );
  }

  const agents = readAgents(draft, trouble, io);
  busy ||= agents.busy;

  const worktrees =
    draft.repo === null
      ? { events: [], busy: false }
      : await readWorktrees(draft, draft.repo, trouble, nowMs);
  busy ||= worktrees.busy;

  // An agent whose read failed this poll still waits on the jobs its last reading held.
  const jobsOutput = jobsOutputTrouble(draft, [...agents.refreshed, ...agents.failed.keys()]);
  if (jobsOutput !== null) trouble.set("tasks", jobsOutput);

  const transitions: EventInput[] = [];
  for (const agentId of agents.refreshed) {
    const entry = draft.agents[agentId] as AgentEntry;
    const event = agentTransition(draft, agentId, entry, nowMs, io, agents.failed);
    if (event !== null) transitions.push(event);
  }

  draft.polls += 1;
  return { events: [...agents.events, ...transitions, ...worktrees.events], busy, trouble };
}

/** The one trouble alert of a failed fleet-wide read, said on entering; the conditions already in force stay recorded. */
function troubleOnly(target: Target, failure: FleetReadError, nowMs: number): PollResult {
  const events: EventInput[] = [];
  if (!Object.hasOwn(target.trouble, failure.key)) {
    events.push({ kind: "trouble", level: "alert", text: failure.message, url: failure.url });
    target.trouble[failure.key] = {
      text: failure.message,
      url: failure.url,
      since: new Date(nowMs).toISOString(),
    };
  }
  return { events, busy: false };
}

/**
 * The target a poll starts from: the saved one when it is in the shape this daemon writes. Any
 * other shape (another version's, a hand edit) starts the target over under its own
 * configuration, and the log says so.
 *
 * @throws {Error} the configuration is unreadable too, so nothing says what to watch
 */
function readTarget(saved: unknown, key: string, io: Io): Target {
  const read = TARGET.safeParse(saved);
  if (read.success) return read.data;

  const config = CONFIG.safeParse(saved);
  if (!config.success) {
    throw new Error(`${key}: the saved target names nothing this daemon can watch; watch it again`);
  }

  io.log(`${key}: the saved state is in no shape this daemon writes; the target starts over`);
  return { ...config.data, ...emptyReading() };
}

/**
 * One poll of a saved target, read and judged on a draft copy: the events, and the target to keep.
 * A fleet-wide read that fails (the session transcript, the subagents listing, the worktree
 * discovery, or any dependency read added later that throws past the per-agent catches) discards
 * the draft: no transition is said, no counter moves, every continuity stays as it was read, and
 * the one trouble event is said. A poll that reads keeps the draft. An error that is not a read
 * failure is the daemon's failed poll, which saves nothing.
 */
async function pollTarget(
  saved: unknown,
  key: string,
  nowMs: number,
  io: Io,
): Promise<{ result: PollResult; target: Target }> {
  const target = readTarget(saved, key, io);
  const draft = structuredClone(target);
  let outcome: Awaited<ReturnType<typeof readFleet>>;
  try {
    outcome = await readFleet(draft, nowMs, io);
  } catch (error) {
    if (!(error instanceof FleetReadError)) throw error;
    io.log(error.message);
    return { result: troubleOnly(target, error, nowMs), target };
  }

  const events = [...troubleTransitions(draft, outcome.trouble, nowMs), ...outcome.events];
  return { result: { events, busy: outcome.busy }, target: draft };
}

// The daemon lands each entry of `targets` as it stands when the poll returns: the target a poll kept replaces the saved one.
async function poll(targets: Record<string, Target>, io: Io): Promise<PollResult> {
  const nowMs = Date.now();
  const events: EventInput[] = [];
  let busy = false;
  for (const [key, saved] of Object.entries(targets)) {
    const polled = await pollTarget(saved, key, nowMs, io);
    targets[key] = polled.target;
    events.push(...polled.result.events);
    busy ||= polled.result.busy;
  }
  return { events, busy };
}

/** The agent transcripts the subagents directory holds now, what every poll reads: a count, none before the first spawn makes the directory, or the code of a listing that failed. */
function listedAgents(target: Target): string {
  try {
    const names = readdirSync(target.subagentsDir);
    return String(names.filter((name) => TRANSCRIPT_NAME.test(name)).length);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return code === "ENOENT" ? "0" : `not listed (${code})`;
  }
}

/** What the target reads now, then the alerts in force, oldest first: a quiet target is told from an empty one. */
function summary(target: Target): string[] {
  // A state in another shape has no poll behind it yet: the next one starts the target over.
  const read = TARGET.safeParse(target);
  if (!read.success) return [];

  const saved = read.data;
  const standing: Array<{ since: string; text: string }> = [];
  for (const entry of Object.values(saved.agents)) {
    if (entry.said?.level === "alert") standing.push(entry.said);
  }
  for (const entry of Object.values(saved.worktrees)) {
    if (entry.said !== null) standing.push(entry.said);
  }
  standing.push(...Object.values(saved.trouble));

  const agents = listedAgents(saved);
  const reading =
    saved.repo === null
      ? `reading: agents ${agents}`
      : `reading: agents ${agents}, unclaimed worktrees ${Object.keys(saved.worktrees).length}`;
  return [reading, ...standing.sort(byTime((entry) => entry.since)).map((entry) => entry.text)];
}

runEvents<Target>({
  name: "fleet-events",
  entry: ENTRY,
  wrapperPid: WRAPPER_PID ?? undefined,
  interval: 60,
  idleInterval: 300,
  usage: [
    "targets: session (this session's transcript and subagents dir, found by CLAUDE_CODE_SESSION_ID under ~/.claude/projects), or an absolute path to a session directory",
    "--repo <root>            add the worktree reading for every worktree of this repository that no agent claims (absolute path)",
    `--quiet-after <minutes>  an open turn with nothing pending is stuck after this long (default ${DEFAULT_QUIET_AFTER_MINUTES})`,
    `the session-events skill must be installed beside this one; without it every command exits 2 naming the install: ${INSTALL}`,
  ],
  parseTarget,
  poll,
  summary,
});
