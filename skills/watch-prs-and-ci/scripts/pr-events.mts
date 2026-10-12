#!/usr/bin/env bun
// One daemon per Claude Code session, started by that session as a background task. A child of the
// session is rendered as plain text; a detached process is a cross-session sender whose frames the
// session holds, which is why the CLI never starts the daemon and the page says never to detach it.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, chmodSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { discoverRuns, failedJobLog, judgeRuns, type Run, selectLatest } from "./check-suites.mts";
import { AbortedRead, GhError, guardReads } from "./gh.mts";
import {
  deliver,
  FROM_NAME,
  type InboxFrame,
  isProcessAlive,
  pidOf,
  renderDigest,
} from "./inbox.mts";
import { type Activity, newActivity, readPrDetail, viewerLogin } from "./pr-detail.mts";
import { type PrKey, type PrRef, prKey, type Row, readRows, rowChanged } from "./pr-rows.mts";
import {
  appendEvent,
  type CommitKey,
  commitKey,
  type EventInput,
  freshGrace,
  type Grace,
  loadState,
  type Owner,
  type OwnerFiles,
  ownerFiles,
  type PrEvent,
  RuntimeDirError,
  readEventsSince,
  runtimeDir,
  type SavedRow,
  type State,
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
// The receiver drops a second frame from one sender within the same second; a poll triggered by
// `watch` right after another waits this long before its message goes out.
const MIN_DELIVERY_GAP_MS = 1100;

const USAGE = [
  "usage: pr-events.mts <command> [options]",
  "  daemon [--interval <s>] [--id <name>] [--pid <pid>]",
  "  watch <owner/repo>#<n> [--head <sha>] [--expect-workflow <name>]... [--id <name>]",
  "  watch-commit <owner/repo> <sha> [--expect-workflow <name>]... [--id <name>]",
  "  unwatch <owner/repo>#<n> | --all          [--id <name>]",
  "  wait [--since <id>] [--timeout <s>] [--id <name>]",
  "  poll | status | stop                     [--id <name>]",
  "the daemon serves the Claude Code session named by CLAUDE_CODE_MESSAGING_SOCKET and exits with it;",
  "--id <name> names a file-sink daemon for a non-Claude agent instead, --pid <pid> ends it with that process;",
  `--interval has a floor of ${MIN_INTERVAL_SECONDS} s`,
].join("\n");

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
  if (values.id !== undefined) {
    // Ids key plain objects that come back from JSON, so a name an object inherits cannot be one.
    if (!ID_PATTERN.test(values.id) || values.id in Object.prototype) {
      usage(`--id must be a name of letters, digits, . _ or -, not ${values.id}`);
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

/** The owner's files, refused when their socket path is longer than a bind allows. */
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
  | { kind: "pr"; repo: string; number: number; head: string | null; expected: string[] }
  | { kind: "commit"; repo: string; sha: string; expected: string[] };

type Command =
  | { cmd: "watch"; target: WatchTarget }
  | { cmd: "unwatch"; pr: PrRef | null }
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
  return { repo: match[1] as string, number: Number(match[2]) };
}

// A workflow name is matched exactly, commas and all; one flag carries one name, and the flags of
// one call are the complete gate set.
function parseExpected(values: string[] | undefined): string[] {
  const names = values ?? [];
  if (names.some((name) => name.trim() === "")) usage("--expect-workflow needs a workflow name");
  return [...new Set(names)].sort();
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
  });
}

async function cmdWatchCommit(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    { ...OWNER_OPTIONS, "expect-workflow": { type: "string", multiple: true } },
    2,
  );
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

