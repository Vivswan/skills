#!/usr/bin/env bun
// One daemon per Claude Code session, started by that session as a background task. A child of the
// session is rendered as plain text; a detached process is a cross-session sender whose frames the
// session holds, which is why the CLI never starts the daemon and the page says never to detach it.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  discoverRuns,
  displayName,
  failedJobLog,
  judgeRuns,
  type Run,
  selectLatest,
} from "./check-suites.mts";
import { AbortedRead, GhError, guardReads } from "./gh.mts";
import {
  deliver,
  envelope,
  FROM_NAME,
  fenceQuoted,
  type InboxFrame,
  inboxToken,
  isProcessAlive,
  pidOf,
  processStart,
  renderDigest,
} from "./inbox.mts";
import { type Activity, newActivity, readPrDetail, viewerLogin } from "./pr-detail.mts";
import { type PrKey, type PrRef, prKey, type Row, readRows, rowChanged } from "./pr-rows.mts";
import {
  ALL_SUBSCRIBED,
  appendEvents,
  type CiOutcome,
  type CommitKey,
  commitKey,
  type EventInput,
  type EventKind,
  freshGrace,
  type Grace,
  isSubscribedKind,
  loadState,
  nextEvent,
  type Owner,
  type OwnerFiles,
  ownerFiles,
  type PrEvent,
  pendingCi,
  RuntimeDirError,
  readEventsSince,
  runtimeDir,
  type SavedRow,
  SOCKET_SUFFIX,
  type State,
  type SubscribedKind,
  saveState,
} from "./state.mts";

// The Polling Budget floor: faster polling only spends the shared rate bucket.
const MIN_INTERVAL_SECONDS = 60;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
// A workflow run can register a few seconds after the push; two polls before calling it missing.
const MISSING_GRACE_POLLS = 2;
// GitHub reports a merged PR's merge commit a poll or two after mergedAt; after this many it is
// given up as unwatchable.
const MERGE_COMMIT_GRACE_POLLS = 5;
const MAX_LOG_EXCERPTS = 3;
const MAX_BODY_CHARS = 2000;
const WAIT_TICK_MS = 1000;
// The owner's end is noticed between polls, so a finished session does not leave a poller behind
// for the rest of the interval.
const OWNER_CHECK_MS = 1000;
// How long a stopping daemon waits for a connection accepted before the stop to say what it wants
// (it is refused), before the connection is cut so the process can end.
const SILENT_CLIENT_GRACE_MS = 1000;
// The receiver drops a second frame from one sender within the same second; a poll triggered by
// `watch` right after another waits this long before its message goes out.
const MIN_DELIVERY_GAP_MS = 1100;
const STOPPING_ERROR = "daemon stopping; retry";
// A poll failure gh's own text puts down to authentication: its token went stale, and only a daemon
// started afresh by the session gets a new one. Any other failure is retried by the next poll as it
// is. gh's phrasings, each with a space or a status code no repository slug can carry, and what gh
// quotes is dropped first: it echoes the input, and a repository can be called authentication.
const AUTH_ERROR =
  /\b401\b|bad credentials|requires authentication|authentication token|gh auth login|personal access token|token is invalid|invalid token|token (?:has )?expired|GH_TOKEN|GITHUB_TOKEN/i;
const QUOTED = /'[^']*'|"[^"]*"/g;

// A usage error ends with the failing command's own line: the whole block's last line is the
// interval floor, which a reader of the tail took for the reason.
const COMMAND_USAGE: Record<string, string> = {
  daemon: "daemon [--interval <s>] [--id <name>] [--pid <pid>]",
  watch:
    "watch <owner/repo>#<n> [--head <sha>] [--expect-workflow <name>]... [--events <kinds>]... [--id <name>]",
  "watch-commit": "watch-commit <owner/repo> <sha> [--expect-workflow <name>]... [--id <name>]",
  unwatch: "unwatch <owner/repo>#<n> | <owner/repo>@<sha-prefix> | --all [--id <name>]",
  wait: "wait [--since <id>] [--timeout <s>] [--id <name>]",
  poll: "poll | status | stop                     [--id <name>]",
};
COMMAND_USAGE.status = COMMAND_USAGE.poll as string;
COMMAND_USAGE.stop = COMMAND_USAGE.poll as string;
const USAGE = [
  "usage: pr-events.mts <command> [options]",
  ...[...new Set(Object.values(COMMAND_USAGE))].map((line) => `  ${line}`),
  "the daemon serves the Claude Code session named by CLAUDE_CODE_MESSAGING_SOCKET and exits with it;",
  "--id <name> names a file-sink daemon for a non-Claude agent instead, --pid <pid> ends it with that process;",
  `--interval has a floor of ${MIN_INTERVAL_SECONDS} s`,
].join("\n");

function usageFor(command: string | undefined): string {
  if (command === undefined || !Object.hasOwn(COMMAND_USAGE, command)) return USAGE;
  return `usage: pr-events.mts ${COMMAND_USAGE[command]}`;
}

class UsageError extends Error {}
class ToolingError extends Error {}
class NoDaemonError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// --- the owner --------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    usage(`${flag} must be a positive whole number, got: ${value}`);
  }
  return Number(value);
}

/**
 * The CLI and the daemon resolve the same owner from the same environment, so they name the same
 * socket: the session whose inbox CLAUDE_CODE_MESSAGING_SOCKET names, or the `--id` of a file sink.
 */
function resolveOwner(
  values: { id?: string; pid?: string },
  env: NodeJS.ProcessEnv = process.env,
): Owner {
  const pid = parsePositiveInt(values.pid, "--pid") ?? null;
  // `--pid $$` from a shell that execs the daemon as its last command names the daemon itself.
  if (pid === process.pid) usage("--pid names this very process; pass the agent's own pid");
  if (values.id !== undefined) {
    if (!ID_PATTERN.test(values.id)) {
      usage(`--id must be a name of letters, digits, . _ or -, not ${values.id}`);
    }
    if (/^\d+$/.test(values.id)) {
      usage("--id must not be all digits: a session's files are keyed by its pid");
    }
    return { key: values.id, inbox: null, pid };
  }
  const inbox = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!inbox) {
    usage(
      "CLAUDE_CODE_MESSAGING_SOCKET is unset: not a Claude Code session; pass --id <name> to name a file-sink daemon instead",
    );
  }
  if (pid !== null) usage("--pid applies to --id; a session's daemon ends with the session");
  const sessionPid = parsePositiveInt(env.CLAUDE_PID, "CLAUDE_PID") ?? pidOf(inbox);
  if (sessionPid === null) {
    usage(
      `cannot tell the session's pid: CLAUDE_PID is unset and the inbox is not <pid>.sock: ${inbox}`,
    );
  }
  return { key: String(sessionPid), inbox, pid: sessionPid };
}

// Linux allows 108 bytes for a Unix socket path and macOS 104; a longer one fails at bind.
const SOCKET_PATH_MAX = 104;

function filesOf(dir: string, owner: Owner): OwnerFiles {
  const files = ownerFiles(dir, owner);
  if (Buffer.byteLength(files.socket) > SOCKET_PATH_MAX) {
    usage(
      `the socket path ${files.socket} is longer than the ${SOCKET_PATH_MAX} bytes a Unix socket allows; use a shorter --id or PR_EVENTS_DIR`,
    );
  }
  return files;
}

function describeOwner(owner: Owner): string {
  return owner.inbox === null ? `file sink ${owner.key}` : `session ${owner.key}`;
}

function startCommand(owner: Owner): string {
  return `bun "${import.meta.path}" daemon${owner.inbox === null ? ` --id ${owner.key}` : ""}`;
}

// --- control protocol --------------------------------------------------------

type WatchTarget =
  | {
      kind: "pr";
      repo: string;
      number: number;
      head: string | null;
      expected: string[];
      events: SubscribedKind[];
    }
  | { kind: "commit"; repo: string; sha: string; expected: string[] };

