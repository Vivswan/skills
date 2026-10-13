// One daemon per Claude Code session, started by that session as a background task, polls a
// source for the targets the session watches and delivers each poll's events as one message. A
// source script imports `runEvents` and calls it at top level; this module is the whole CLI and
// the daemon for that source: the control socket, the delivery, the events log, the saved state,
// and the schedule. What a target is, how it is read, and what its events say is the source's.
//
// A child of the session is rendered as plain text; a detached process is a cross-session sender
// whose frames the session holds, which is why the CLI never starts the daemon.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, chmodSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  deliver,
  envelope,
  type InboxFrame,
  isProcessAlive,
  type Mode,
  pidOf,
  startToken,
} from "./inbox.mts";
import {
  appendEvents,
  type Event,
  type Files,
  loadState,
  noTargets,
  type Owner,
  ownerFiles,
  RuntimeDirError,
  readEventsSince,
  runtimeDir,
  saveState,
} from "./state.mts";

export type { Event } from "./state.mts";

// --- the source contract -------------------------------------------------------

/** A command-line mistake, in the daemon's own arguments or in a target a source refuses: exit 2. */
export class UsageError extends Error {}

/**
 * What a source hands the daemon for one event; the daemon numbers and stamps it. The text is the
 * source's own words about the polled system (identifiers, counts, states, URLs), never text
 * quoted from it: a message is user-role text in the owner's session, with no data channel.
 */
export type EventInput = { kind: string; text: string; url: string } & Record<string, unknown>;

export interface Io {
  /** A line in the daemon's log, the first place to read when something is off. */
  log(line: string): void;
}

export interface PollResult {
  events: EventInput[];
  /** Something is still moving (CI pending, an event this poll): the next poll comes after `interval`, else `idleInterval`. */
  busy: boolean;
}

export interface Source<Target extends object> {
  /** `[a-z0-9-]{1,40}`: the file stems, the envelope's from-name, the msg_id prefix, the closing line. */
  name: string;
  /** Seconds between polls while busy, and the default of `--interval`; floor 1, cap 86400. */
  interval: number;
  /** Seconds between polls while nothing moves; defaults to `interval`. */
  idleInterval?: number;
  /** Lines the usage text ends with: the target's forms and the source's own flags after `watch`. */
  usage?: string[];
  /** The arguments after `watch`, the target text first and the source's own flags after it; throws UsageError. */
  parseTarget(args: string[]): Target;
  /**
   * One read of every target, keyed by the text the user typed. A source writes its cursor onto
   * each target object, on the way to returning: a poll that throws is a failed poll, and
   * nothing it changed is saved. Three failures in a row are one `trouble` event.
   */
  poll(targets: Record<string, Target>, io: Io): Promise<PollResult>;
}

/** Runs the CLI for `source` on this process's arguments; the source script's one call. */
export function runEvents<Target extends object>(source: Source<Target>): void {
  main(source, process.argv.slice(2), process.argv[1] ?? "source.mts").then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(errorText(error));
      process.exitCode = 1;
    },
  );
}

// --- constants ---------------------------------------------------------------------

const NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIN_INTERVAL_SECONDS = 1;
// A day: past that, the poll timer's milliseconds overflow the 32-bit timer and fire at once.
const MAX_INTERVAL_SECONDS = 86_400;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const WAIT_TICK_MS = 1000;
// The owner's end is noticed between polls, so a finished session does not leave a poller behind
// for the rest of a long idle interval.
const OWNER_CHECK_MS = 1000;
// How long a stopping daemon waits for a connection accepted before the stop to say what it wants
// (it is refused), before the connection is cut so the process can end.
const SILENT_CLIENT_GRACE_MS = 1000;
// The receiver drops a second frame from one sender within the same second; a poll triggered by
// `watch` right after another waits this long before its message goes out.
const MIN_DELIVERY_GAP_MS = 1100;
// Linux allows 108 bytes for a Unix socket path and macOS 104; a longer one fails at bind.
const SOCKET_PATH_MAX = 104;
const STOPPING_ERROR = "daemon stopping; retry";

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

interface Context<Target extends object> {
  source: Source<Target>;
  /** The source script as the user runs it: the usage line and the start command name it. */
  entry: string;
  dir: string;
}

// --- usage and arguments ----------------------------------------------------------

