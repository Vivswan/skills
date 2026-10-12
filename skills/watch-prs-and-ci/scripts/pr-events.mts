#!/usr/bin/env bun
// One poller per user for every PR and commit the user's sessions care about. Events (comments,
// reviews, head moves, CI verdicts, merge, close) are appended to a write-ahead log first and then
// delivered to each subscriber: a Claude Code inbox socket, or a file-sink reader blocking in `wait`.
//
// Exit codes: 0 ok; 2 usage, gh missing, no runtime directory, or the daemon unreachable after a
// spawn (stderr names the log); `wait` exits 3 at its timeout.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { discoverRuns, failedJobLog, judgeRuns, type Run, selectLatest } from "./check-suites.mts";
import { GhError } from "./gh.mts";
import {
  deliver,
  FROM_NAME,
  type InboxFrame,
  isLiveSubscriber,
  isProcessAlive,
  pidOf,
  renderEvent,
} from "./inbox.mts";
import { type Activity, newActivity, readPrDetail, viewerLogin } from "./pr-detail.mts";
import { type PrKey, type PrRef, prKey, type Row, readRows, rowChanged } from "./pr-rows.mts";
import {
  appendEvent,
  CONTROL_SOCKET,
  type CommitKey,
  commitKey,
  dropUnheldTargets,
  type EventInput,
  type Liveness,
  LOG_FILE,
  loadState,
  type Mode,
  type PrEvent,
  RuntimeDirError,
  readEventsSince,
  runtimeDir,
  type SavedRow,
  type Sink,
  type State,
  type Subscription,
  saveState,
} from "./state.mts";

// The Polling Budget floor: faster polling only spends the shared rate bucket.
const MIN_INTERVAL_SECONDS = 60;
const DEFAULT_IDLE_SECONDS = 600;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
const LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
// A workflow run can register a few seconds after the push; two polls before calling it missing.
const MISSING_GRACE_POLLS = 2;
const MAX_LOG_EXCERPTS = 3;
const MAX_BODY_CHARS = 2000;
const START_RETRY_MS = 100;
const START_TIMEOUT_MS = 5000;
const WAIT_TICK_MS = 1000;

const USAGE = [
  "usage: pr-events.mts <command> [options]",
  "  watch <owner/repo>#<n> --mode bypass|prompting [--head <sha>] [--expect-workflow <name>]... [sink options]",
  "  watch-commit <owner/repo> <sha> --mode bypass|prompting [--expect-workflow <name>]... [sink options]",
  "  unwatch <owner/repo>#<n> | --all          [sink options]",
  "  wait [--since <id>] [--timeout <s>] [--id <name>]",
  "  poll | status | stop",
  `  daemon [--interval <s>, at least ${MIN_INTERVAL_SECONDS}] [--idle-seconds <s>, default ${DEFAULT_IDLE_SECONDS}]`,
  "sink options: [--sink socket|file] [--id <name>] [--pid <pid>]",
  "  socket (default when CLAUDE_CODE_MESSAGING_SOCKET is set): events arrive as messages in that inbox",
  "  file (needs --id): events are read back with `wait`, which renews a 24 h lease; --pid <pid> prunes on that pid's death instead",
].join("\n");

class UsageError extends Error {}
class ToolingError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// --- control protocol --------------------------------------------------------

type WatchTarget =
  | { kind: "pr"; repo: string; number: number; head: string | null; expected: string[] }
  | { kind: "commit"; repo: string; sha: string; expected: string[] };

interface SinkChoice {
  sink: Sink;
  address: string;
  pid: number | null;
}

type Command =
  | { cmd: "watch"; sink: SinkChoice; mode: Mode; target: WatchTarget }
  | { cmd: "unwatch"; address: string; pr: PrRef | null }
  | { cmd: "renew"; address: string }
  | { cmd: "poll" }
  | { cmd: "status" }
  | { cmd: "stop" };

interface StatusReply {
  pid: number;
  state: State;
}

type Reply =
  | { ok: true; events?: number; subscribers?: number; status?: StatusReply }
  | { ok: false; error: string };

function controlSocketPath(dir: string): string {
  return join(dir, CONTROL_SOCKET);
}

async function connectOnce(path: string): Promise<Socket> {
  const socket = connect(path);
  await once(socket, "connect");
  return socket;
}

function exchange(socket: Socket, command: Command): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Reply);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("close", () =>
      reject(new ToolingError("the daemon closed the connection without a reply")),
    );
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