type Command =
  | { cmd: "watch"; target: WatchTarget }
  | { cmd: "unwatch"; target: PrRef | { repo: string; sha: string } | null }
  | { cmd: "poll" }
  | { cmd: "status" }
  | { cmd: "stop" };

interface StatusReply {
  pid: number;
  state: State;
}

type Reply =
  | { ok: true; events?: number; watched?: number; status?: StatusReply }
  | { ok: false; error: string };

async function connectOnce(path: string): Promise<Socket> {
  const socket = connect(path);
  await once(socket, "connect");
  return socket;
}

// The first line a socket carries; the connection closing first is the error the message names.
// Framed by hand: node:readline on a bun client socket emits close before a reply that arrives
// after a delay, so it cannot read a daemon's answer.
function firstLine(socket: Socket, closedEarly: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf-8");
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      resolve(buffer.slice(0, newline));
    };
    socket.on("data", onData);
    socket.once("close", () => reject(new ToolingError(closedEarly)));
    socket.once("error", reject);
  });
}

async function exchange(socket: Socket, command: Command): Promise<Reply> {
  socket.write(`${JSON.stringify(command)}\n`);
  try {
    return JSON.parse(
      await firstLine(socket, "the daemon closed the connection without a reply"),
    ) as Reply;
  } finally {
    socket.destroy();
  }
}

function isNobodyListening(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** The reply of the owner's daemon, or null when none answers on its socket. */
async function requestIfRunning(files: OwnerFiles, command: Command): Promise<Reply | null> {
  let socket: Socket;
  try {
    socket = await connectOnce(files.socket);
  } catch (error) {
    if (isNobodyListening(error)) return null;
    throw error;
  }
  return exchange(socket, command);
}

// The CLI never starts the daemon: a child of the CLI would outlive it detached, and a detached
// process is a cross-session sender whose frames the session holds for approval.
async function request(owner: Owner, files: OwnerFiles, command: Command): Promise<Reply> {
  const reply = await requestIfRunning(files, command);
  if (reply === null) {
    throw new NoDaemonError(
      `no pr-events daemon answers for ${describeOwner(owner)} on ${files.socket}; start one as a background task of this session:\n  ${startCommand(owner)}`,
    );
  }
  return reply;
}

function unwrap(reply: Reply): Reply & { ok: true } {
  if (!reply.ok) throw new ToolingError(`daemon: ${reply.error}`);
  return reply;
}

// --- argument parsing --------------------------------------------------------

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TARGET_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const OWNER_OPTIONS = { id: { type: "string" } } as const;

function parseTarget(target: string | undefined): PrRef {
  if (target === undefined) usage("missing <owner/repo>#<n>");
  const match = TARGET_PATTERN.exec(target);
  if (!match) usage(`target must be <owner/repo>#<n>, got: ${target}`);
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) usage(`PR number out of range: ${match[2]}`);
  return { repo: match[1] as string, number };
}

// A workflow name is matched exactly, commas and all; one flag carries one name, and the flags of
// one call are the complete gate set.
function parseExpected(values: string[] | undefined): string[] {
  const names = values ?? [];
  if (names.some((name) => name.trim() === "")) usage("--expect-workflow needs a workflow name");
  return [...new Set(names)].sort();
}

// One flag carries one kind or a comma-separated list; the flags of one call are the complete set,
// and no flag at all is every kind.
function parseEvents(values: string[] | undefined): SubscribedKind[] {
  if (values === undefined) return [...ALL_SUBSCRIBED].sort();
  const kinds = values.flatMap((value) => value.split(","));
  const unknown = kinds.find((kind) => !isSubscribedKind(kind));
  if (unknown !== undefined) {
    usage(
      `--events must name kinds from ${ALL_SUBSCRIBED.join(", ")}, got: ${unknown || "nothing"}`,
    );
  }
  return [...new Set(kinds as SubscribedKind[])].sort();
}

function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T, positionals: number) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (parsed.positionals.length > positionals) {
      usage(`unexpected extra argument: ${parsed.positionals[positionals]}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    usage(errorText(error));
  }
}

function requireGh(): void {
  if (Bun.which("gh") === null) {
    throw new ToolingError("gh not found on PATH; install and authenticate the GitHub CLI");
  }
}

// --- CLI commands -------------------------------------------------------------

function describeTarget(target: WatchTarget): string {
  return target.kind === "pr"
    ? `${target.repo}#${target.number}`
    : `${target.repo}@${target.sha.slice(0, 12)}`;
}

async function watch(dir: string, owner: Owner, target: WatchTarget): Promise<number> {
  const reply = unwrap(await request(owner, filesOf(dir, owner), { cmd: "watch", target }));
  console.log(
    `watching ${describeTarget(target)} for ${describeOwner(owner)}; ${reply.watched} target(s)`,
  );
  return 0;
}

async function cmdWatch(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      ...OWNER_OPTIONS,
      head: { type: "string" },
      "expect-workflow": { type: "string", multiple: true },
      events: { type: "string", multiple: true },
    },
    1,
  );
  const ref = parseTarget(positionals[0]);
  if (values.head !== undefined && !SHA_PATTERN.test(values.head)) {
    usage(`--head must be a full 40-character lowercase sha, got: ${values.head}`);
  }
  return watch(dir, resolveOwner(values), {
    kind: "pr",
    ...ref,
    head: values.head ?? null,
    expected: parseExpected(values["expect-workflow"]),
    events: parseEvents(values.events),
  });
}

async function cmdWatchCommit(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      ...OWNER_OPTIONS,
      "expect-workflow": { type: "string", multiple: true },
      events: { type: "string", multiple: true },
    },
    2,
  );
  if (values.events !== undefined) usage("--events applies to watch; a commit's only kind is ci");
  const [repo, sha] = positionals;
  if (repo === undefined || !REPO_PATTERN.test(repo)) {
    usage(`watch-commit needs <owner/repo>, got: ${repo ?? "nothing"}`);
  }
  if (sha === undefined || !SHA_PATTERN.test(sha)) {
    usage(`watch-commit needs a full 40-character lowercase sha, got: ${sha ?? "nothing"}`);
  }
  return watch(dir, resolveOwner(values), {
    kind: "commit",
    repo,
    sha,
    expected: parseExpected(values["expect-workflow"]),
  });
}

// A commit target as `status` prints it: `<owner/repo>@<sha>`, the sha whole or its first twelve
// or more characters.
const COMMIT_TARGET_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]+)$/;
const MIN_SHA_PREFIX = 12;

function parseUnwatchTarget(target: string | undefined): PrRef | { repo: string; sha: string } {
  if (target === undefined) usage("missing <owner/repo>#<n>, <owner/repo>@<sha-prefix>, or --all");
  const commit = COMMIT_TARGET_PATTERN.exec(target);
  if (commit === null) return parseTarget(target);
  const [, repo, sha] = commit as unknown as [string, string, string];
  if (sha.length < MIN_SHA_PREFIX || sha.length > 40) {
    usage(
      `unwatch needs a lowercase sha of ${MIN_SHA_PREFIX} to 40 characters after @, as status prints it, got: ${sha}`,
    );
  }
  return { repo, sha };
}

async function cmdUnwatch(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...OWNER_OPTIONS, all: { type: "boolean" } }, 1);
  if (values.all === true && positionals.length > 0) usage("--all takes no target");
  const target = values.all === true ? null : parseUnwatchTarget(positionals[0]);
  const owner = resolveOwner(values);
  unwrap(await request(owner, filesOf(dir, owner), { cmd: "unwatch", target }));
  const what =
    target === null
      ? "everything"
      : "number" in target
        ? `${target.repo}#${target.number}`
        : `${target.repo}@${target.sha.slice(0, 12)}`;
  console.log(`unwatched ${what} for ${describeOwner(owner)}`);
  return 0;
}