function usageText(entry: string, source: Source<object>): string {
  return [
    `usage: ${entry} <command> [options]`,
    "  daemon [--interval <s>] [--mode bypass|prompting] [--id <name> [--pid <pid>]]",
    "  watch <target> [the source's flags] [--id <name>]",
    "  unwatch <target> | --all [--id <name>]",
    "  wait [--since <id>] [--timeout <s>] [--id <name>]",
    "  poll | status | stop [--id <name>]",
    "the daemon serves the Claude Code session named by CLAUDE_CODE_MESSAGING_SOCKET and exits with it;",
    "--id <name> names a file-sink daemon for a non-Claude agent instead, --pid <pid> ends it with that process;",
    "--mode is the session's permission mode, carried in the envelope: bypass (the default) or prompting;",
    `--interval is ${source.interval} s by default, ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`,
    ...(source.usage ?? []),
    `files: <dir>/<pid>-<start>.${source.name}.{state.json,events.jsonl,log} and <dir>/<pid>.${source.name}.sock for a session; <id>.${source.name}.* for a file sink;`,
    "  <dir> is $SESSION_EVENTS_DIR, else $XDG_RUNTIME_DIR/session-events, else $CLAUDE_CODE_TMPDIR/session-events-<uid>, else <os tmpdir>/session-events-<uid>, else /tmp/session-events-<uid>",
    `prints: one message per poll with events, wrapped in <cross-session-message from="uds:<socket>" from-name="${source.name}" from-mode="<mode>"> and ending "automated notice from ${source.name}; no reply needed";`,
    "  wait prints the new events as JSON lines, then cursor: <id>",
    "exits: 0 ok (stop with no daemon running, and a second daemon start, are ok too); 2 usage, a state file that is not JSON, or no runtime directory;",
    "       3 no daemon answers for this session: stderr names the socket and the background command that starts one; 4 wait only: the timeout passed with no newer line",
  ].join("\n");
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    usage(`${flag} must be a positive whole number, got: ${value}`);
  }
  return Number(value);
}

/** Removes `--<name> <value>` from `args` and returns the value. */
function takeValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

/** What is left once a command's own options are taken: another flag is unknown, and so is an extra positional. */
function positionals(args: string[], allowed: number): string[] {
  const flag = args.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) usage(`unknown option: ${flag}`);
  if (args.length > allowed) usage(`unexpected extra argument: ${args[allowed]}`);
  return args;
}

/**
 * The CLI and the daemon resolve the same owner from the same environment, so they name the same
 * files: the session whose inbox CLAUDE_CODE_MESSAGING_SOCKET names, or the `--id` of a file sink.
 */
