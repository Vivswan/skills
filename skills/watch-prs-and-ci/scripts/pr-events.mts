#!/usr/bin/env bun
// One poller per user for every PR and commit the user's sessions care about. Events (comments,
// reviews, head moves, CI verdicts, merge, close) are appended to a write-ahead log first and then
// delivered to each subscriber: a Claude Code inbox socket, or a file-sink reader blocking in `wait`.
//
// Exit codes: 0 ok; 2 usage, gh missing, no runtime directory, or the daemon unreachable after a
// spawn (stderr names the log); `wait` exits 3 at its timeout.

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, openSync, unlinkSync } from "node:fs";
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
  type EventInput,
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
// A gate workflow can register a few seconds after the push; two polls before calling it missing.
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
  "  file (needs --id): events are read back with `wait`, which renews a 24 h lease; --pid prunes on that pid's death instead",
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

interface WatchPr {
  repo: string;
  number: number;
  head: string | null;
  expected: string[];
}

interface WatchCommit {
  repo: string;
  sha: string;
  expected: string[];
}

interface SinkChoice {
  sink: Sink;
  address: string;
  pid: number | null;
}

type Command =
  | { cmd: "watch"; sink: SinkChoice; mode: Mode; pr: WatchPr | null; commit: WatchCommit | null }
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