async function cmdPoll(dir: string, args: string[]): Promise<number> {
  const { values } = parse(args, OWNER_OPTIONS, 0);
  const owner = resolveOwner(values);
  const reply = unwrap(await request(owner, filesOf(dir, owner), { cmd: "poll" }));
  console.log(`polled; ${reply.events} event(s)`);
  return 0;
}

async function cmdStop(dir: string, args: string[]): Promise<number> {
  const { values } = parse(args, OWNER_OPTIONS, 0);
  const owner = resolveOwner(values);
  const reply = await requestIfRunning(filesOf(dir, owner), { cmd: "stop" });
  if (reply === null) {
    console.log(`no daemon running for ${describeOwner(owner)}`);
    return 0;
  }
  unwrap(reply);
  console.log("daemon stopped");
  return 0;
}

function describeDelivery(delivery: State["delivery"]): string {
  return delivery
    ? `${delivery.outcome} (#${delivery.eventIds.join(",#")} at ${delivery.at})`
    : "none";
}

function subjectOf(event: Pick<PrEvent, "repo" | "pr" | "sha">): string {
  if (event.pr !== null) return `${event.repo}#${event.pr}`;
  if (event.sha !== null) return `${event.repo}@${event.sha.slice(0, 12)}`;
  return "daemon";
}

function gates(expected: string[]): string {
  return expected.join(",") || "-";
}

/** The subscription's kinds when narrowed; the full set is the default and says nothing. */
function narrowedTo(events: SubscribedKind[]): string {
  return events.length === ALL_SUBSCRIBED.length ? "" : ` events=${events.join(",")}`;
}

async function cmdStatus(dir: string, args: string[]): Promise<number> {
  const { values } = parse(args, OWNER_OPTIONS, 0);
  const owner = resolveOwner(values);
  const files = filesOf(dir, owner);
  const status = unwrap(await request(owner, files, { cmd: "status" })).status as StatusReply;
  const { state } = status;
  const lines = [
    `daemon: running (pid ${status.pid}) for ${describeOwner(owner)}`,
    `socket: ${files.socket}`,
    `log: ${files.log}`,
    `events: ${files.events}`,
    `delivery: ${describeDelivery(state.delivery)}`,
  ];
  const prs = Object.entries(state.prs);
  lines.push(`prs: ${prs.length}`);
  for (const [key, pr] of prs) {
    const row = state.rows[key];
    const seen = row
      ? `head=${row.headRefOid.slice(0, 12)} state=${row.state} ci=${row.ci.pending ? "pending" : "settled"} updated=${row.updatedAt}`
      : "not polled yet";
    lines.push(
      `  ${key} ${seen} gates=${gates(pr.expected)} recorded-head=${pr.head?.slice(0, 12) ?? "-"}${narrowedTo(pr.events)}`,
    );
  }
  const commits = Object.values(state.commits);
  lines.push(`commits: ${commits.length}`);
  for (const commit of commits) {
    lines.push(
      `  ${commit.repo}@${commit.sha.slice(0, 12)} since ${commit.firstSeenAt} gates=${gates(commit.expected)}`,
    );
  }
  const last = readEventsSince(files, state.lastEventId - 1).at(-1);
  lines.push(
    last
      ? `last event: #${last.id} at ${last.at} ${last.kind} ${subjectOf(last)}: ${last.text.split("\n")[0]}`
      : "last event: none",
  );
  console.log(lines.join("\n"));
  return 0;
}