function spawnDaemon(dir: string): void {
  const logFd = openSync(join(dir, LOG_FILE), "a", 0o600);
  try {
    // The daemon's cwd is the runtime dir itself, so the dir travels resolved, never relative.
    const child = Bun.spawn([process.execPath, import.meta.path, "daemon"], {
      cwd: dir,
      env: { ...process.env, PR_EVENTS_DIR: dir },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function isNobodyListening(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function findOrStart(dir: string): Promise<Socket> {
  const path = controlSocketPath(dir);
  try {
    return await connectOnce(path);
  } catch (error) {
    if (!isNobodyListening(error)) throw error;
  }
  spawnDaemon(dir);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(START_RETRY_MS);
    try {
      return await connectOnce(path);
    } catch (error) {
      if (!isNobodyListening(error)) throw error;
    }
  }
  throw new ToolingError(
    `the daemon did not answer on ${path} within ${START_TIMEOUT_MS / 1000} s; see ${join(dir, LOG_FILE)}`,
  );
}

async function requestStarting(dir: string, command: Command): Promise<Reply> {
  return exchange(await findOrStart(dir), command);
}

async function requestRunning(dir: string, command: Command): Promise<Reply | null> {
  let socket: Socket;
  try {
    socket = await connectOnce(controlSocketPath(dir));
  } catch (error) {
    if (isNobodyListening(error)) return null;
    throw error;
  }
  return exchange(socket, command);
}

function unwrap(reply: Reply): Reply & { ok: true } {
  if (!reply.ok) throw new ToolingError(`daemon: ${reply.error}`);
  return reply;
}

// --- argument parsing --------------------------------------------------------

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TARGET_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseTarget(target: string | undefined): PrRef {
  if (target === undefined) usage("missing <owner/repo>#<n>");
  const match = TARGET_PATTERN.exec(target);
  if (!match) usage(`target must be <owner/repo>#<n>, got: ${target}`);
  return { repo: match[1] as string, number: Number(match[2]) };
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    usage(`${flag} must be a positive whole number, got: ${value}`);
  }
  return Number(value);
}

function parseMode(value: string | undefined): Mode {
  if (value === "bypass" || value === "prompting") return value;
  if (value === undefined) {
    usage(
      "--mode is required: bypass when this session runs without permission prompts, prompting otherwise",
    );
  }
  usage(`--mode must be bypass or prompting, got: ${value}`);
}

// A workflow name is matched exactly, commas and all; one flag carries one name.
function parseExpected(values: string[] | undefined): string[] {
  const names = values ?? [];
  if (names.some((name) => name.trim() === "")) usage("--expect-workflow needs a workflow name");
  return [...new Set(names)].sort();
}

function parseSink(values: { sink?: string; id?: string; pid?: string }): SinkChoice {
  const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const sink = values.sink ?? (inbox ? "socket" : "file");
  if (sink !== "socket" && sink !== "file") usage(`--sink must be socket or file, got: ${sink}`);
  const pid = parsePositiveInt(values.pid, "--pid") ?? null;
  if (sink === "socket") {
    if (!inbox) {
      usage(
        "the socket sink needs CLAUDE_CODE_MESSAGING_SOCKET (a Claude Code session's inbox); outside one, pass --sink file --id <name>",
      );
    }
    if (pid !== null)
      usage("--pid applies to the file sink; an inbox is named by its session's pid");
    return { sink, address: inbox, pid: pidOf(inbox) };
  }
  if (!values.id) usage("the file sink needs --id <name>, the name `wait --id` reads back with");
  // Ids key plain objects that come back from JSON, so a name an object inherits cannot be one.
  if (!ID_PATTERN.test(values.id) || values.id in Object.prototype) {
    usage(`--id must be a name of letters, digits, . _ or -, not ${values.id}`);
  }
  return { sink, address: values.id, pid };
}

function requireGh(): void {
  if (Bun.which("gh") === null) {
    throw new ToolingError("gh not found on PATH; install and authenticate the GitHub CLI");
  }
}

const SINK_OPTIONS = {
  sink: { type: "string" },
  id: { type: "string" },
  pid: { type: "string" },
} as const;

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

// --- CLI commands -------------------------------------------------------------

function describeTarget(target: WatchTarget): string {
  return target.kind === "pr"
    ? `${target.repo}#${target.number}`
    : `${target.repo}@${target.sha.slice(0, 12)}`;
}

async function watch(
  dir: string,
  sink: SinkChoice,
  mode: Mode,
  target: WatchTarget,
): Promise<number> {
  requireGh();
  const reply = unwrap(await requestStarting(dir, { cmd: "watch", sink, mode, target }));
  console.log(
    `watching ${describeTarget(target)} for ${sink.sink} ${sink.address} (mode ${mode}); ${reply.subscribers} subscriber(s)`,
  );
  return 0;
}

async function cmdWatch(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      ...SINK_OPTIONS,
      mode: { type: "string" },
      head: { type: "string" },
      "expect-workflow": { type: "string", multiple: true },
    },
    1,
  );
  const ref = parseTarget(positionals[0]);
  const mode = parseMode(values.mode);
  if (values.head !== undefined && !SHA_PATTERN.test(values.head)) {
    usage(`--head must be a full 40-character lowercase sha, got: ${values.head}`);
  }
  return watch(dir, parseSink(values), mode, {
    kind: "pr",
    ...ref,
    head: values.head ?? null,
    expected: parseExpected(values["expect-workflow"]),
  });
}

async function cmdWatchCommit(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      ...SINK_OPTIONS,
      mode: { type: "string" },
      "expect-workflow": { type: "string", multiple: true },
    },
    2,
  );
  const [repo, sha] = positionals;
  if (repo === undefined || !REPO_PATTERN.test(repo)) {
    usage(`watch-commit needs <owner/repo>, got: ${repo ?? "nothing"}`);
  }
  if (sha === undefined || !SHA_PATTERN.test(sha)) {
    usage(`watch-commit needs a full 40-character lowercase sha, got: ${sha ?? "nothing"}`);
  }
  const mode = parseMode(values.mode);
  return watch(dir, parseSink(values), mode, {
    kind: "commit",
    repo,
    sha,
    expected: parseExpected(values["expect-workflow"]),
  });
}