function connectOnce(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** One request, one JSON reply line, on an already connected socket. */
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
    socket.on("close", () => reject(new Error("the daemon closed the connection without a reply")));
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

function spawnDaemon(dir: string): void {
  const logFd = openSync(join(dir, LOG_FILE), "a", 0o600);
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "daemon"], {
      cwd: dir,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

async function findOrStart(dir: string): Promise<Socket> {
  const path = controlSocketPath(dir);
  try {
    return await connectOnce(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
  }
  spawnDaemon(dir);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(START_RETRY_MS);
    try {
      return await connectOnce(path);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
  }
  throw new ToolingError(
    `the daemon did not answer on ${path} within ${START_TIMEOUT_MS / 1000} s; see ${join(dir, LOG_FILE)}`,
  );
}

async function requestStarting(dir: string, command: Command): Promise<Reply> {
  return exchange(await findOrStart(dir), command);
}

/** A request to a daemon that must already run; null when none does. */
async function requestRunning(dir: string, command: Command): Promise<Reply | null> {
  let socket: Socket;
  try {
    socket = await connectOnce(controlSocketPath(dir));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
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

function parseExpected(values: string[] | undefined): string[] {
  const names = (values ?? []).flatMap((value) => value.split(",")).map((name) => name.trim());
  if (names.some((name) => name === "")) usage("--expect-workflow needs a workflow name");
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
    return { sink, address: inbox, pid: pid ?? pidOf(inbox) };
  }
  if (!values.id) usage("the file sink needs --id <name>, the name `wait --id` reads back with");
  if (values.id.includes("/") || values.id.includes("\n"))
    usage("--id must not contain / or newlines");
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
  const sink = parseSink(values);
  requireGh();
  const reply = unwrap(
    await requestStarting(dir, {
      cmd: "watch",
      sink,
      mode,
      pr: { ...ref, head: values.head ?? null, expected: parseExpected(values["expect-workflow"]) },
      commit: null,
    }),
  );
  console.log(
    `watching ${ref.repo}#${ref.number} for ${sink.sink} ${sink.address} (mode ${mode}); ${reply.subscribers} subscriber(s)`,
  );
  return 0;
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
  const sink = parseSink(values);
  requireGh();
  const reply = unwrap(
    await requestStarting(dir, {
      cmd: "watch",
      sink,
      mode,
      pr: null,
      commit: { repo, sha, expected: parseExpected(values["expect-workflow"]) },
    }),
  );
  console.log(
    `watching ${repo}@${sha.slice(0, 12)} for ${sink.sink} ${sink.address} (mode ${mode}); ${reply.subscribers} subscriber(s)`,
  );
  return 0;
}

async function cmdUnwatch(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...SINK_OPTIONS, all: { type: "boolean" } }, 1);
  if (values.all === true && positionals.length > 0) usage("--all takes no target");
  const pr = values.all === true ? null : parseTarget(positionals[0]);
  const { address } = parseSink(values);
  const reply = await requestRunning(dir, { cmd: "unwatch", address, pr });
  if (reply === null) {
    console.log("no daemon running; nothing is watched");
    return 0;
  }
  unwrap(reply);
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
      Object.keys(sub.commits)
        .map((sha) => sha.slice(0, 12))
        .join(",") || "-";
    const delivery = state.deliveries[sub.address];
    lines.push(
      `  ${sub.sink} ${sub.address} mode=${sub.mode} pid=${sub.pid ?? "-"} lease=${sub.leaseUntil ?? "-"} prs=${prs} commits=${commits} delivery=${describeDelivery(delivery)}`,
    );
  }
  const pruned = Object.entries(state.deliveries).filter(
    ([address]) => !state.subscriptions[address],
  );
  if (pruned.length > 0) {
    lines.push(`former subscribers: ${pruned.length}`);
    for (const [address, delivery] of pruned)
      lines.push(`  ${address} delivery=${describeDelivery(delivery)}`);
  }
  const rows = Object.entries(state.rows);
  lines.push(`prs: ${rows.length}`);
  for (const [key, row] of rows) {
    lines.push(
      `  ${key} head=${row.headRefOid.slice(0, 12)} state=${row.state} ci=${row.ciPending ? "pending" : "settled"} updated=${row.updatedAt}`,
    );
  }
  const commits = Object.entries(state.pendingCommits);
  lines.push(`pending commits: ${commits.length}`);
  for (const [sha, commit] of commits)
    lines.push(`  ${commit.repo}@${sha.slice(0, 12)} since ${commit.firstSeenAt}`);
  const last = readEventsSince(dir, state.lastEventId - 1).at(-1);
  lines.push(
    last
      ? `last event: #${last.id} at ${last.at} ${last.kind} ${subjectOf(last)}: ${last.text.split("\n")[0]}`
      : "last event: none",
  );
  console.log(lines.join("\n"));
  return 0;
}

function describeDelivery(delivery: State["deliveries"][string] | undefined): string {
  return delivery ? `${delivery.outcome} (#${delivery.eventId} at ${delivery.at})` : "none";
}

function subjectOf(event: PrEvent): string {
  if (event.pr !== null) return `${event.repo}#${event.pr}`;
  if (event.sha !== null) return `${event.repo}@${event.sha.slice(0, 12)}`;
  return "daemon";
}

async function cmdWait(dir: string, args: string[]): Promise<number> {
  const { values } = parse(
    args,
    { since: { type: "string" }, timeout: { type: "string" }, id: { type: "string" } },
    0,
  );
  const state = loadState(dir);
  const since =
    values.since === undefined
      ? state.lastEventId
      : (() => {
          if (!/^\d+$/.test(values.since) || !Number.isSafeInteger(Number(values.since))) {
            usage(`--since must be a whole number, got: ${values.since}`);
          }
          return Number(values.since);
        })();
  const timeoutSeconds =
    parsePositiveInt(values.timeout, "--timeout") ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  let matches: (event: PrEvent) => boolean = () => true;
  if (values.id !== undefined) {
    const sub = state.subscriptions[values.id];
    if (sub) {
      const prs = new Set(Object.keys(sub.prs));
      const shas = new Set(Object.keys(sub.commits));
      matches = (event) =>
        (event.pr === null && event.sha === null) ||
        (event.pr !== null && prs.has(prKey({ repo: event.repo, number: event.pr }))) ||
        (event.sha !== null && shas.has(event.sha));
      await requestRunning(dir, { cmd: "renew", address: values.id });
    } else {
      console.error(`no subscription named ${values.id}; waiting on every event`);
    }
  }
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

interface Emitted {
  event: PrEvent;
  targets: string[];
}

type Bound = { kind: "bound"; server: Server } | { kind: "inuse" };

function tryListen(path: string): Promise<Bound> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (errorCode(error) === "EADDRINUSE") resolve({ kind: "inuse" });
      else reject(error);
    });
    server.listen(path, () => resolve({ kind: "bound", server }));
  });
}