async function cmdUnwatch(dir: string, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...OWNER_OPTIONS, all: { type: "boolean" } }, 1);
  if (values.all === true && positionals.length > 0) usage("--all takes no target");
  const pr = values.all === true ? null : parseTarget(positionals[0]);
  const owner = resolveOwner(values);
  unwrap(await request(owner, filesOf(dir, owner), { cmd: "unwatch", pr }));
  console.log(
    pr === null
      ? `unwatched everything for ${describeOwner(owner)}`
      : `unwatched ${pr.repo}#${pr.number} for ${describeOwner(owner)}`,
  );
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
      `  ${key} ${seen} gates=${gates(pr.expected)} recorded-head=${pr.head?.slice(0, 12) ?? "-"}`,
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
  for (;;) {
    const events = readEventsSince(files, since);
    if (events.length > 0) {
      for (const event of events) console.log(JSON.stringify(event));
      console.log(`cursor: ${(events.at(-1) as PrEvent).id}`);
      return 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(`no event after ${timeoutSeconds}s`);
      console.log(`cursor: ${since}`);
      return 4;
    }
    await sleep(Math.min(WAIT_TICK_MS, remaining));
  }
}

// --- daemon -------------------------------------------------------------------

/**
 * Binding the control socket is the single-instance rule for a session: a bind refused by a daemon
 * that answers means this one is the second, and it leaves; a socket file nobody answers on was
 * left by a daemon that died and is replaced.
 */