/** The daemon owns state.json while it runs; with none running the CLI edits it in place. */
function unwatchOffline(dir: string, address: string, pr: PrRef | null): void {
  const state = loadState(dir);
  const sub = state.subscriptions[address];
  if (!sub) return;
  if (pr === null) delete state.subscriptions[address];
  else delete sub.prs[prKey(pr)];
  dropUnheldTargets(state);
  saveState(dir, state);
}

async function cmdUnwatch(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...SINK_OPTIONS, all: { type: "boolean" } }, 1);
  if (values.all === true && positionals.length > 0) usage("--all takes no target");
  const pr = values.all === true ? null : parseTarget(positionals[0]);
  const { address } = parseSink(values);
  const reply = await requestRunning(dir, { cmd: "unwatch", address, pr });
  if (reply === null) unwatchOffline(dir, address, pr);
  else unwrap(reply);
  console.log(
    pr === null
      ? `unwatched everything for ${address}`
      : `unwatched ${pr.repo}#${pr.number} for ${address}`,
  );
  return 0;
}

async function cmdPoll(dir: string): Promise<number> {
  requireGh();
  const reply = unwrap(await requestStarting(dir, { cmd: "poll" }));
  console.log(`polled; ${reply.events} event(s)`);
  return 0;
}

async function cmdStop(dir: string): Promise<number> {
  const reply = await requestRunning(dir, { cmd: "stop" });
  if (reply === null) {
    console.log("no daemon running");
    return 0;
  }
  unwrap(reply);
  console.log("daemon stopped");
  return 0;
}

function describeLiveness(liveness: Liveness): string {
  switch (liveness.kind) {
    case "inbox":
      return `pid=${liveness.pid ?? "-"}`;
    case "pid":
      return `pid=${liveness.pid}`;
    case "lease":
      return `lease=${liveness.until}`;
  }
}

function describeDelivery(delivery: State["deliveries"][string] | undefined): string {
  return delivery ? `${delivery.outcome} (#${delivery.eventId} at ${delivery.at})` : "none";
}

function subjectOf(event: Pick<PrEvent, "repo" | "pr" | "sha">): string {
  if (event.pr !== null) return `${event.repo}#${event.pr}`;
  if (event.sha !== null) return `${event.repo}@${event.sha.slice(0, 12)}`;
  return "daemon";
}