/** Binding the control socket is the single-instance lock; null means another daemon holds it. */
async function bindControlSocket(
  path: string,
  log: (line: string) => void,
): Promise<Server | null> {
  const first = await tryListen(path);
  if (first.kind === "bound") return first.server;
  try {
    (await connectOnce(path)).destroy();
    log(`another daemon answers on ${path}; exiting`);
    return null;
  } catch (error) {
    if (errorCode(error) !== "ECONNREFUSED") throw error;
  }
  log(`replacing the stale control socket ${path}`);
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const second = await tryListen(path);
  if (second.kind === "bound") return second.server;
  log(`another daemon took ${path} first; exiting`);
  return null;
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
  chmodSync(socketPath, 0o600);
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

  const subscribersOfPr = (key: PrKey): Subscription[] =>
    Object.values(state.subscriptions).filter((sub) => key in sub.prs);
  const subscribersOfCommit = (sha: string): Subscription[] =>
    Object.values(state.subscriptions).filter((sub) => sha in sub.commits);

  const emit = (input: EventInput, targets: Subscription[], emitted: Emitted[]): void => {
    const event = appendEvent(dir, state, input);
    log(`event #${event.id} ${event.kind} ${subjectOf(event)}: ${event.text.split("\n")[0]}`);
    emitted.push({ event, targets: targets.map((sub) => sub.address) });
  };

  const checkIdle = (): void => {
    if (stopping) return;
    if (Object.keys(state.subscriptions).length > 0) {
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
        if (Object.keys(state.subscriptions).length === 0) {
          log(`no subscribers for ${idleSeconds} s; exiting`);
          void shutdown();
        }
      },
      Math.max(0, remaining),
    );
  };

  const prune = (): void => {
    const now = Date.now();
    for (const sub of Object.values(state.subscriptions)) {
      let reason: string | null = null;
      if (sub.sink === "socket") {
        if (!isLiveSubscriber(sub.address, sub.pid)) reason = "inbox gone or its session exited";
      } else if (sub.pid !== null) {
        if (!isProcessAlive(sub.pid)) reason = `pid ${sub.pid} exited`;
      } else if (sub.leaseUntil === null || Date.parse(sub.leaseUntil) <= now) {
        reason = "lease lapsed without a wait";
      }
      if (reason === null) continue;
      delete state.subscriptions[sub.address];
      state.deliveries[sub.address] = {
        eventId: state.lastEventId,
        at: new Date().toISOString(),
        outcome: `pruned: ${reason}`,
      };
      log(`pruned ${sub.sink} ${sub.address}: ${reason}`);
    }
    for (const key of Object.keys(state.rows)) {
      if (subscribersOfPr(key).length === 0) delete state.rows[key];
    }
    for (const sha of Object.keys(state.pendingCommits)) {
      if (subscribersOfCommit(sha).length === 0) delete state.pendingCommits[sha];
    }
    for (const [address, delivery] of Object.entries(state.deliveries)) {
      if (!state.subscriptions[address] && Date.parse(delivery.at) + LEASE_MS <= now) {
        delete state.deliveries[address];
      }
    }
  };

  /** CI on one sha, for a PR row or a pending commit; true once settled (an event emitted). */
  const judgeCi = (
    repo: string,
    sha: string,
    expected: string[],
    subject: { pr: number | null; url: string },
    targets: Subscription[],
    grace: { missingPolls: number },
    emitted: Emitted[],
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
        emit(
          {
            ...base,
            kind: "ci",
            text: [`CI green on ${sha.slice(0, 12)}`, ...indent(verdict.lines)].join("\n"),
          },
          targets,
          emitted,
        );
        return true;
      case "red":
        emit(
          { ...base, kind: "ci", text: describeRed(repo, sha, runs, verdict.lines) },
          targets,
          emitted,
        );
        return true;
      case "missing":
      case "trouble":
        grace.missingPolls += 1;
        if (grace.missingPolls < MISSING_GRACE_POLLS) return false;
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
          emitted,
        );
        return true;
    }
  };

  const dropPr = (key: PrKey): void => {
    for (const sub of subscribersOfPr(key)) delete sub.prs[key];
    delete state.rows[key];
  };

  const processRow = (ref: PrRef, current: Row, emitted: Emitted[]): void => {
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
        emit({ ...base, kind, text }, targets, emitted);
      }
    }
    if (headMoved && !recordedHeads.has(current.headRefOid)) {
      detail ??= readPrDetail(ref);
      emit(
        {
          ...base,
          kind: "head",
          text: `head moved to ${current.headRefOid.slice(0, 12)} by ${detail.lastCommitAuthor ?? "an unknown author"}`,
        },
        targets,
        emitted,
      );
    }
    if (saved && (changes.head || changes.rollup)) {
      row.ciPending = true;
      if (changes.head) row.missingPolls = 0;
    }
    if (current.state === "MERGED") {
      const oid = current.mergeCommitOid;
      emit(
        {
          ...base,
          kind: "merged",
          text: oid
            ? `merged at ${current.mergedAt ?? "an unknown time"}; mainline commit ${oid.slice(0, 12)} is now watched for CI`
            : `merged at ${current.mergedAt ?? "an unknown time"}; no merge commit reported`,
        },
        targets,
        emitted,
      );
      if (oid) {
        for (const sub of targets) sub.commits[oid] = { repo: ref.repo, expected };
        state.pendingCommits[oid] ??= {
          repo: ref.repo,
          expected,
          firstSeenAt: new Date().toISOString(),
          missingPolls: 0,
        };
      }
      dropPr(key);
      return;
    }
    if (current.state === "CLOSED") {
      emit({ ...base, kind: "closed", text: "closed without merging" }, targets, emitted);
      dropPr(key);
      return;
    }
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
    state.rows[key] = row;
  };

  const processCommit = (sha: string, emitted: Emitted[]): void => {
    const pending = state.pendingCommits[sha];
    if (!pending) return;
    const targets = subscribersOfCommit(sha);
    const expected = union([
      pending.expected,
      ...targets.map((sub) => (sub.commits[sha] as { expected: string[] }).expected),
    ]);
    const settled = judgeCi(
      pending.repo,
      sha,
      expected,
      { pr: null, url: commitUrl(pending.repo, sha) },
      targets,
      pending,
      emitted,
    );
    if (!settled) return;
    for (const sub of targets) delete sub.commits[sha];
    delete state.pendingCommits[sha];
  };

  const deliverAll = async (emitted: Emitted[]): Promise<void> => {
    for (const { event, targets } of emitted) {
      for (const address of targets) {
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
          if (code === "ENOENT" || code === "ECONNREFUSED") {
            delete state.subscriptions[address];
            log(`pruned socket ${address}: inbox refused`);
          }
        }
      }
    }
  };

  const poll = async (): Promise<number> => {
    prune();
    const emitted: Emitted[] = [];
    let lastError: string | null = null;
    const refs: PrRef[] = [];
    for (const sub of Object.values(state.subscriptions)) {
      for (const key of Object.keys(sub.prs)) {
        const [repo, number] = key.split("#");
        if (!refs.some((ref) => prKey(ref) === key))
          refs.push({ repo: repo as string, number: Number(number) });
      }
    }
    try {
      if (refs.length > 0) {
        const rows = readRows(refs);
        for (const ref of refs) {
          const current = rows.get(prKey(ref));
          if (current === undefined) {
            log(`${prKey(ref)}: not in the rows read; keeping the saved row`);
            continue;
          }
          try {
            processRow(ref, current, emitted);
          } catch (error) {
            if (!(error instanceof GhError)) throw error;
            lastError = `${prKey(ref)}: ${error.message}`;
            log(`poll: ${lastError}`);
          }
        }
      }
      for (const sha of Object.keys(state.pendingCommits)) {
        try {
          processCommit(sha, emitted);
        } catch (error) {
          if (!(error instanceof GhError)) throw error;
          lastError = `${sha.slice(0, 12)}: ${error.message}`;
          log(`poll: ${lastError}`);
        }
      }
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      lastError = error.message;
      log(`poll: ${lastError}`);
    }
    const everyone = Object.values(state.subscriptions);
    if (lastError !== null) {
      failures += 1;
      if (failures === MAX_CONSECUTIVE_POLL_FAILURES) {
        troubled = true;
        emit(
          {
            repo: "",
            pr: null,
            sha: null,
            kind: "trouble",
            url: "",
            text: `polling failed ${failures} times in a row (${lastError}); not a verdict. Auth errors in ${logPath}: run stop, then watch again`,
          },
          everyone,
          emitted,
        );
      }
    } else {
      failures = 0;
      if (troubled) {
        troubled = false;
        emit(
          { repo: "", pr: null, sha: null, kind: "trouble", url: "", text: "polling recovered" },
          everyone,
          emitted,
        );
      }
    }
    await deliverAll(emitted);
    saveState(dir, state);
    checkIdle();
    return emitted.length;
  };

  const schedulePoll = (): void => {
    if (stopping) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void runPoll(), intervalSeconds * 1000);
  };

  const runPoll = (): Promise<number> => {
    if (polling) return polling;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    polling = poll()
      .catch((error: unknown) => {
        log(`poll crashed: ${errorText(error)}`);
        return 0;
      })
      .finally(() => {
        polling = null;
        schedulePoll();
      });
    return polling;
  };

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (polling) await polling;
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

  const dispatch = async (command: Command): Promise<Reply> => {
    switch (command.cmd) {
      case "watch": {
        const { sink, mode, pr, commit } = command;
        const existing = state.subscriptions[sink.address];
        const sub: Subscription = existing ?? {
          sink: sink.sink,
          address: sink.address,
          pid: null,
          mode,
          leaseUntil: null,
          prs: {},
          commits: {},
        };
        sub.mode = mode;
        sub.pid = sink.pid;
        sub.leaseUntil =
          sink.sink === "file" && sink.pid === null
            ? new Date(Date.now() + LEASE_MS).toISOString()
            : null;
        if (pr) {
          const key = prKey(pr);
          const previous = sub.prs[key];
          sub.prs[key] = {
            head: pr.head,
            expected: union([previous?.expected ?? [], pr.expected]),
          };
        }
        if (commit) {
          const previous = sub.commits[commit.sha];
          sub.commits[commit.sha] = {
            repo: commit.repo,
            expected: union([previous?.expected ?? [], commit.expected]),
          };
          state.pendingCommits[commit.sha] ??= {
            repo: commit.repo,
            expected: commit.expected,
            firstSeenAt: new Date().toISOString(),
            missingPolls: 0,
          };
        }
        state.subscriptions[sink.address] = sub;
        saveState(dir, state);
        checkIdle();
        log(
          `watch ${sink.sink} ${sink.address} (${mode}): ${pr ? prKey(pr) : `${commit?.repo}@${commit?.sha.slice(0, 12)}`}`,
        );
        if (polling) await polling;
        await runPoll();
        return { ok: true, subscribers: Object.keys(state.subscriptions).length };
      }
      case "unwatch": {
        const sub = state.subscriptions[command.address];
        if (sub) {
          if (command.pr === null) delete state.subscriptions[command.address];
          else delete sub.prs[prKey(command.pr)];
          prune();
          saveState(dir, state);
          checkIdle();
        }
        return { ok: true, subscribers: Object.keys(state.subscriptions).length };
      }
      case "renew": {
        const sub = state.subscriptions[command.address];
        if (sub && sub.sink === "file" && sub.pid === null) {
          sub.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
          saveState(dir, state);
        }
        return { ok: true };
      }
      case "poll":
        return { ok: true, events: await runPoll() };
      case "status":
        return { ok: true, status: { pid: process.pid, state } };
      case "stop":
        return { ok: true };
    }
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
    socket.end(`${JSON.stringify(reply)}\n`, () => {
      if (frame.cmd === "stop") void shutdown();
    });
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
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