async function bindControlSocket(
  path: string,
  log: (line: string) => void,
): Promise<Server | null> {
  for (;;) {
    const server = createServer();
    try {
      server.listen(path);
      await once(server, "listening");
      chmodSync(path, 0o600);
      return server;
    } catch (error) {
      if (errorCode(error) !== "EADDRINUSE") throw error;
    }
    try {
      (await connectOnce(path)).destroy();
      log(`another daemon answers on ${path}; exiting`);
      return null;
    } catch (error) {
      if (errorCode(error) !== "ECONNREFUSED") throw error;
      log(`replacing the stale control socket ${path}`);
      unlinkSync(path);
    }
  }
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
function describeActivities(
  activities: Activity[],
): { kind: "comment" | "review"; text: string } | null {
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
  const summary = reviews.map((review) => {
    const inline = inlineOf(review).length;
    const headline = `new review by ${review.author} (${review.reviewState})`;
    return inline === 0 ? headline : `${headline}, ${plural(inline, "review comment")}`;
  });
  if (loose.length > 0) {
    const authors = [...new Set(loose.map((comment) => comment.author))].join(", ");
    summary.push(`${plural(loose.length, "new comment")} by ${authors}`);
  }
  if (summary.length === 0) return null;
  const rows: [string, string][] = [];
  for (const activity of [
    ...reviews.flatMap((review) => [review, ...inlineOf(review)]),
    ...loose,
  ]) {
    const body = clip(flatten(activity.body));
    if (body === "") continue;
    const where =
      activity.path !== undefined
        ? `${activity.path}${typeof activity.line === "number" ? `:${activity.line}` : ""}`
        : activity.author;
    rows.push([where, body]);
  }
  const width = Math.max(0, ...rows.map(([where]) => where.length));
  const lines = [
    summary.join(", "),
    ...rows.map(([where, body]) => `  ${where.padEnd(width)}  ${body}`),
  ];
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

function workflowNames(runs: Run[]): string[] {
  return [...new Set(selectLatest(runs).map((run) => run.name))].sort();
}

function describeGreen(sha: string, runs: Run[]): string {
  return `CI green on ${sha.slice(0, 12)}: ${workflowNames(runs).join(", ")}`;
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

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

async function runDaemon(
  owner: Owner,
  files: OwnerFiles,
  intervalSeconds: number,
): Promise<number> {
  const log = (line: string) => appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
  const state = loadState(files);
  const server = await bindControlSocket(files.socket, log);
  if (server === null) {
    console.log(`another pr-events daemon already serves ${describeOwner(owner)}; exiting`);
    return 0;
  }
  const banner = `pr-events daemon ${process.pid} for ${describeOwner(owner)}; socket ${files.socket}; log ${files.log}; poll every ${intervalSeconds} s`;
  console.log(banner);
  log(banner);

  let polling: Promise<number> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
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

  const watchedCount = (): number =>
    Object.keys(state.prs).length + Object.keys(state.commits).length;

  const ownerGone = (): boolean => owner.pid !== null && !isProcessAlive(owner.pid);
  guardReads(() => (ownerGone() ? `${describeOwner(owner)} exited` : null));

  const emit = (input: EventInput): PrEvent => {
    const event = appendEvent(files, state, input);
    log(`event #${event.id} ${event.kind} ${subjectOf(event)}: ${event.text.split("\n")[0]}`);
    return event;
  };

  /** A settled verdict's event; null while the head is still being judged. */
  const judgeCi = (
    repo: string,
    sha: string,
    expected: string[],
    subject: { pr: number | null; url: string },
    grace: Grace,
    emitted: PrEvent[],
  ): PrEvent | null => {
    const runs = discoverRuns(repo, sha);
    const verdict = judgeRuns(runs, expected);
    const base = { repo, pr: subject.pr, sha, url: subject.url };
    // Workflows by id, not name: two workflow files can share a name, and a second one registering
    // under the same name is still a set that changed.
    const registered = [
      ...new Set(selectLatest(runs).map((run) => run.workflowId ?? `run:${run.id}`)),
    ]
      .map(String)
      .sort();
    const settle = (text: string): PrEvent => {
      const event = emit({ ...base, kind: "ci", text });
      emitted.push(event);
      return event;
    };
    // No run at all is a registration that has not happened yet, or a ref nothing triggers on;
    // the grace below decides which, as it does for a named gate.
    const kind = verdict.kind === "pending" && runs.length === 0 ? "missing" : verdict.kind;
    switch (kind) {
      case "pending":
        grace.missingPolls = 0;
        grace.registered = registered;
        return null;
      case "green": {
        grace.missingPolls = 0;
        // Registration settles before a green is terminal: every named gate is present (a missing
        // one ranks above green), or two reads in a row saw the same workflow set, so a workflow
        // still registering when the first all-green read happened gets its say.
        const confirmed = expected.length > 0 || sameSet(grace.registered, registered);
        grace.registered = registered;
        return confirmed ? settle(describeGreen(sha, runs)) : null;
      }
      case "red":
        return settle(describeRed(repo, sha, runs, verdict.lines));
      case "missing":
      case "trouble":
        // Noticed once, at the grace; the sha stays judged, so a run that registers late still
        // gets its verdict.
        grace.missingPolls += 1;
        grace.registered = registered;
        if (grace.missingPolls !== MISSING_GRACE_POLLS) return null;
        emitted.push(
          emit({
            ...base,
            kind: "trouble",
            text: [
              `CI ${kind === "missing" ? "run not registered" : "read gave no verdict"} on ${sha.slice(0, 12)} after ${grace.missingPolls} polls; not a verdict`,
              ...indent(verdict.lines),
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

  // The row is saved as soon as its own events are out, before the CI read: a CI read that fails
  // must not replay the comment or head event on the next poll.
  const processRow = (ref: PrRef, current: Row, emitted: PrEvent[]): void => {
    const key = prKey(ref);
    const watch = state.prs[key];
    if (watch === undefined) return;
    const saved = state.rows[key];
    const base = { repo: ref.repo, pr: ref.number, sha: current.headRefOid, url: current.url };
    const row: SavedRow = {
      ...current,
      ci: saved?.ci ?? { pending: true, grace: freshGrace() },
      seenActivity: saved?.seenActivity ?? [],
      mergeCommitPolls: saved?.mergeCommitPolls ?? 0,
    };
    const headMoved = saved ? current.headRefOid !== saved.headRefOid : watch.head !== null;
    const changes = rowChanged(saved, current);
    let detail: ReturnType<typeof readPrDetail> | null = null;
    // A first sighting reads the detail too: what is on the PR now is the baseline, by id.
    if (!saved || changes.activity) {
      const seen = saved ? new Set(row.seenActivity.flat()) : null;
      detail = readPrDetail(ref, seen);
      const activities = seen ? newActivity(detail, seen, viewerLoginCached()) : [];
      row.seenActivity = [...row.seenActivity.slice(-1), detail.fetchedIds];
      const described = describeActivities(activities);
      if (described !== null) emitted.push(emit({ ...base, ...described }));
      for (const gap of detail.gaps) {
        emitted.push(emit({ ...base, kind: "trouble", text: `${gap}; read the PR` }));
      }
    }
    if (headMoved && watch.head !== current.headRefOid) {
      detail ??= readPrDetail(ref, null);
      emitted.push(
        emit({
          ...base,
          kind: "head",
          text: `head moved to ${current.headRefOid.slice(0, 12)} by ${detail.lastCommitAuthor ?? "an unknown author"}`,
        }),
      );
    }
    if (saved && (changes.head || changes.rollup)) {
      // A rollup move on the same head keeps the grace already spent waiting for its gate.
      const grace = !changes.head && saved.ci.pending ? saved.ci.grace : freshGrace();
      row.ci = { pending: true, grace };
    }
    if (current.state === "MERGED") {
      const oid = current.mergeCommitOid;
      const mergedAt = current.mergedAt ?? "an unknown time";
      if (oid === null) {
        // The merge commit can lag mergedAt by a poll; the target stays until it is reported.
        row.mergeCommitPolls += 1;
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
      emitted.push(
        emit({
          ...base,
          kind: "merged",
          text: `merged at ${mergedAt}; mainline commit ${oid.slice(0, 12)} is now watched for CI`,
        }),
      );
      // A watch-commit that already named its own gates for this commit keeps them.
      state.commits[commitKey(ref.repo, oid)] ??= {
        repo: ref.repo,
        sha: oid,
        expected: watch.expected,
        firstSeenAt: new Date().toISOString(),
        grace: freshGrace(),
      };
      dropPr(key);
      return;
    }
    if (current.state === "CLOSED") {
      emitted.push(emit({ ...base, kind: "closed", text: "closed without merging" }));
      dropPr(key);
      return;
    }
    state.rows[key] = row;
    if (row.ci.pending) {
      const verdict = judgeCi(
        ref.repo,
        current.headRefOid,
        watch.expected,
        { pr: ref.number, url: current.url },
        row.ci.grace,
        emitted,
      );
      if (verdict)
        row.ci = { pending: false, verdict: { eventId: verdict.id, text: verdict.text } };
    }
  };

  const processCommit = (key: CommitKey, emitted: PrEvent[]): void => {
    const watch = state.commits[key];
    if (!watch) return;
    const verdict = judgeCi(
      watch.repo,
      watch.sha,
      watch.expected,
      { pr: null, url: commitUrl(watch.repo, watch.sha) },
      watch.grace,
      emitted,
    );
    if (verdict !== null) delete state.commits[key];
  };

  // One message per poll, and a second's gap between messages: the receiver drops a second frame
  // from one sender within the same second.
  // The clock survives a restart: a daemon started right after the last one stopped would otherwise
  // send its first message within a second of the previous one.
  let lastDeliveryAt = state.delivery ? Date.parse(state.delivery.at) : 0;
  const deliverDigest = async (emitted: PrEvent[]): Promise<void> => {
    if (owner.inbox === null || emitted.length === 0) return;
    const gap = lastDeliveryAt + MIN_DELIVERY_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastDeliveryAt = Date.now();
    const frame: InboxFrame = {
      type: "user",
      message: { role: "user", content: renderDigest(emitted) },
      from: `uds:${files.socket}`,
      from_name: FROM_NAME,
      msg_id: `pr-events-${(emitted[0] as PrEvent).id}-${randomUUID()}`,
    };
    const delivery = {
      eventIds: emitted.map((event) => event.id),
      at: new Date().toISOString(),
      msgId: frame.msg_id,
    };
    try {
      await deliver(owner.inbox, frame);
      state.delivery = { ...delivery, outcome: "sent" };
    } catch (error) {
      const code = errorCode(error) ?? errorText(error);
      state.delivery = { ...delivery, outcome: `failed: ${code}` };
      log(`delivery of #${delivery.eventIds.join(",#")} to ${owner.inbox} failed: ${code}`);
    }
  };

  const watchedRefs = (): PrRef[] =>
    Object.keys(state.prs).map((key) => {
      const [repo, number] = key.split("#") as [string, string];
      return { repo, number: Number(number) };
    });

  const poll = async (): Promise<number> => {
    const emitted: PrEvent[] = [];
    let lastError: string | null = null;
    const noteGhError = (where: string, error: unknown): void => {
      if (!(error instanceof GhError)) throw error;
      lastError = `${where}: ${error.message}`;
      log(`poll: ${lastError}`);
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
      for (const key of Object.keys(state.commits)) {
        try {
          processCommit(key, emitted);
        } catch (error) {
          noteGhError(key, error);
        }
      }
    } catch (error) {
      if (!(error instanceof AbortedRead)) throw error;
      log(`poll stopped: ${error.message}`);
      saveState(files, state);
      return emitted.length;
    }
    const daemonWide = { repo: "", pr: null, sha: null, url: "", kind: "trouble" as const };
    if (lastError !== null) {
      failures += 1;
      if (failures === MAX_CONSECUTIVE_POLL_FAILURES) {
        troubled = true;
        emitted.push(
          emit({
            ...daemonWide,
            text: `polling failed ${failures} times in a row (${lastError}); not a verdict. Auth errors in ${files.log}: run stop, then start the daemon again`,
          }),
        );
      }
    } else {
      failures = 0;
      if (troubled) {
        troubled = false;
        emitted.push(emit({ ...daemonWide, text: "polling recovered" }));
      }
    }
    await deliverDigest(emitted);
    saveState(files, state);
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

  // A poll in flight is drained first: released earlier, the socket would let a replacement daemon
  // start while this one still delivers and saves over the replacement's state. The socket is gone
  // and the state saved before anyone is answered.
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(ownerTimer);
    if (polling) await polling.catch(() => {});
    saveState(files, state);
    server.close();
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
    if (ownerGone()) void shutdown(`${describeOwner(owner)} exited`);
  }, OWNER_CHECK_MS);

  // The flags of a call are the complete gate set. A watch restarts a pending judgment's grace, so
  // two calls seconds apart do not spend the polls meant to be a minute apart; a settled head is
  // judged again only when the set changed, so a corrected gate name gets its verdict.
  const subscribe = async (target: WatchTarget): Promise<number> => {
    if (target.kind === "pr") {
      const key = prKey(target);
      const previous = state.prs[key];
      state.prs[key] = { head: target.head, expected: target.expected };
      const row = state.rows[key];
      if (row && (row.ci.pending || !sameSet(previous?.expected ?? [], target.expected))) {
        row.ci = { pending: true, grace: freshGrace() };
      }
    } else {
      const key = commitKey(target.repo, target.sha);
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
    log(`watch ${describeTarget(target)} gates=${gates(target.expected)}`);
    if (polling) await polling;
    await runPoll();
    return watchedCount();
  };

  const dispatch = async (command: Command): Promise<Reply> => {
    // A connection accepted before the stop can still carry a command; work it would add has no
    // poll left to run it.
    if (stopping && command.cmd !== "status" && command.cmd !== "stop") {
      return { ok: false, error: "daemon stopping; retry" };
    }
    switch (command.cmd) {
      case "watch":
        return { ok: true, watched: await subscribe(command.target) };
      case "unwatch": {
        if (command.pr === null) {
          for (const key of Object.keys(state.prs)) dropPr(key);
          for (const key of Object.keys(state.commits)) delete state.commits[key];
        } else {
          dropPr(prKey(command.pr));
        }
        saveState(files, state);
        return { ok: true, watched: watchedCount() };
      }
      case "poll":
        return { ok: true, events: await runPoll() };
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
    firstLine(socket, "closed before a line").then(
      (line) => handleLine(line, socket),
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
  requireGh();
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
      console.error(`${error.message}\n${USAGE}`);
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