async function cmdStatus(dir: string): Promise<number> {
  const reply = await requestRunning(dir, { cmd: "status" });
  const status = reply === null ? null : unwrap(reply).status;
  const state = status?.state ?? loadState(dir);
  const lines = [
    status ? `daemon: running (pid ${status.pid})` : "daemon: not running",
    `dir: ${dir}`,
    `log: ${join(dir, LOG_FILE)}`,
  ];
  const subscriptions = Object.values(state.subscriptions);
  lines.push(`subscribers: ${subscriptions.length}`);
  for (const sub of subscriptions) {
    const prs = Object.keys(sub.prs).join(",") || "-";
    const commits =
      Object.values(sub.commits)
        .map((commit) => `${commit.repo}@${commit.sha.slice(0, 12)}`)
        .join(",") || "-";
    lines.push(
      `  ${sub.sink} ${sub.address} mode=${sub.mode} ${describeLiveness(sub.liveness)} prs=${prs} commits=${commits} delivery=${describeDelivery(state.deliveries[sub.address])}`,
    );
  }
  const pruned = Object.entries(state.pruned);
  if (pruned.length > 0) {
    lines.push(`former subscribers: ${pruned.length}`);
    for (const [address, { reason, at }] of pruned) {
      lines.push(
        `  ${address} pruned=${reason} at ${at} delivery=${describeDelivery(state.deliveries[address])}`,
      );
    }
  }
  const rows = Object.entries(state.rows);
  lines.push(`prs: ${rows.length}`);
  for (const [key, row] of rows) {
    lines.push(
      `  ${key} head=${row.headRefOid.slice(0, 12)} state=${row.state} ci=${row.ciPending ? "pending" : "settled"} updated=${row.updatedAt}`,
    );
  }
  const commits = Object.values(state.pendingCommits);
  lines.push(`pending commits: ${commits.length}`);
  for (const commit of commits) {
    lines.push(`  ${commit.repo}@${commit.sha.slice(0, 12)} since ${commit.firstSeenAt}`);
  }
  const last = readEventsSince(dir, state.lastEventId - 1).at(-1);
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
    { since: { type: "string" }, timeout: { type: "string" }, id: { type: "string" } },
    0,
  );
  let since: number;
  if (values.since === undefined) {
    since = loadState(dir).lastEventId;
  } else {
    if (!/^\d+$/.test(values.since) || !Number.isSafeInteger(Number(values.since))) {
      usage(`--since must be a whole number, got: ${values.since}`);
    }
    since = Number(values.since);
  }
  const timeoutSeconds =
    parsePositiveInt(values.timeout, "--timeout") ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  const id = values.id;
  const matches = (event: PrEvent): boolean => id === undefined || event.to.includes(id);
  if (id !== undefined) await requestRunning(dir, { cmd: "renew", address: id });
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const events = readEventsSince(dir, since).filter(matches);
    if (events.length > 0) {
      for (const event of events) console.log(JSON.stringify(event));
      console.log(`cursor: ${(events.at(-1) as PrEvent).id}`);
      return 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(`no event after ${timeoutSeconds}s`);
      console.log(`cursor: ${since}`);
      return 3;
    }
    await sleep(Math.min(WAIT_TICK_MS, remaining));
  }
}

// --- daemon -------------------------------------------------------------------

const BIND_LOCK_WAIT_MS = 5000;
// A lock older than this was left by a daemon that died inside the critical section.
const BIND_LOCK_STALE_MS = 10_000;

/**
 * Binding the control socket is the single-instance lock. Replacing a stale socket file is a
 * probe, an unlink, and a bind, which two daemons starting at once would interleave (the second
 * unlinks the first's live socket), so that sequence runs under a directory lock: mkdir is atomic.
 */
async function bindControlSocket(
  path: string,
  log: (line: string) => void,
): Promise<Server | null> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + BIND_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const held = statSync(lock, { throwIfNoEntry: false });
      if (held && Date.now() - held.mtimeMs > BIND_LOCK_STALE_MS) {
        log(`removing the stale bind lock ${lock}`);
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${lock} held for over ${BIND_LOCK_WAIT_MS} ms`);
      await sleep(50);
    }
  }
  try {
    try {
      (await connectOnce(path)).destroy();
      log(`another daemon answers on ${path}; exiting`);
      return null;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ECONNREFUSED" && code !== "ENOENT") throw error;
      if (code === "ECONNREFUSED") {
        log(`replacing the stale control socket ${path}`);
        unlinkSync(path);
      }
    }
    const server = createServer();
    server.listen(path);
    await once(server, "listening");
    chmodSync(path, 0o600);
    return server;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...` : text;
}