function resolveOwner(
  id: string | undefined,
  pidValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Owner {
  const pid = parsePositiveInt(pidValue, "--pid") ?? null;
  // `--pid $$` from a shell that execs the daemon as its last command names the daemon itself.
  if (pid === process.pid) usage("--pid names this very process; pass the agent's own pid");
  if (id !== undefined) {
    if (!ID_PATTERN.test(id)) usage(`--id must be a name of letters, digits, . _ or -, not ${id}`);
    if (/^\d+$/.test(id))
      usage("--id must not be all digits: a session's files are keyed by its pid");
    return { id, inbox: null, pid, start: null };
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
  return { id: null, inbox, pid: sessionPid, start: startToken(sessionPid, inbox) };
}

function describeOwner(owner: Owner): string {
  return owner.id === null ? `session ${owner.pid}` : `file sink ${owner.id}`;
}

function filesOf(ctx: Context<object>, owner: Owner): Files {
  const files = ownerFiles(ctx.dir, owner, ctx.source.name);
  if (Buffer.byteLength(files.socket) > SOCKET_PATH_MAX) {
    usage(
      `the socket path ${files.socket} is longer than the ${SOCKET_PATH_MAX} bytes a Unix socket allows; use a shorter --id or SESSION_EVENTS_DIR`,
    );
  }
  return files;
}

function startCommand(ctx: Context<object>, owner: Owner): string {
  return `bun "${ctx.entry}" daemon${owner.id === null ? "" : ` --id ${owner.id}`}`;
}

// --- control protocol --------------------------------------------------------

type Command =
  | { cmd: "watch"; key: string; target: unknown }
  | { cmd: "unwatch"; key: string | null }
  | { cmd: "poll" }
  | { cmd: "status" }
  | { cmd: "stop" };

interface Status {
  pid: number;
  lastEventId: number;
  targets: string[];
}

type Reply =
  | { ok: true; events?: number; watched?: number; status?: Status }
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

function isNobodyListening(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** The reply of the owner's daemon, or null when none answers on its socket. */
async function requestIfRunning(files: Files, command: Command): Promise<Reply | null> {
  let socket: Socket;
  try {
    socket = await connectOnce(files.socket);
  } catch (error) {
    if (isNobodyListening(error)) return null;
    throw error;
  }
  socket.write(`${JSON.stringify(command)}\n`);
  try {
    return JSON.parse(
      await firstLine(socket, "the daemon closed the connection without a reply"),
    ) as Reply;
  } finally {
    socket.destroy();
  }
}

function unwrap(reply: Reply): Reply & { ok: true } {
  if (!reply.ok) throw new ToolingError(`daemon: ${reply.error}`);
  return reply;
}

// --- CLI commands -------------------------------------------------------------

// The CLI never starts the daemon: a child of the CLI would outlive it detached, and a detached
// process is a cross-session sender whose frames the session holds for approval.
async function request(ctx: Context<object>, owner: Owner, command: Command): Promise<Reply> {
  const files = filesOf(ctx, owner);
  const reply = await requestIfRunning(files, command);
  if (reply === null) {
    throw new NoDaemonError(
      `no ${ctx.source.name} daemon answers for ${describeOwner(owner)} on ${files.socket}; start one as a background task of this session:\n  ${startCommand(ctx, owner)}`,
    );
  }
  return reply;
}

async function watch<Target extends object>(ctx: Context<Target>, args: string[]): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), undefined);
  const key = args[0];
  if (key === undefined || key.startsWith("--")) usage("watch needs a target");
  const target = ctx.source.parseTarget(args);
  const reply = unwrap(await request(ctx, owner, { cmd: "watch", key, target }));
  console.log(`watching ${key} for ${describeOwner(owner)}; ${reply.watched} target(s)`);
  return 0;
}

async function unwatch(ctx: Context<object>, args: string[]): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), undefined);
  const all = takeFlag(args, "all");
  const [key] = positionals(args, 1);
  if (all && key !== undefined) usage("--all takes no target");
  if (!all && key === undefined) usage("missing <target> or --all");
  unwrap(await request(ctx, owner, { cmd: "unwatch", key: all ? null : (key as string) }));
  console.log(`unwatched ${all ? "everything" : key} for ${describeOwner(owner)}`);
  return 0;
}

async function poll(ctx: Context<object>, args: string[]): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), undefined);
  positionals(args, 0);
  const reply = unwrap(await request(ctx, owner, { cmd: "poll" }));
  console.log(`polled; ${reply.events} event(s)`);
  return 0;
}

async function stop(ctx: Context<object>, args: string[]): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), undefined);
  positionals(args, 0);
  const reply = await requestIfRunning(filesOf(ctx, owner), { cmd: "stop" });
  if (reply === null) {
    console.log(`no daemon running for ${describeOwner(owner)}`);
    return 0;
  }
  unwrap(reply);
  console.log("daemon stopped");
  return 0;
}

async function status(ctx: Context<object>, args: string[]): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), undefined);
  positionals(args, 0);
  const files = filesOf(ctx, owner);
  const reply = unwrap(await request(ctx, owner, { cmd: "status" })).status as Status;
  const last = readEventsSince(files, reply.lastEventId - 1).at(-1);
  console.log(
    [
      `daemon: running (pid ${reply.pid}) for ${describeOwner(owner)}`,
      `socket: ${files.socket}`,
      `log: ${files.log}`,
      `events: ${files.events}`,
      `targets: ${reply.targets.length}`,
      ...reply.targets.map((key) => `  ${key}`),
      last
        ? `last event: #${last.id} at ${last.at} ${last.kind}: ${last.text.split("\n")[0]}`
        : "last event: none",
    ].join("\n"),
  );
  return 0;
}