async function cmdWait(dir: string, args: string[]): Promise<number> {
  const { values } = parse(
    args,
    { ...OWNER_OPTIONS, since: { type: "string" }, timeout: { type: "string" } },
    0,
  );
  const owner = resolveOwner(values);
  const files = filesOf(dir, owner);
  // A wait with no daemon would block for its whole timeout on a log nothing appends to.
  const status = unwrap(await request(owner, files, { cmd: "status" })).status as StatusReply;
  let since: number;
  if (values.since === undefined) {
    since = status.state.lastEventId;
  } else {
    if (!/^\d+$/.test(values.since) || !Number.isSafeInteger(Number(values.since))) {
      usage(`--since must be a whole number, got: ${values.since}`);
    }
    since = Number(values.since);
  }
  const timeoutSeconds =
    parsePositiveInt(values.timeout, "--timeout") ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;
  // A daemon stopped under a running wait: the log it was reading will never grow, and the reader
  // needs the no-daemon exit now, not at the timeout. The log is read once more first: the
  // daemon's last poll may have appended in the same second it stopped.
  let daemon: number | null = status.pid;
  for (;;) {
    const events = readEventsSince(files, since);
    if (events.length > 0) {
      for (const event of events) console.log(JSON.stringify(event));
      console.log(`cursor: ${(events.at(-1) as PrEvent).id}`);
      return 0;
    }
    if (daemon === null) {
      console.log(`cursor: ${since}`);
      throw new NoDaemonError(
        `the pr-events daemon for ${describeOwner(owner)} stopped while this wait was running; start one as a background task of this session:\n  ${startCommand(owner)}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(`no event after ${timeoutSeconds}s`);
      console.log(`cursor: ${since}`);
      return 4;
    }
    await sleep(Math.min(WAIT_TICK_MS, remaining));
    daemon = await liveDaemon(files, daemon);
  }
}

/**
 * The pid of the daemon holding the socket, or null when none does, without a connection a tick:
 * a daemon inside a gh read accepts nothing for up to a minute, and probes queued in its listen
 * backlog come back refused once it fills. The socket file goes when a daemon stops; the known
 * pid answers while it lives; another daemon holding the socket after it (a restart) is asked who
 * it is once, and is the one followed from then on.
 */
async function liveDaemon(files: OwnerFiles, pid: number): Promise<number | null> {
  if (!existsSync(files.socket)) return null;
  if (isProcessAlive(pid)) return pid;
  const reply = await requestIfRunning(files, { cmd: "status" });
  return reply === null ? null : (unwrap(reply).status as StatusReply).pid;
}

// --- daemon -------------------------------------------------------------------

/**
 * Binding the control socket is the single-instance rule for a session: a bind refused by a daemon
 * that answers means this one is the second, and it leaves; a socket file nobody answers on was
 * left by a daemon that died and is replaced. Bind, probe, and replacement happen under a lock
 * file beside the socket: two starts in the same second, the ordinary case after a `watch` exited
 * 3, would otherwise both see a stale or half-bound socket refuse, both unlink, and both bind, the
 * second unlink taking the first's live socket. `preflight` runs once the socket is held, still
 * under the lock: what it refuses is closed and unlinked while no other start can have replaced it.
 */
async function bindControlSocket(
  path: string,
  token: string,
  log: (line: string) => void,
  preflight: () => void,
): Promise<Server | null> {
  const lockPath = `${path.slice(0, -SOCKET_SUFFIX.length)}.lock`;
  const release = await acquireStartLock(lockPath, token);
  try {
    for (;;) {
      const bound = await tryListen(path);
      if (bound !== null) {
        try {
          preflight();
        } catch (error) {
          bound.close();
          await once(bound, "close");
          rmSync(path, { force: true });
          throw error;
        }
        return bound;
      }
      const found = lstatSync(path, { throwIfNoEntry: false });
      if (found === undefined) continue;
      if (!found.isSocket()) throw new ToolingError(`${path} is not a socket; remove it`);
      try {
        (await connectOnce(path)).destroy();
        log(`another daemon answers on ${path}; exiting`);
        return null;
      } catch (error) {
        if (errorCode(error) !== "ECONNREFUSED") throw error;
      }
      // The file that refused, by inode: the daemon that left it may still be on its way out. And
      // still this start's lock: a breaker that moved a fresh lock aside puts it back, and in the
      // moment between, another start can have taken the path.
      if (lstatSync(path, { throwIfNoEntry: false })?.ino !== found.ino) continue;
      if (!holdsLock(lockPath, token)) continue;
      log(`replacing the stale control socket ${path}`);
      unlinkSync(path);
    }
  } finally {
    release();
  }
}

async function tryListen(path: string): Promise<Server | null> {
  const server = createServer();
  try {
    server.listen(path);
    await once(server, "listening");
    chmodSync(path, 0o600);
    return server;
  } catch (error) {
    if (errorCode(error) !== "EADDRINUSE") throw error;
    return null;
  }
}

// A start holds the lock for milliseconds; a live holder still there after this is a hung start,
// and exiting with its name beats waiting in silence.
const START_LOCK_WAIT_MS = 5_000;
const START_LOCK_TICK_MS = 25;

/**
 * Takes the exclusive lock file, created atomically with the holder's pid and start token, and
 * returns its release. A lock is stale when its pid is dead, or alive as another process (its start
 * token differs); a live holder is waited on. A stale lock is broken by one atomic rename aside;
 * the renamer that finds the path gone lost and tries again. The renamer that succeeds reads what
 * it moved: the stale file it judged, which it removes before creating a fresh lock, or a fresh
 * lock another start took in between, which it links back into place. The release removes the
 * lock by inode where it stands and then empties it: a breaker that judged an older lock and
 * renamed this one aside, before or during the release, links back a file with no pid, which the
 * next start breaks on sight instead of waiting on a daemon that holds no lock.
 */
async function acquireStartLock(lockPath: string, token: string): Promise<() => void> {
  const deadline = Date.now() + START_LOCK_WAIT_MS;
  for (;;) {
    const fd = createLock(lockPath, token);
    if (fd !== null) {
      return () => {
        const mine = fstatSync(fd).ino;
        if (lstatSync(lockPath, { throwIfNoEntry: false })?.ino === mine) {
          rmSync(lockPath, { force: true });
        }
        ftruncateSync(fd, 0);
        closeSync(fd);
      };
    }
    const held = readLock(lockPath);
    if (held === null) continue;
    if (!isStaleLock(held)) {
      if (Date.now() >= deadline) {
        throw new ToolingError(
          `another start holds ${lockPath}: pid ${held.pid}; if it is hung, stop it and start again`,
        );
      }
      await sleep(START_LOCK_TICK_MS);
      continue;
    }
    const aside = `${lockPath}.stale-${process.pid}`;
    try {
      renameSync(lockPath, aside);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const moved = readLock(aside);
    if (moved !== null && (moved.pid !== held.pid || moved.token !== held.token)) {
      // EEXIST: a third start took the path meanwhile. ENOENT: the holder released, from aside.
      try {
        linkSync(aside, lockPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOENT") throw error;
      }
    }
    rmSync(aside, { force: true });
  }
}

/** Whether the lock at `lockPath` is this start's: its own pid and token. */
function holdsLock(lockPath: string, token: string): boolean {
  const lock = readLock(lockPath);
  return lock !== null && lock.pid === process.pid && lock.token === token;
}

/** A lock file's content: the holder's pid (null when the file holds none) and its start token. */
type Lock = { pid: number | null; token: string };

/**
 * Dead, or alive as another process: its start token reads as another one. A token empty in the
 * lock or unreadable now is unknown on that side, never a mismatch; such a lock is stale only
 * when its pid is dead. A lock with no pid at all is a released one a breaker linked back.
 */
function isStaleLock(lock: Lock): boolean {
  if (lock.pid === null || !isProcessAlive(lock.pid)) return true;
  if (lock.token === "") return false;
  const now = processStart(lock.pid);
  return now !== null && now !== lock.token;
}

/**
 * Creates the lock file with the pid and token already in it and returns a descriptor on it, or
 * null when the lock is held: a private draft is linked into place, which fails with EEXIST. A
 * create followed by a write would show an empty lock in between. The draft is a fresh file: one a
 * starter with this pid left linked to the lock it took, killed before removing it, would
 * otherwise be the lock, and writing it would turn that stale lock into a live-looking one.
 */
function createLock(path: string, token: string): number | null {
  const draft = `${path}.${process.pid}.draft`;
  rmSync(draft, { force: true });
  const fd = openSync(draft, "w", 0o600);
  try {
    writeSync(fd, `${process.pid} ${token}`);
    linkSync(draft, path);
    return fd;
  } catch (error) {
    closeSync(fd);
    if (errorCode(error) !== "EEXIST") throw error;
    return null;
  } finally {
    rmSync(draft, { force: true });
  }
}

function readLock(path: string): Lock | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const [first = "", token = ""] = text.trim().split(" ", 2);
  const pid = Number(first);
  return { pid: /^\d+$/.test(first) && Number.isSafeInteger(pid) && pid > 0 ? pid : null, token };
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...` : text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The event text for one poll's new activity, or null when none of it says anything. An inline
 * comment is headlined under the review that published it, so the review GitHub wraps a batch of
 * inline comments in reads as one review with its comment count; such a wrapper with no new
 * inline comment and no body is dropped. The page's specimen is this text, byte for byte.
 */
/**
 * A poll's new activity as events: the reviews with the inline comments they published, then the
 * loose comments. Two events, not one, so a subscription to one kind never drops or carries the
 * other.
 */
function describeActivities(
  activities: Activity[],
): Array<{ kind: "comment" | "review"; text: string }> {
  const comments = activities.filter((activity) => activity.kind !== "review");
  const inlineOf = (review: Activity) =>
    comments.filter((comment) => comment.reviewId === review.id);
  const reviews = activities.filter(
    (activity) =>
      activity.kind === "review" &&
      (activity.body !== "" ||
        activity.reviewState !== "COMMENTED" ||
        inlineOf(activity).length > 0),
  );
  const headlined = new Set(reviews.flatMap((review) => inlineOf(review).map((c) => c.id)));
  const loose = comments.filter((comment) => !headlined.has(comment.id));
  const events: Array<{ kind: "comment" | "review"; text: string }> = [];
  if (reviews.length > 0) {
    const summary = reviews.map((review) => {
      const inline = inlineOf(review).length;
      const headline = `new review by ${review.author} (${review.reviewState})`;
      return inline === 0 ? headline : `${headline}, ${plural(inline, "review comment")}`;
    });
    const items = reviews.flatMap((review) => [review, ...inlineOf(review)]);
    events.push({ kind: "review", text: describeBatch(summary.join(", "), items) });
  }
  if (loose.length > 0) {
    const authors = [...new Set(loose.map((comment) => comment.author))].join(", ");
    const summary = `${plural(loose.length, "new comment")} by ${authors}`;
    events.push({ kind: "comment", text: describeBatch(summary, loose) });
  }
  return events;
}

/** The summary line, then the quoted bodies fenced, aligned on their `where` column. */
function describeBatch(summary: string, items: Activity[]): string {
  const rows: [string, string][] = [];
  for (const activity of items) {
    const body = clip(flatten(activity.body));
    if (body === "") continue;
    // The path is the author's too (a file name can hold a newline), and a row must stay one line.
    const where =
      activity.path !== undefined
        ? `${flatten(activity.path)}${typeof activity.line === "number" ? `:${activity.line}` : ""}`
        : flatten(activity.author);
    rows.push([where, body]);
  }
  const width = Math.max(0, ...rows.map(([where]) => where.length));
  const quoted = rows.map(([where, body]) => `  ${where.padEnd(width)}  ${body}`);
  return [summary, ...(quoted.length > 0 ? fenceQuoted(quoted) : [])].join("\n");
}

function isFailedRun(run: Run): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    run.conclusion !== "success" &&
    run.conclusion !== "skipped"
  );
}

function indent(lines: string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

/** The judged runs' workflow names, one per run: two workflows can share a name. */
function workflowNames(runs: Run[]): string[] {
  return selectLatest(runs)
    .map((run) => run.name)
    .sort();
}

// Workflow, job, and step names are the PR branch's own: the headline carries the count, and the
// names, the per-run lines, and the excerpts sit in the fence.
function describeGreen(sha: string, runs: Run[]): string {
  const names = workflowNames(runs);
  return [
    `CI green on ${sha.slice(0, 12)}: ${plural(names.length, "workflow")}`,
    ...fenceQuoted(names.map((name) => `  ${displayName(name)}`)),
  ].join("\n");
}

function describeRed(repo: string, sha: string, runs: Run[], verdictLines: string[]): string {
  const quoted = indent(verdictLines);
  const failed = selectLatest(runs).filter(isFailedRun);
  for (const run of failed.slice(0, MAX_LOG_EXCERPTS)) {
    const excerpt = failedJobLog(repo, run.id);
    if (excerpt === "") continue;
    quoted.push(
      `  --- ${displayName(run.name)} (${run.id}) failed-step log excerpt ---`,
      ...indent(excerpt.split("\n")),
    );
  }
  const lines = [
    `CI red on ${sha.slice(0, 12)}: ${plural(workflowNames(runs).length, "workflow")}`,
    ...fenceQuoted(quoted),
  ];
  if (failed.length > MAX_LOG_EXCERPTS) {
    lines.push(`  ${failed.length - MAX_LOG_EXCERPTS} more failed run(s) without an excerpt`);
  }
  return lines.join("\n");
}

function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}/checks`;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** The one target a poll judges CI for, or null for every pending target. */
type Scope = PrKey | CommitKey | null;

/** How a poll judges a target's CI: with the settling bookkeeping, for terminal verdicts only, or not at all. */
type Judging = "settling" | "terminal" | "none";

/** A settled judgment; `event` is null when the same runs had already been reported. */
type CiJudgment = { outcome: CiOutcome; runs: string; event: PrEvent | null };

function isTerminalRollup(state: string | null): boolean {
  return state === "SUCCESS" || state === "FAILURE" || state === "ERROR";
}

function rollupAgreesWith(state: string | null, outcome: CiOutcome): boolean {
  return outcome === "green" ? state === "SUCCESS" : state === "FAILURE" || state === "ERROR";
}

function judgingOf(scope: Scope, key: PrKey | CommitKey): Judging {
  if (scope === null) return "settling";
  return scope === key ? "terminal" : "none";
}

async function runDaemon(
  owner: Owner,
  files: OwnerFiles,
  intervalSeconds: number,
): Promise<number> {
  const log = (line: string) => appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
  // The socket first: only its holder may read or repair the state and the log, or a second daemon
  // starting while the first has saved a poll it has not yet appended would append it too.
  // This start's own token, in the lock it takes: the process start, else the session's inbox.
  const startToken =
    processStart(process.pid) ?? (owner.inbox === null ? "" : (inboxToken(owner.inbox) ?? ""));
  // gh is required only of the daemon that will poll: a second start without it finds the first
  // daemon serving and exits 0 like any other second start, instead of hiding it behind exit 2.
  const server = await bindControlSocket(files.socket, startToken, log, requireGh);
  if (server === null) {
    console.log(`another pr-events daemon already serves ${describeOwner(owner)}; exiting`);
    return 0;
  }
  // The owner's start token: the process start from /proc, else its inbox socket's identity; a
  // file-sink owner has neither, and its saved targets are its own.
  // The token's source is fixed at start, so a later read compares like with like: /proc where it
  // answered, else the inbox socket; a file-sink owner without an inbox has no token.
  const procStart = owner.pid === null ? null : processStart(owner.pid);
  const tokenSource: "proc" | "inbox" | null =
    procStart !== null ? "proc" : owner.inbox !== null && owner.pid !== null ? "inbox" : null;
  const ownerStart = (): string | null => {
    if (tokenSource === "proc") return processStart(owner.pid as number);
    if (tokenSource === "inbox") return inboxToken(owner.inbox as string);
    return null;
  };
  const start = ownerStart();
  const incarnation = owner.pid !== null && start !== null ? { pid: owner.pid, start } : null;
  const { state, unlogged, newestEventAt, staleOwner, movedEvents } = loadState(files, incarnation);
  if (staleOwner) {
    const where = movedEvents === null ? "" : `; its events were moved to ${movedEvents}`;
    log(
      `the saved state belonged to an earlier session with pid ${staleOwner.pid}; this session starts with no targets${where}`,
    );
  } else if (movedEvents !== null) {
    log(
      `an events log with no saved state belonged to an earlier session; it was moved to ${movedEvents}`,
    );
  }
  if (unlogged.length > 0) {
    appendEvents(files, unlogged);
    log(
      `appended #${unlogged.map((event) => event.id).join(",#")} to the log from the saved state`,
    );
  }
  // Registration settles over this daemon's own polls: the startup poll can follow the last
  // daemon's by seconds, so what that one saw counts toward no confirmation and no grace.
  for (const row of Object.values(state.rows)) {
    if (row.ci.pending) row.ci.grace = freshGrace();
  }
  for (const commit of Object.values(state.commits)) commit.grace = freshGrace();
  const banner = `pr-events daemon ${process.pid} for ${describeOwner(owner)}; socket ${files.socket}; log ${files.log}; poll every ${intervalSeconds} s`;
  console.log(banner);
  log(banner);

  let polling: Promise<number> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let troubled = false;
  let viewer: string | null = null;
  let stopping = false;
  // Connections accepted whose first line has not arrived; one that has is answered and closes.
  const silent = new Set<Socket>();
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const viewerLoginCached = (): string => {
    if (viewer === null) viewer = viewerLogin();
    return viewer;
  };

  const watchedCount = (): number =>
    Object.keys(state.prs).length + Object.keys(state.commits).length;

  // The pid alone is not the owner: a session that exited and a process that took its pid would
  // keep the daemon polling, and a new session with that pid would receive the old targets' events.
  let tokenUnreadableLogged = false;
  const ownerGoneReason = (): string | null => {
    if (owner.pid === null) return null;
    if (!isProcessAlive(owner.pid)) return `${describeOwner(owner)} exited`;
    if (incarnation === null) return null;
    // A token that cannot be read now is unknown, never a mismatch: only another token is.
    const now = ownerStart();
    if (now === null) {
      if (!tokenUnreadableLogged) {
        tokenUnreadableLogged = true;
        log(`the owner's start token cannot be read; its pid alone says whether it lives`);
      }
      return null;
    }
    if (now !== incarnation.start) return `pid ${owner.pid} now belongs to another process`;
    return null;
  };
  guardReads(ownerGoneReason);

  // An event is numbered here and reaches the disk at the end of its poll, in the state first and
  // then the log (`commitPoll` below).
  const emit = (input: EventInput): PrEvent => {
    const event = nextEvent(state, input);
    log(`event #${event.id} ${event.kind} ${subjectOf(event)}: ${event.text.split("\n")[0]}`);
    return event;
  };

  // Registration settles over full polls, an interval apart: the read a `watch` triggers judges a
  // red or a gated green at once and leaves the grace alone, since a full poll can follow it within
  // a second and two reads that close together would confirm a set a gate has not joined yet.
  const judgeCi = (
    repo: string,
    sha: string,
    expected: string[],
    subject: { pr: number | null; url: string },
    grace: Grace,
    emitted: PrEvent[],
    settling: boolean,
    priorRuns: string | null = null,
    subscribed = true,
  ): CiJudgment | null => {
    const runs = discoverRuns(repo, sha);
    const verdict = judgeRuns(runs, expected);
    const base = { repo, pr: subject.pr, sha, url: subject.url };
    // The Actions runs the verdict rests on. An external check (CodeQL, a bot) moving the PR's
    // aggregate rollup re-judges the head, and the same runs must not become a second verdict. A
    // rerun keeps its run id, so the time the run last changed is part of what identifies it.
    const fingerprint = selectLatest(runs)
      .map((run) => `${run.id}:${run.status}:${run.conclusion ?? ""}:${run.updatedAt}`)
      .sort()
      .join(",");
    // Workflows by id, not name: two workflow files can share a name, and a second one registering
    // under the same name is still a set that changed.
    const registered = [
      ...new Set(selectLatest(runs).map((run) => run.workflowId ?? `run:${run.id}`)),
    ]
      .map(String)
      .sort();
    // A verdict nobody hears, the same runs already delivered or a kind the watch left out, is
    // settled without rendering: a red's text fetches failed-run logs, three REST reads at most.
    const settle = (outcome: CiOutcome, render: () => string): CiJudgment => {
      if (priorRuns === fingerprint || !subscribed) {
        return { outcome, runs: fingerprint, event: null };
      }
      const event = emit({ ...base, kind: "ci", text: render(), runs: fingerprint });
      emitted.push(event);
      return { outcome, runs: fingerprint, event };
    };
    // No run at all is a registration that has not happened yet, or a ref nothing triggers on;
    // the grace below decides which, as it does for a named gate.
    const kind = verdict.kind === "pending" && runs.length === 0 ? "missing" : verdict.kind;
    switch (kind) {
      case "pending":
        if (settling) {
          grace.missingPolls = 0;
          grace.registered = registered;
        }
        return null;
      case "green": {
        // Registration settles before a green is terminal: every named gate is present (a missing
        // one ranks above green), or two full polls in a row saw the same workflow set, so a
        // workflow still registering when the first all-green read happened gets its say.
        if (expected.length > 0) return settle("green", () => describeGreen(sha, runs));
        if (!settling) return null;
        grace.missingPolls = 0;
        const confirmed = sameSet(grace.registered, registered);
        grace.registered = registered;
        return confirmed ? settle("green", () => describeGreen(sha, runs)) : null;
      }
      case "red":
        return settle("red", () => describeRed(repo, sha, runs, verdict.lines));
      case "missing":
      case "trouble":
        // Noticed once, at the grace; the sha stays judged, so a run that registers late still
        // gets its verdict.
        if (!settling) return null;
        grace.missingPolls += 1;
        grace.registered = registered;
        if (grace.missingPolls !== MISSING_GRACE_POLLS) return null;
        emitted.push(
          emit({
            ...base,
            kind: "trouble",
            text: [
              `CI ${kind === "missing" ? "run not registered" : "read gave no verdict"} on ${sha.slice(0, 12)} after ${grace.missingPolls} polls; not a verdict`,
              ...fenceQuoted(indent(verdict.lines)),
            ].join("\n"),
          }),
        );
        return null;
    }
  };

  const dropPr = (key: PrKey): void => {
    delete state.prs[key];
    delete state.rows[key];
  };

  // The row is stored as soon as its own events are out, before the CI read: a CI read that fails
  // must not replay the comment or head event on the next poll.
  const processRow = (ref: PrRef, current: Row, emitted: PrEvent[], judging: Judging): void => {
    const key = prKey(ref);
    const watch = state.prs[key];
    if (watch === undefined) return;
    const saved = state.rows[key];
    const base = { repo: ref.repo, pr: ref.number, sha: current.headRefOid, url: current.url };
    const row: SavedRow = {
      ...current,
      ci: saved?.ci ?? pendingCi(),
      seenActivity: saved?.seenActivity ?? [],
      mergeCommitPolls: saved?.mergeCommitPolls ?? 0,
    };
    const headMoved = saved ? current.headRefOid !== saved.headRefOid : watch.head !== null;
    const changes = rowChanged(saved, current);
    // A kind the owner left out is not an event for this PR: not numbered, not logged, not
    // delivered. The row's bookkeeping advances the same, so a later wider subscription does not
    // replay it. `trouble` is tooling news and always comes.
    const wanted = (kind: EventKind): boolean => kind === "trouble" || watch.events.includes(kind);
    let detail: ReturnType<typeof readPrDetail> | null = null;
    // A first sighting reads the detail too: what is on the PR now is the baseline, by id.
    if (!saved || changes.activity) {
      const seen = saved ? new Set(row.seenActivity.flat()) : null;
      detail = readPrDetail(ref, seen);
      const activities = seen ? newActivity(detail, seen, viewerLoginCached()) : [];
      row.seenActivity = [...row.seenActivity.slice(-1), detail.fetchedIds];
      for (const described of describeActivities(activities)) {
        if (wanted(described.kind)) emitted.push(emit({ ...base, ...described }));
      }
      // The subject of a gap (a thread's path) is the author's: it goes in the fence, flattened.
      for (const gap of detail.gaps) {
        const text = [
          "activity backlog past the paging cap; read the PR",
          ...fenceQuoted([`  ${flatten(gap)}`]),
        ].join("\n");
        emitted.push(emit({ ...base, kind: "trouble", text }));
      }
    }
    if (headMoved && watch.head !== current.headRefOid && wanted("head")) {
      detail ??= readPrDetail(ref, null);
      emitted.push(
        emit({
          ...base,
          kind: "head",
          // The detail names the last commit's author; who pushed it is not in the read.
          text: `head moved to ${current.headRefOid.slice(0, 12)}; last commit by ${detail.lastCommitAuthor ?? "an unknown author"}`,
        }),
      );
    }
    // A rollup that only catches up with the verdict already delivered (the suites settled while
    // the rollup still read pending, and it now reads the same way) is not news; any other move on
    // the head, a failure after a delivered green included, is judged again.
    const rollupCatchingUp =
      changes.rollup &&
      saved !== undefined &&
      !saved.ci.pending &&
      !isTerminalRollup(saved.rollupState) &&
      rollupAgreesWith(current.rollupState, saved.ci.outcome);
    // A new head is judged from nothing. A rollup move on a head still being judged keeps the grace
    // already spent waiting for its gate (and the runs of the verdict before it); one on a settled
    // head is judged again, carrying that verdict's runs so the same ones are not delivered twice.
    if (saved && changes.head) row.ci = pendingCi();
    else if (saved && !saved.ci.pending && changes.rollup && !rollupCatchingUp) {
      row.ci = pendingCi(saved.ci.runs);
    }
    if (current.state === "MERGED") {
      const oid = current.mergeCommitOid;
      const mergedAt = current.mergedAt ?? "an unknown time";
      if (oid === null) {
        // The merge commit can lag mergedAt by a poll; the target stays until it is reported, and
        // only a full poll counts toward giving up, since a scoped one can follow within seconds.
        if (judging === "settling") row.mergeCommitPolls += 1;
        if (row.mergeCommitPolls < MERGE_COMMIT_GRACE_POLLS) {
          state.rows[key] = row;
          return;
        }
        emitted.push(
          emit({
            ...base,
            kind: "trouble",
            text: `merged at ${mergedAt}; no merge commit reported after ${row.mergeCommitPolls} polls, so its mainline CI is not watched`,
          }),
        );
        dropPr(key);
        return;
      }
      // The line's sha is the merge commit, whole: the text shows it short, and a log reader
      // watching the mainline needs all of it.
      const handover = wanted("ci");
      if (wanted("merged")) {
        emitted.push(
          emit({
            ...base,
            sha: oid,
            kind: "merged",
            text: `merged at ${mergedAt}; mainline commit ${oid.slice(0, 12)}${handover ? " is now watched for CI" : ""}`,
          }),
        );
      }
      // A watch-commit that already named its own gates for this commit keeps them.
      if (handover) {
        state.commits[commitKey(ref.repo, oid)] ??= {
          repo: ref.repo,
          sha: oid,
          expected: watch.expected,
          firstSeenAt: new Date().toISOString(),
          grace: freshGrace(),
        };
      }
      dropPr(key);
      return;
    }
    if (current.state === "CLOSED") {
      if (wanted("closed")) {
        emitted.push(emit({ ...base, kind: "closed", text: "closed without merging" }));
      }
      dropPr(key);
      return;
    }
    state.rows[key] = row;
    if (judging !== "none" && row.ci.pending) {
      const judgment = judgeCi(
        ref.repo,
        current.headRefOid,
        watch.expected,
        { pr: ref.number, url: current.url },
        row.ci.grace,
        emitted,
        judging === "settling",
        row.ci.priorRuns,
        wanted("ci"),
      );
      if (judgment) row.ci = { pending: false, outcome: judgment.outcome, runs: judgment.runs };
    }
  };

  const processCommit = (key: CommitKey, emitted: PrEvent[], judging: Judging): void => {
    const watch = state.commits[key];
    if (!watch || judging === "none") return;
    const judgment = judgeCi(
      watch.repo,
      watch.sha,
      watch.expected,
      { pr: null, url: commitUrl(watch.repo, watch.sha) },
      watch.grace,
      emitted,
      judging === "settling",
    );
    if (judgment !== null) delete state.commits[key];
  };

  // One message per poll, and a second's gap between messages: the receiver drops a second frame
  // from one sender within the same second.
  // The clock survives a restart: the saved send time and the newest event's time are floors, and
  // so is this daemon's own start, since a daemon killed after its frame left but before its
  // record was saved would otherwise restore a stale clock and send again within the second.
  let lastDeliveryAt = Math.max(
    state.delivery ? Date.parse(state.delivery.at) : 0,
    newestEventAt === null ? 0 : Date.parse(newestEventAt),
    Date.now(),
  );
  const deliverDigest = async (emitted: PrEvent[]): Promise<void> => {
    if (owner.inbox === null || emitted.length === 0) return;
    const gap = lastDeliveryAt + MIN_DELIVERY_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    const from = `uds:${files.socket}`;
    const frame: InboxFrame = {
      type: "user",
      message: { role: "user", content: envelope(from, renderDigest(emitted)) },
      from,
      from_name: FROM_NAME,
      msg_id: `pr-events-${(emitted[0] as PrEvent).id}-${randomUUID()}`,
    };
    // The record is saved before the send with a provisional time; the clock is stamped after that
    // write, right before the frame goes out, so the write cannot eat into the next frame's gap.
    // A crash between the two restores the provisional time, which the start floor above covers.
    state.delivery = {
      eventIds: emitted.map((event) => event.id),
      at: new Date().toISOString(),
      msgId: frame.msg_id,
      outcome: "sending",
    };
    saveState(files, state);
    lastDeliveryAt = Date.now();
    state.delivery.at = new Date(lastDeliveryAt).toISOString();
    try {
      await deliver(owner.inbox, frame);
      state.delivery.outcome = "sent";
    } catch (error) {
      const code = errorCode(error) ?? errorText(error);
      state.delivery.outcome = `failed: ${code}`;
      log(`delivery of #${state.delivery.eventIds.join(",#")} to ${owner.inbox} failed: ${code}`);
    }
    saveState(files, state);
  };

  const watchedRefs = (): PrRef[] =>
    Object.keys(state.prs).map((key) => {
      const [repo, number] = key.split("#") as [string, string];
      return { repo, number: Number(number) };
    });

  // The state is saved first, the poll's events inside it, and the log appended from it; a daemon
  // killed between the two completes the log on restart and judges nothing twice. The delivery
  // comes last, so one killed before it leaves the events in the log for `status` and `wait`.
  const commitPoll = (emitted: PrEvent[]): void => {
    state.lastPoll = emitted;
    saveState(files, state);
    appendEvents(files, emitted);
  };

  // The classification reads what gh itself printed: the target's label and the daemon's own
  // messages can carry a repository or branch named auth or token.
  type PollError = { where: string; message: string; ghText: string };
  const troubleText = ({ where, message, ghText }: PollError): string => {
    const head = `polling failed ${MAX_CONSECUTIVE_POLL_FAILURES} times in a row (${where}: ${message}); not a verdict.`;
    return AUTH_ERROR.test(ghText.replace(QUOTED, ""))
      ? `${head} The error names authentication: run stop, then start the daemon again so gh hands it a fresh token; its log is ${files.log}`
      : `${head} Polling retries on the next interval`;
  };

  // A scoped poll, the one a `watch` triggers, judges CI for its target alone: judged on it, the
  // other targets' registration grace would be two reads seconds apart instead of two polls a
  // minute apart, and a gate registering in that minute would never be read.
  const poll = async (scope: Scope): Promise<number> => {
    const emitted: PrEvent[] = [];
    let lastError: PollError | null = null;
    const noteError = (where: string, message: string, ghText = ""): void => {
      lastError = { where, message, ghText };
      log(`poll: ${where}: ${message}`);
    };
    const noteGhError = (where: string, error: unknown): void => {
      if (!(error instanceof GhError)) throw error;
      noteError(where, error.message, error.stderr ?? "");
    };
    // A read refused because the session is gone ends the poll where it stands; the owner timer
    // does the shutdown.
    const refs = watchedRefs();
    try {
      try {
        if (refs.length > 0) {
          const rows = readRows(refs);
          for (const ref of refs) {
            const current = rows.get(prKey(ref));
            if (current === undefined) {
              noteError(prKey(ref), "not in the rows read (deleted, or no access?)");
              continue;
            }
            try {
              processRow(ref, current, emitted, judgingOf(scope, prKey(ref)));
            } catch (error) {
              noteGhError(prKey(ref), error);
            }
          }
        }
      } catch (error) {
        noteGhError("rows", error);
      }
      for (const key of Object.keys(state.commits)) {
        try {
          processCommit(key, emitted, judgingOf(scope, key));
        } catch (error) {
          noteGhError(key, error);
        }
      }
    } catch (error) {
      if (!(error instanceof AbortedRead)) throw error;
      log(`poll stopped: ${error.message}`);
      commitPoll(emitted);
      return emitted.length;
    }
    // The daemon's health is judged on full polls, which read every target: a scoped poll that
    // succeeds has not retried the read that failed, and one that fails is retried within a minute.
    if (scope === null) {
      const daemonWide = { repo: "", pr: null, sha: null, url: "", kind: "trouble" as const };
      if (lastError !== null) {
        failures += 1;
        if (failures === MAX_CONSECUTIVE_POLL_FAILURES) {
          troubled = true;
          emitted.push(emit({ ...daemonWide, text: troubleText(lastError) }));
        }
      } else {
        failures = 0;
        if (troubled) {
          troubled = false;
          emitted.push(emit({ ...daemonWide, text: "polling recovered" }));
        }
      }
    }
    commitPoll(emitted);
    await deliverDigest(emitted);
    return emitted.length;
  };

  const schedulePoll = (): void => {
    if (stopping) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      runPoll().catch((error: unknown) => log(`poll crashed: ${errorText(error)}`));
    }, intervalSeconds * 1000);
  };

  // A poll asked for while one is in flight follows it, whatever either's scope: two watches
  // queued behind one poll each get their own read. A scoped poll leaves the interval's clock
  // alone, so a `watch` never postpones the other targets' next read. Null: the daemon is stopping
  // and nothing was read.
  const runPoll = (scope: Scope = null): Promise<number | null> => {
    if (stopping) return Promise.resolve(null);
    if (polling) return polling.then(() => runPoll(scope));
    if (scope === null && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    polling = poll(scope).finally(() => {
      polling = null;
      if (scope === null) schedulePoll();
    });
    return polling;
  };

  // One shutdown, whoever asks first; a later stop waits for the same one. A poll in flight is
  // drained first: released earlier, the socket would let a replacement daemon start while this
  // one still delivers and saves over the replacement's state. The socket is gone and the state
  // saved before anyone is answered.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= drainAndStop(reason);
    return shuttingDown;
  };
  const drainAndStop = async (reason: string): Promise<void> => {
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(ownerTimer);
    if (polling) await polling.catch(() => {});
    saveState(files, state);
    // close() refuses new connections and leaves accepted ones open; a client that connected and
    // never wrote would hold the process up past "daemon stopped" through its pending read.
    server.close();
    for (const client of silent) client.setTimeout(SILENT_CLIENT_GRACE_MS, () => client.destroy());
    try {
      unlinkSync(files.socket);
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        log(`could not remove ${files.socket}: ${errorText(error)}`);
    }
    log(`daemon ${process.pid} stopped: ${reason}`);
    finish(0);
  };

  const ownerTimer = setInterval(() => {
    const reason = ownerGoneReason();
    if (reason !== null) void shutdown(reason);
  }, OWNER_CHECK_MS);

  // The flags of a call are the complete gate set. A watch restarts a pending judgment's grace, so
  // two calls seconds apart do not spend the polls meant to be a minute apart; a settled head is
  // judged again only when the set changed, so a corrected gate name gets its verdict.
  const subscribe = async (target: WatchTarget): Promise<number> => {
    let key: Scope;
    if (target.kind === "pr") {
      key = prKey(target);
      const previous = state.prs[key];
      state.prs[key] = { head: target.head, expected: target.expected, events: target.events };
      const row = state.rows[key];
      if (row && (row.ci.pending || !sameSet(previous?.expected ?? [], target.expected))) {
        // A changed gate set is a new contract: its verdict on the same runs is news.
        const sameGates = sameSet(previous?.expected ?? [], target.expected);
        row.ci = pendingCi(sameGates && row.ci.pending ? row.ci.priorRuns : null);
      }
    } else {
      key = commitKey(target.repo, target.sha);
      const previous = state.commits[key];
      state.commits[key] = {
        repo: target.repo,
        sha: target.sha,
        expected: target.expected,
        firstSeenAt: previous?.firstSeenAt ?? new Date().toISOString(),
        grace: freshGrace(),
      };
    }
    saveState(files, state);
    log(
      `watch ${describeTarget(target)} gates=${gates(target.expected)}${target.kind === "pr" ? narrowedTo(target.events) : ""}`,
    );
    // The target is saved for the next daemon; a poll for it would outlive this one's socket.
    if ((await runPoll(key)) === null) throw new Error(STOPPING_ERROR);
    return watchedCount();
  };

  const dispatch = async (command: Command): Promise<Reply> => {
    // A connection accepted before the stop can still carry a command; work it would add has no
    // poll left to run it.
    if (stopping && command.cmd !== "status" && command.cmd !== "stop") {
      return { ok: false, error: STOPPING_ERROR };
    }
    switch (command.cmd) {
      case "watch":
        return { ok: true, watched: await subscribe(command.target) };
      case "unwatch": {
        if (command.target === null) {
          for (const key of Object.keys(state.prs)) dropPr(key);
          for (const key of Object.keys(state.commits)) delete state.commits[key];
        } else if ("number" in command.target) {
          dropPr(prKey(command.target));
        } else {
          // The sha as given, or the one watched commit of that repository it is a prefix of.
          const { repo, sha } = command.target;
          const keys = Object.keys(state.commits).filter((key) =>
            key.startsWith(commitKey(repo, sha)),
          );
          if (keys.length > 1) {
            return {
              ok: false,
              error: `${repo}@${sha} names ${keys.length} watched commits: ${keys.map((key) => key.slice(repo.length + 1, repo.length + 1 + MIN_SHA_PREFIX)).join(", ")}; give more of the sha`,
            };
          }
          for (const key of keys) delete state.commits[key as CommitKey];
        }
        saveState(files, state);
        return { ok: true, watched: watchedCount() };
      }
      case "poll":
        return { ok: true, events: (await runPoll()) ?? 0 };
      case "status":
        return { ok: true, status: { pid: process.pid, state } };
      case "stop":
        await shutdown("stop command");
        return { ok: true };
    }
  };

  // The receiver of a delivery reports what became of it to the frame's `from`, this socket:
  // `{"type":"peer_message_status","orig_msg_id":"<msg_id>","state":"held"|...}`, no reply expected.
  const recordDeliveryStatus = (frame: { orig_msg_id?: unknown; state?: unknown }): void => {
    if (typeof frame.orig_msg_id !== "string" || typeof frame.state !== "string") {
      log("control: ignored a peer_message_status frame without orig_msg_id and state");
      return;
    }
    if (state.delivery === null || state.delivery.msgId !== frame.orig_msg_id) {
      log(`control: peer_message_status for an unknown delivery ${frame.orig_msg_id}; ignored`);
      return;
    }
    state.delivery.outcome = frame.state;
    saveState(files, state);
    log(`delivery of #${state.delivery.eventIds.join(",#")}: ${frame.state}`);
  };

  const handleLine = async (line: string, socket: Socket): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log("control: ignored a non-JSON frame");
      socket.end();
      return;
    }
    const frame = parsed as Partial<Command> & {
      type?: unknown;
      orig_msg_id?: unknown;
      state?: unknown;
    };
    if (typeof frame !== "object" || frame === null || typeof frame.cmd !== "string") {
      if (frame?.type === "peer_message_status") recordDeliveryStatus(frame);
      else log(`control: ignored a frame of type ${String(frame?.type ?? "unknown")}`);
      socket.end();
      return;
    }
    let reply: Reply;
    try {
      reply = await dispatch(frame as Command);
    } catch (error) {
      reply = { ok: false, error: errorText(error) };
      log(`control ${frame.cmd}: ${errorText(error)}`);
    }
    socket.end(`${JSON.stringify(reply)}\n`);
  };

  server.on("connection", (socket) => {
    silent.add(socket);
    socket.once("close", () => silent.delete(socket));
    firstLine(socket, "closed before a line").then(
      (line) => {
        silent.delete(socket);
        return handleLine(line, socket);
      },
      (error) => log(`control connection: ${errorText(error)}`),
    );
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // A restart with saved targets polls at once: what moved while the daemon was down is news.
  if (watchedCount() > 0) {
    runPoll().catch((error: unknown) => log(`poll crashed: ${errorText(error)}`));
  } else {
    schedulePoll();
  }
  return done;
}

async function cmdDaemon(dir: string, args: string[]): Promise<number> {
  const { values } = parse(
    args,
    { ...OWNER_OPTIONS, pid: { type: "string" }, interval: { type: "string" } },
    0,
  );
  const owner = resolveOwner(values);
  const interval = parsePositiveInt(values.interval, "--interval") ?? MIN_INTERVAL_SECONDS;
  if (interval < MIN_INTERVAL_SECONDS) {
    usage(`--interval must be at least ${MIN_INTERVAL_SECONDS} seconds, got: ${interval}`);
  }
  return runDaemon(owner, filesOf(dir, owner), interval);
}

// --- entry ---------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (process.platform === "win32") {
      throw new ToolingError(
        "Windows inboxes require an auth token this tool does not send; not supported",
      );
    }
    if (command === undefined) usage("missing <command>");
    const dir = runtimeDir();
    switch (command) {
      case "daemon":
        return await cmdDaemon(dir, rest);
      case "watch":
        return await cmdWatch(dir, rest);
      case "watch-commit":
        return await cmdWatchCommit(dir, rest);
      case "unwatch":
        return await cmdUnwatch(dir, rest);
      case "wait":
        return await cmdWait(dir, rest);
      case "poll":
        return await cmdPoll(dir, rest);
      case "status":
        return await cmdStatus(dir, rest);
      case "stop":
        return await cmdStop(dir, rest);
      default:
        usage(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${usageFor(command)}`);
      return 2;
    }
    if (error instanceof ToolingError || error instanceof RuntimeDirError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof NoDaemonError) {
      console.error(error.message);
      return 3;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