function describeActivities(activities: Activity[]): { kind: "comment" | "review"; text: string } {
  const reviews = activities.filter((activity) => activity.kind === "review");
  const comments = activities.filter((activity) => activity.kind !== "review");
  const summary = reviews.map(
    (review) => `new review by ${review.author} (${review.reviewState ?? "COMMENTED"})`,
  );
  if (comments.length > 0) {
    const authors = [...new Set(comments.map((comment) => comment.author))].join(", ");
    summary.push(`${comments.length} new comment${comments.length === 1 ? "" : "s"} by ${authors}`);
  }
  const lines = [summary.join(", ")];
  for (const activity of activities) {
    const body = clip(flatten(activity.body));
    if (body === "") continue;
    const where =
      activity.path !== undefined
        ? `${activity.path}${typeof activity.line === "number" ? `:${activity.line}` : ""}`
        : activity.author;
    lines.push(`  ${where}  ${body}`);
  }
  return { kind: reviews.length > 0 ? "review" : "comment", text: lines.join("\n") };
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

function describeGreen(sha: string, runs: Run[]): string {
  const names = [...new Set(selectLatest(runs).map((run) => run.name))].sort();
  return `CI green on ${sha.slice(0, 12)}: ${names.join(", ")}`;
}

function describeRed(repo: string, sha: string, runs: Run[], verdictLines: string[]): string {
  const lines = [`CI red on ${sha.slice(0, 12)}`, ...indent(verdictLines)];
  const failed = selectLatest(runs).filter(isFailedRun);
  for (const run of failed.slice(0, MAX_LOG_EXCERPTS)) {
    const excerpt = failedJobLog(repo, run.id);
    if (excerpt === "") continue;
    lines.push(
      `  --- ${run.name} (${run.id}) failed-step log tail ---`,
      ...indent(excerpt.split("\n")),
    );
  }
  if (failed.length > MAX_LOG_EXCERPTS) {
    lines.push(`  ${failed.length - MAX_LOG_EXCERPTS} more failed run(s) without an excerpt`);
  }
  return lines.join("\n");
}

function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}/checks`;
}

function union(lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

function leaseFrom(now: number): string {
  return new Date(now + LEASE_MS).toISOString();
}

function livenessOf(sink: SinkChoice, now: number): Liveness {
  if (sink.sink === "socket") return { kind: "inbox", pid: sink.pid };
  if (sink.pid !== null) return { kind: "pid", pid: sink.pid };
  return { kind: "lease", until: leaseFrom(now) };
}

function prunedReason(sub: Subscription, now: number): string | null {
  const { liveness } = sub;
  switch (liveness.kind) {
    case "inbox":
      return isLiveSubscriber(sub.address, liveness.pid)
        ? null
        : "inbox gone or its session exited";
    case "pid":
      return isProcessAlive(liveness.pid) ? null : `pid ${liveness.pid} exited`;
    case "lease":
      return Date.parse(liveness.until) > now ? null : "lease lapsed without a wait";
  }
}

async function runDaemon(
  dir: string,
  intervalSeconds: number,
  idleSeconds: number,
): Promise<number> {
  const logPath = join(dir, LOG_FILE);
  const log = (line: string) => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  const socketPath = controlSocketPath(dir);
  const state = loadState(dir);
  const server = await bindControlSocket(socketPath, log);
  if (server === null) return 0;
  log(`daemon ${process.pid} listening on ${socketPath}; poll every ${intervalSeconds} s`);

  let polling: Promise<number> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSince: number | null = null;
  let failures = 0;
  let troubled = false;
  let viewer: string | null = null;
  let stopping = false;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const viewerLoginCached = (): string => {
    if (viewer === null) viewer = viewerLogin();
    return viewer;
  };

  const subscribers = (): Subscription[] => Object.values(state.subscriptions);
  const subscribersOfPr = (key: PrKey): Subscription[] =>
    subscribers().filter((sub) => key in sub.prs);
  const subscribersOfCommit = (key: CommitKey): Subscription[] =>
    subscribers().filter((sub) => key in sub.commits);

  const emit = (input: Omit<EventInput, "to">, targets: Subscription[]): PrEvent => {
    const event = appendEvent(dir, state, { ...input, to: targets.map((sub) => sub.address) });
    log(`event #${event.id} ${event.kind} ${subjectOf(event)}: ${event.text.split("\n")[0]}`);
    return event;
  };

  const checkIdle = (): void => {
    if (stopping) return;
    if (subscribers().length > 0) {
      idleSince = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      return;
    }
    if (idleSince === null) idleSince = Date.now();
    if (idleTimer) return;
    const remaining = idleSince + idleSeconds * 1000 - Date.now();
    idleTimer = setTimeout(
      () => {
        idleTimer = null;
        if (subscribers().length === 0) {
          log(`no subscribers for ${idleSeconds} s; exiting`);
          shutdown();
        }
      },
      Math.max(0, remaining),
    );
  };

  const dropSubscription = (sub: Subscription, reason: string): void => {
    delete state.subscriptions[sub.address];
    dropUnheldTargets(state);
    state.pruned[sub.address] = { at: new Date().toISOString(), reason };
    log(`pruned ${sub.sink} ${sub.address}: ${reason}`);
  };

  const dropEmptySubscriptions = (): void => {
    for (const sub of subscribers()) {
      if (Object.keys(sub.prs).length === 0 && Object.keys(sub.commits).length === 0) {
        dropSubscription(sub, "nothing left to watch");
      }
    }
  };

  const prune = (): void => {
    const now = Date.now();
    dropEmptySubscriptions();
    for (const sub of subscribers()) {
      const reason = prunedReason(sub, now);
      if (reason !== null) dropSubscription(sub, reason);
    }
    for (const [address, { at }] of Object.entries(state.pruned)) {
      if (Date.parse(at) + LEASE_MS <= now) {
        delete state.pruned[address];
        delete state.deliveries[address];
      }
    }
  };

  const judgeCi = (
    repo: string,
    sha: string,
    expected: string[],
    subject: { pr: number | null; url: string },
    targets: Subscription[],
    grace: { missingPolls: number },
    emitted: PrEvent[],
  ): boolean => {
    const runs = discoverRuns(repo, sha);
    const verdict = judgeRuns(runs, expected);
    const base = { repo, pr: subject.pr, sha, url: subject.url };
    // No run at all is a registration that has not happened yet, or a ref nothing triggers on;
    // the grace below decides which, as it does for a named gate.
    const kind = verdict.kind === "pending" && runs.length === 0 ? "missing" : verdict.kind;
    switch (kind) {
      case "pending":
        grace.missingPolls = 0;
        return false;
      case "green":
        emitted.push(emit({ ...base, kind: "ci", text: describeGreen(sha, runs) }, targets));
        return true;
      case "red":
        emitted.push(
          emit({ ...base, kind: "ci", text: describeRed(repo, sha, runs, verdict.lines) }, targets),
        );
        return true;
      case "missing":
      case "trouble":
        // Noticed once, at the grace; the sha stays judged, so a run that registers late still
        // gets its verdict.
        grace.missingPolls += 1;
        if (grace.missingPolls !== MISSING_GRACE_POLLS) return false;
        emitted.push(
          emit(
            {
              ...base,
              kind: "trouble",
              text: [
                `CI ${kind === "missing" ? "run not registered" : "read gave no verdict"} on ${sha.slice(0, 12)} after ${grace.missingPolls} polls; not a verdict`,
                ...indent(verdict.lines),
              ].join("\n"),
            },
            targets,
          ),
        );
        return false;
    }
  };

  const dropPr = (key: PrKey): void => {
    for (const sub of subscribersOfPr(key)) delete sub.prs[key];
    delete state.rows[key];
  };

  const addPendingCommit = (repo: string, sha: string): void => {
    state.pendingCommits[commitKey(repo, sha)] ??= {
      repo,
      sha,
      firstSeenAt: new Date().toISOString(),
      missingPolls: 0,
    };
  };

  // The row is saved as soon as its own events are out, before the CI read: a CI read that fails
  // must not replay the comment or head event on the next poll.
  const processRow = (ref: PrRef, current: Row, emitted: PrEvent[]): void => {
    const key = prKey(ref);
    const saved = state.rows[key];
    const targets = subscribersOfPr(key);
    const expected = union(targets.map((sub) => (sub.prs[key] as { expected: string[] }).expected));
    const recordedHeads = new Set(
      targets
        .map((sub) => (sub.prs[key] as { head: string | null }).head)
        .filter((h) => h !== null),
    );
    const base = { repo: ref.repo, pr: ref.number, sha: current.headRefOid, url: current.url };
    const row: SavedRow = {
      ...current,
      ciPending: saved?.ciPending ?? true,
      missingPolls: saved?.missingPolls ?? 0,
    };
    const headMoved = saved ? current.headRefOid !== saved.headRefOid : recordedHeads.size > 0;
    const changes = rowChanged(saved, current);
    let detail: ReturnType<typeof readPrDetail> | null = null;
    if (saved && changes.activity) {
      detail = readPrDetail(ref);
      const activities = newActivity(detail, saved.updatedAt, viewerLoginCached());
      if (activities.length > 0) {
        const { kind, text } = describeActivities(activities);
        emitted.push(emit({ ...base, kind, text }, targets));
      }
    }
    if (headMoved && !recordedHeads.has(current.headRefOid)) {
      detail ??= readPrDetail(ref);
      emitted.push(
        emit(
          {
            ...base,
            kind: "head",
            text: `head moved to ${current.headRefOid.slice(0, 12)} by ${detail.lastCommitAuthor ?? "an unknown author"}`,
          },
          targets,
        ),
      );
    }
    if (saved && (changes.head || changes.rollup)) {
      row.ciPending = true;
      if (changes.head) row.missingPolls = 0;
    }
    if (current.state === "MERGED") {
      const oid = current.mergeCommitOid;
      emitted.push(
        emit(
          {
            ...base,
            kind: "merged",
            text: oid
              ? `merged at ${current.mergedAt ?? "an unknown time"}; mainline commit ${oid.slice(0, 12)} is now watched for CI`
              : `merged at ${current.mergedAt ?? "an unknown time"}; no merge commit reported`,
          },
          targets,
        ),
      );
      if (oid) {
        for (const sub of targets) {
          const previous = sub.commits[commitKey(ref.repo, oid)];
          sub.commits[commitKey(ref.repo, oid)] = {
            repo: ref.repo,
            sha: oid,
            expected: union([
              previous?.expected ?? [],
              (sub.prs[key] as { expected: string[] }).expected,
            ]),
          };
        }
        addPendingCommit(ref.repo, oid);
      }
      dropPr(key);
      return;
    }
    if (current.state === "CLOSED") {
      emitted.push(emit({ ...base, kind: "closed", text: "closed without merging" }, targets));
      dropPr(key);
      return;
    }
    state.rows[key] = row;
    if (row.ciPending) {
      const settled = judgeCi(
        ref.repo,
        current.headRefOid,
        expected,
        { pr: ref.number, url: current.url },
        targets,
        row,
        emitted,
      );
      if (settled) {
        row.ciPending = false;
        row.missingPolls = 0;
      }
    }
  };

  const processCommit = (key: CommitKey, emitted: PrEvent[]): void => {
    const pending = state.pendingCommits[key];
    if (!pending) return;
    const targets = subscribersOfCommit(key);
    const expected = union(
      targets.map((sub) => (sub.commits[key] as { expected: string[] }).expected),
    );
    const settled = judgeCi(
      pending.repo,
      pending.sha,
      expected,
      { pr: null, url: commitUrl(pending.repo, pending.sha) },
      targets,
      pending,
      emitted,
    );
    if (!settled) return;
    for (const sub of targets) delete sub.commits[key];
    delete state.pendingCommits[key];
  };

  const deliverAll = async (emitted: PrEvent[]): Promise<void> => {
    for (const event of emitted) {
      for (const address of event.to) {
        const sub = state.subscriptions[address];
        if (sub?.sink !== "socket") continue;
        const frame: InboxFrame = {
          type: "user",
          message: { role: "user", content: renderEvent(event) },
          from: `uds:${socketPath}`,
          from_name: FROM_NAME,
          from_mode: sub.mode,
          msg_id: `pr-events-${event.id}-${randomUUID()}`,
        };
        const at = new Date().toISOString();
        try {
          await deliver(address, frame);
          state.deliveries[address] = { eventId: event.id, at, outcome: "sent" };
        } catch (error) {
          const code = errorCode(error) ?? errorText(error);
          state.deliveries[address] = { eventId: event.id, at, outcome: `failed: ${code}` };
          log(`delivery of #${event.id} to ${address} failed: ${code}`);
          if (isNobodyListening(error)) dropSubscription(sub, `inbox refused (${code})`);
        }
      }
    }
  };

  const subscribedRefs = (): PrRef[] => {
    const refs = new Map<PrKey, PrRef>();
    for (const sub of subscribers()) {
      for (const key of Object.keys(sub.prs)) {
        const [repo, number] = key.split("#") as [string, string];
        refs.set(key, { repo, number: Number(number) });
      }
    }
    return [...refs.values()];
  };

  const poll = async (): Promise<number> => {
    prune();
    const emitted: PrEvent[] = [];
    let lastError: string | null = null;
    const noteGhError = (where: string, error: unknown): void => {
      if (!(error instanceof GhError)) throw error;
      lastError = `${where}: ${error.message}`;
      log(`poll: ${lastError}`);
    };
    const refs = subscribedRefs();
    try {
      if (refs.length > 0) {
        const rows = readRows(refs);
        for (const ref of refs) {
          const current = rows.get(prKey(ref));
          if (current === undefined) {
            lastError = `${prKey(ref)}: not in the rows read (deleted, or no access?)`;
            log(`poll: ${lastError}`);
            continue;
          }
          try {
            processRow(ref, current, emitted);
          } catch (error) {
            noteGhError(prKey(ref), error);
          }
        }
      }
    } catch (error) {
      noteGhError("rows", error);
    }
    for (const key of Object.keys(state.pendingCommits)) {
      try {
        processCommit(key, emitted);
      } catch (error) {
        noteGhError(key, error);
      }
    }
    const everyone = subscribers();
    const daemonWide = { repo: "", pr: null, sha: null, url: "", kind: "trouble" as const };
    if (lastError !== null) {
      failures += 1;
      if (failures === MAX_CONSECUTIVE_POLL_FAILURES) {
        troubled = true;
        emitted.push(
          emit(
            {
              ...daemonWide,
              text: `polling failed ${failures} times in a row (${lastError}); not a verdict. Auth errors in ${logPath}: run stop, then watch again`,
            },
            everyone,
          ),
        );
      }
    } else {
      failures = 0;
      if (troubled) {
        troubled = false;
        emitted.push(emit({ ...daemonWide, text: "polling recovered" }, everyone));
      }
    }
    await deliverAll(emitted);
    dropEmptySubscriptions();
    saveState(dir, state);
    checkIdle();
    return emitted.length;
  };

  const schedulePoll = (): void => {
    if (stopping) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      runPoll().catch((error: unknown) => log(`poll crashed: ${errorText(error)}`));
    }, intervalSeconds * 1000);
  };

  const runPoll = (): Promise<number> => {
    if (polling) return polling;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    polling = poll().finally(() => {
      polling = null;
      schedulePoll();
    });
    return polling;
  };

  // Synchronous on purpose: the socket is gone and the state saved before anyone is answered. A
  // delivery still in flight finishes on its own and the process exits with it.
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (idleTimer) clearTimeout(idleTimer);
    saveState(dir, state);
    server.close();
    try {
      unlinkSync(socketPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") log(`could not remove ${socketPath}: ${errorText(error)}`);
    }
    log(`daemon ${process.pid} stopped`);
    finish(0);
  };

  const subscribe = async (sink: SinkChoice, mode: Mode, target: WatchTarget): Promise<number> => {
    const now = Date.now();
    const sub: Subscription = state.subscriptions[sink.address] ?? {
      sink: sink.sink,
      address: sink.address,
      mode,
      liveness: livenessOf(sink, now),
      prs: {},
      commits: {},
    };
    sub.mode = mode;
    sub.liveness = livenessOf(sink, now);
    if (target.kind === "pr") {
      const key = prKey(target);
      const previous = sub.prs[key];
      const expected = union([previous?.expected ?? [], target.expected]);
      sub.prs[key] = { head: target.head, expected };
      // A gate named now was not judged by a verdict already settled on this head.
      const row = state.rows[key];
      if (row && expected.length > (previous?.expected.length ?? 0)) row.ciPending = true;
    } else {
      const key = commitKey(target.repo, target.sha);
      const previous = sub.commits[key];
      sub.commits[key] = {
        repo: target.repo,
        sha: target.sha,
        expected: union([previous?.expected ?? [], target.expected]),
      };
      addPendingCommit(target.repo, target.sha);
    }
    state.subscriptions[sink.address] = sub;
    delete state.pruned[sink.address];
    saveState(dir, state);
    checkIdle();
    log(`watch ${sink.sink} ${sink.address} (${mode}): ${describeTarget(target)}`);
    if (polling) await polling;
    await runPoll();
    return subscribers().length;
  };

  const dispatch = async (command: Command): Promise<Reply> => {
    switch (command.cmd) {
      case "watch":
        return {
          ok: true,
          subscribers: await subscribe(command.sink, command.mode, command.target),
        };
      case "unwatch": {
        const sub = state.subscriptions[command.address];
        if (sub) {
          if (command.pr === null) delete state.subscriptions[command.address];
          else delete sub.prs[prKey(command.pr)];
          dropUnheldTargets(state);
          prune();
          saveState(dir, state);
          checkIdle();
        }
        return { ok: true, subscribers: subscribers().length };
      }
      case "renew": {
        const sub = state.subscriptions[command.address];
        if (sub?.liveness.kind === "lease") {
          sub.liveness = { kind: "lease", until: leaseFrom(Date.now()) };
          saveState(dir, state);
        }
        return { ok: true };
      }
      case "poll":
        return { ok: true, events: await runPoll() };
      case "status":
        return { ok: true, status: { pid: process.pid, state } };
      case "stop":
        shutdown();
        return { ok: true };
    }
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
    const frame = parsed as Partial<Command> & { type?: unknown };
    if (typeof frame !== "object" || frame === null || typeof frame.cmd !== "string") {
      log(`control: ignored a frame of type ${String(frame?.type ?? "unknown")}`);
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
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("error", (error) => log(`control connection: ${errorText(error)}`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      socket.removeAllListeners("data");
      void handleLine(line, socket);
    });
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  checkIdle();
  schedulePoll();
  return done;
}

async function cmdDaemon(dir: string, args: string[]): Promise<number> {
  const { values } = parse(
    args,
    { interval: { type: "string" }, "idle-seconds": { type: "string" } },
    0,
  );
  const interval = parsePositiveInt(values.interval, "--interval") ?? MIN_INTERVAL_SECONDS;
  if (interval < MIN_INTERVAL_SECONDS) {
    usage(`--interval must be at least ${MIN_INTERVAL_SECONDS} seconds, got: ${interval}`);
  }
  const idle = parsePositiveInt(values["idle-seconds"], "--idle-seconds") ?? DEFAULT_IDLE_SECONDS;
  requireGh();
  return runDaemon(dir, interval, idle);
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
      case "watch":
        return await cmdWatch(dir, rest);
      case "watch-commit":
        return await cmdWatchCommit(dir, rest);
      case "unwatch":
        return await cmdUnwatch(dir, rest);
      case "wait":
        return await cmdWait(dir, rest);
      case "poll":
        return await cmdPoll(dir);
      case "status":
        return await cmdStatus(dir);
      case "stop":
        return await cmdStop(dir);
      case "daemon":
        return await cmdDaemon(dir, rest);
      default:
        usage(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof ToolingError || error instanceof RuntimeDirError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