async function wait(ctx: Context<object>, args: string[]): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), undefined);
  const sinceValue = takeValue(args, "since");
  const timeoutSeconds =
    parsePositiveInt(takeValue(args, "timeout"), "--timeout") ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  positionals(args, 0);
  if (
    sinceValue !== undefined &&
    (!/^\d+$/.test(sinceValue) || !Number.isSafeInteger(Number(sinceValue)))
  ) {
    usage(`--since must be a whole number, got: ${sinceValue}`);
  }
  const files = filesOf(ctx, owner);
  // A wait with no daemon would block for its whole timeout on a log nothing appends to.
  const daemon = unwrap(await request(ctx, owner, { cmd: "status" })).status as Status;
  const since = sinceValue === undefined ? daemon.lastEventId : Number(sinceValue);
  const deadline = Date.now() + timeoutSeconds * 1000;
  // A daemon stopped under a running wait: the log it was reading will never grow, and the reader
  // needs the no-daemon exit now, not at the timeout. The log is read once more first: the
  // daemon's last poll may have appended in the same second it stopped.
  let alive = true;
  for (;;) {
    const events = readEventsSince(files, since);
    if (events.length > 0) {
      for (const event of events) console.log(JSON.stringify(event));
      console.log(`cursor: ${(events.at(-1) as Event).id}`);
      return 0;
    }
    if (!alive) {
      console.log(`cursor: ${since}`);
      throw new NoDaemonError(
        `the ${ctx.source.name} daemon for ${describeOwner(owner)} stopped while this wait was running; start one as a background task of this session:\n  ${startCommand(ctx, owner)}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(`no event after ${timeoutSeconds}s`);
      console.log(`cursor: ${since}`);
      return 4;
    }
    await sleep(Math.min(WAIT_TICK_MS, remaining));
    alive = existsSync(files.socket) && isProcessAlive(daemon.pid);
  }
}

async function daemon<Target extends object>(
  ctx: Context<Target>,
  args: string[],
): Promise<number> {
  const owner = resolveOwner(takeValue(args, "id"), takeValue(args, "pid"));
  const interval = parsePositiveInt(takeValue(args, "interval"), "--interval");
  const mode = takeValue(args, "mode") ?? "bypass";
  positionals(args, 0);
  if (mode !== "bypass" && mode !== "prompting") {
    usage(`--mode must be bypass or prompting, got: ${mode}`);
  }
  if (
    interval !== undefined &&
    (interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS)
  ) {
    usage(
      `--interval must be ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS} seconds, got: ${interval}`,
    );
  }
  const busy = interval ?? ctx.source.interval;
  const idle = Math.max(busy, ctx.source.idleInterval ?? busy);
  return runDaemon(ctx, owner, filesOf(ctx, owner), busy, idle, mode);
}

// --- daemon -------------------------------------------------------------------

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

/**
 * Binding the control socket is the single-instance rule for a session: a bind refused by a daemon
 * that answers means this one is the second, and it leaves; a socket file nobody answers on was
 * left by a daemon that died and is replaced, once. A second refusal after the replacement is
 * another start that bound first, and this one leaves too.
 */
async function bindControlSocket(
  path: string,
  log: (line: string) => void,
): Promise<Server | null> {
  const first = await tryListen(path);
  if (first !== null) return first;
  try {
    (await connectOnce(path)).destroy();
    log(`another daemon answers on ${path}; exiting`);
    return null;
  } catch (error) {
    if (!isNobodyListening(error)) {
      throw new ToolingError(`${path}: ${errorText(error)}; remove it`);
    }
  }
  log(`replacing the stale control socket ${path}`);
  rmSync(path, { force: true });
  const second = await tryListen(path);
  if (second === null) log(`another start bound ${path} first; exiting`);
  return second;
}

function closingLine(name: string): string {
  return `automated notice from ${name}; no reply needed`;
}

/**
 * One poll's events as one message: the receiver drops a second frame from the same sender within
 * the same second, so a poll never sends two. Each event is its text and its URL; a blank line
 * separates events, and the closing line comes once.
 */
function digest(name: string, events: Event[]): string {
  return `${events.map((event) => `${event.text}\n${event.url}`).join("\n\n")}\n${closingLine(name)}`;
}

async function runDaemon<Target extends object>(
  ctx: Context<Target>,
  owner: Owner,
  files: Files,
  busyInterval: number,
  idleInterval: number,
  mode: Mode,
): Promise<number> {
  const { source } = ctx;
  const log = (line: string) => appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
  const server = await bindControlSocket(files.socket, log);
  if (server === null) {
    console.log(`another ${source.name} daemon already serves ${describeOwner(owner)}; exiting`);
    return 0;
  }
  let state: ReturnType<typeof loadState<Target>>;
  try {
    state = loadState<Target>(files);
  } catch (error) {
    server.close();
    rmSync(files.socket, { force: true });
    throw new ToolingError(errorText(error));
  }
  const banner = `${source.name} daemon ${process.pid} for ${describeOwner(owner)}; socket ${files.socket}; log ${files.log}; poll every ${busyInterval} s busy, ${idleInterval} s idle; mode ${mode}`;
  console.log(banner);
  log(banner);

  let polling: Promise<number> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let nextInterval = busyInterval;
  let failures = 0;
  let stopping = false;
  let lastDeliveryAt = Date.now();
  // Connections accepted whose first line has not arrived; one that has is answered and closes.
  const silent = new Set<Socket>();
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const ownerGone = (): boolean => owner.pid !== null && !isProcessAlive(owner.pid);

  // The daemon's two fields win: a source field named id or at would renumber the log.
  const number = (inputs: EventInput[]): Event[] =>
    inputs.map(({ id: _id, at: _at, ...input }) => {
      state.lastEventId += 1;
      const event: Event = { id: state.lastEventId, at: new Date().toISOString(), ...input };
      log(`event #${event.id} ${event.kind}: ${event.text.split("\n")[0]}`);
      return event;
    });

  // The log first, then the state: a daemon killed between the two restarts from a state whose
  // cursors predate the logged events and reads them again, so a crash re-sends at most one poll.
  // The other order would lose the events of that poll for good.
  const commit = (events: Event[]): void => {
    appendEvents(files, events);
    saveState(files, state);
  };

  const deliverDigest = async (events: Event[]): Promise<void> => {
    if (owner.inbox === null || events.length === 0) return;
    const gap = lastDeliveryAt + MIN_DELIVERY_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastDeliveryAt = Date.now();
    const from = `uds:${files.socket}`;
    const frame: InboxFrame = {
      type: "user",
      message: {
        role: "user",
        content: envelope(from, source.name, mode, digest(source.name, events)),
      },
      from,
      from_name: source.name,
      from_mode: mode,
      msg_id: `${source.name}-${(events[0] as Event).id}-${randomUUID()}`,
    };
    try {
      await deliver(owner.inbox, frame);
    } catch (error) {
      const ids = events.map((event) => `#${event.id}`).join(",");
      log(`delivery of ${ids} to ${owner.inbox} failed: ${errorCode(error) ?? errorText(error)}`);
    }
  };

  // The source works on a copy: a poll that throws has moved nothing, and a `watch` or `unwatch`
  // served while the poll ran is not undone when its cursors come back. Each polled target's
  // cursor lands on the current map if the very object polled is still there; one the source
  // dropped (a merged PR) goes; one watched or replaced meanwhile stays as the watch left it.
  const poll = async (): Promise<number> => {
    let result: PollResult;
    const polled = new Map(Object.entries(state.targets));
    const working = structuredClone(state.targets);
    try {
      result = await source.poll(working, { log });
    } catch (error) {
      failures += 1;
      log(`poll failed (${failures} in a row): ${errorText(error)}`);
      if (failures !== MAX_CONSECUTIVE_POLL_FAILURES) return 0;
      const trouble = number([
        {
          kind: "trouble",
          text: `${source.name}: the last ${MAX_CONSECUTIVE_POLL_FAILURES} polls failed; read the daemon log for the reason`,
          url: files.log,
        },
      ]);
      commit(trouble);
      await deliverDigest(trouble);
      return trouble.length;
    }
    failures = 0;
    for (const [key, original] of polled) {
      if (state.targets[key] !== original) continue;
      if (Object.hasOwn(working, key)) state.targets[key] = working[key] as Target;
      else delete state.targets[key];
    }
    nextInterval = result.busy ? busyInterval : idleInterval;
    const events = number(result.events);
    commit(events);
    await deliverDigest(events);
    return events.length;
  };

  const schedulePoll = (): void => {
    if (stopping) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      runPoll().catch((error: unknown) => log(`poll crashed: ${errorText(error)}`));
    }, nextInterval * 1000);
  };

  // A poll asked for while one is in flight follows it: two watches queued behind one poll each
  // get their own read. Null: the daemon is stopping and nothing was read.
  const runPoll = (): Promise<number | null> => {
    if (stopping) return Promise.resolve(null);
    if (polling) return polling.then(() => runPoll());
    if (ownerGone()) {
      void shutdown(`${describeOwner(owner)} exited`);
      return Promise.resolve(null);
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    polling = poll().finally(() => {
      polling = null;
      schedulePoll();
    });
    return polling;
  };

  // One shutdown, whoever asks first; a later stop waits for the same one. A poll in flight is
  // drained first: released earlier, the socket would let a replacement daemon start while this
  // one still delivers and saves over the replacement's state.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      stopping = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(ownerTimer);
      if (polling) await polling.catch(() => {});
      saveState(files, state);
      // close() refuses new connections and leaves accepted ones open; a client that connected and
      // never wrote would hold the process up past "daemon stopped" through its pending read.
      server.close();
      for (const client of silent) {
        client.setTimeout(SILENT_CLIENT_GRACE_MS, () => client.destroy());
      }
      try {
        unlinkSync(files.socket);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          log(`could not remove ${files.socket}: ${errorText(error)}`);
        }
      }
      log(`daemon ${process.pid} stopped: ${reason}`);
      finish(0);
    })();
    return shuttingDown;
  };

  const ownerTimer = setInterval(() => {
    if (ownerGone()) void shutdown(`${describeOwner(owner)} exited`);
  }, OWNER_CHECK_MS);

  const dispatch = async (command: Command): Promise<Reply> => {
    // A connection accepted before the stop can still carry a command; work it would add has no
    // poll left to run it.
    if (stopping && command.cmd !== "status" && command.cmd !== "stop") {
      return { ok: false, error: STOPPING_ERROR };
    }
    switch (command.cmd) {
      case "watch": {
        state.targets[command.key] = command.target as Target;
        saveState(files, state);
        log(`watch ${command.key}`);
        if ((await runPoll()) === null) throw new Error(STOPPING_ERROR);
        return { ok: true, watched: Object.keys(state.targets).length };
      }
      case "unwatch": {
        if (command.key === null) state.targets = noTargets();
        else if (!Object.hasOwn(state.targets, command.key)) {
          throw new Error(`${command.key} is not watched`);
        } else delete state.targets[command.key];
        saveState(files, state);
        log(`unwatch ${command.key ?? "everything"}`);
        return { ok: true, watched: Object.keys(state.targets).length };
      }
      case "poll":
        return { ok: true, events: (await runPoll()) ?? 0 };
      case "status":
        return {
          ok: true,
          status: {
            pid: process.pid,
            lastEventId: state.lastEventId,
            targets: Object.keys(state.targets),
          },
        };
      case "stop":
        await shutdown("stop command");
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
    // The receiver of a delivery reports what became of it to the frame's `from`, this socket, as
    // a peer_message_status frame; the log is the one place it goes.
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
  if (Object.keys(state.targets).length > 0) {
    runPoll().catch((error: unknown) => log(`poll crashed: ${errorText(error)}`));
  } else {
    schedulePoll();
  }
  return done;
}

// --- entry ---------------------------------------------------------------------

function checkSource(source: Source<object>): void {
  if (!NAME_PATTERN.test(source.name)) {
    throw new ToolingError(`the source's name must match ${NAME_PATTERN}, got: ${source.name}`);
  }
  for (const [field, value] of [
    ["interval", source.interval],
    ["idleInterval", source.idleInterval ?? source.interval],
  ] as const) {
    if (!Number.isInteger(value) || value < MIN_INTERVAL_SECONDS || value > MAX_INTERVAL_SECONDS) {
      throw new ToolingError(
        `the source's ${field} must be a whole number of seconds, ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}, got: ${value}`,
      );
    }
  }
}

export async function main<Target extends object>(
  source: Source<Target>,
  argv: string[],
  entry: string,
): Promise<number> {
  const [command, ...args] = argv;
  try {
    checkSource(source);
    if (process.platform === "win32") {
      throw new ToolingError(
        "Windows inboxes require an auth token this tool does not send; not supported",
      );
    }
    if (command === undefined) usage("missing <command>");
    if (command === "--help" || command === "-h") {
      console.log(usageText(basename(entry), source));
      return 0;
    }
    const ctx: Context<Target> = { source, entry, dir: runtimeDir() };
    switch (command) {
      case "daemon":
        return await daemon(ctx, args);
      case "watch":
        return await watch(ctx, args);
      case "unwatch":
        return await unwatch(ctx, args);
      case "wait":
        return await wait(ctx, args);
      case "poll":
        return await poll(ctx, args);
      case "status":
        return await status(ctx, args);
      case "stop":
        return await stop(ctx, args);
      default:
        usage(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${usageText(basename(entry), source)}`);
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
