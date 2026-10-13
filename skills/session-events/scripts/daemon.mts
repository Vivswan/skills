// One daemon per Claude Code session, started by that session as a background task. A child of the
// session is rendered as plain text; a detached process is a cross-session sender whose frames the
// session holds, which is why the CLI never starts the daemon and the page says never to detach it.
// The daemon owns the session side: the control socket, the delivery, the write-ahead log and the
// saved state, and the schedule. What it polls, and what the events say, is the source's.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, chmodSync, existsSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  deliver,
  envelope,
  type InboxFrame,
  inboxToken,
  isProcessAlive,
  pidOf,
  processStart,
  renderDigest,
} from "./inbox.mts";
import {
  Aborted,
  type AnySource,
  buildSource,
  type Event,
  type EventInput,
  type OptionValues,
  type PollError,
  UsageError,
} from "./source.mts";
import {
  appendEvents,
  loadState,
  nextEvent,
  type Owner,
  type OwnerFiles,
  ownerFiles,
  RuntimeDirError,
  readEventsSince,
  runtimeDir,
  type State,
  saveState,
} from "./state.mts";

const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
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

/**
 * What an entry script hands `main`: the source module's default export, and the program as the
 * user runs it (the shim's path alone, or the daemon's with the source's after it), for the usage
 * line and the start command the no-daemon error prints.
 */
export interface Entry {
  exported: unknown;
  entry: string[];
}

interface Program {
  source: AnySource;
  entry: string[];
}

// --- usage ---------------------------------------------------------------------

// A usage error ends with the failing command's own line: the whole block's last line is the
// interval floor, which a reader of the tail took for the reason.
function commandUsage(source: AnySource): Record<string, string> {
  const lines: Record<string, string> = {
    daemon: "daemon [--interval <s>] [--id <name>] [--pid <pid>]",
  };
  for (const [name, spec] of Object.entries(source.commands)) lines[name] = spec.usage;
  lines.unwatch = source.unwatch.usage;
  lines.wait = "wait [--since <id>] [--timeout <s>] [--id <name>]";
  lines.poll = "poll | status | stop                     [--id <name>]";
  lines.status = lines.poll;
  lines.stop = lines.poll;
  return lines;
}

function usageFor({ source, entry }: Program, command: string | undefined): string {
  const program = entry.map((part) => basename(part)).join(" ");
  const lines = commandUsage(source);
  if (command !== undefined && Object.hasOwn(lines, command)) {
    return `usage: ${program} ${lines[command]}`;
  }
  return [
    `usage: ${program} <command> [options]`,
    ...[...new Set(Object.values(lines))].map((line) => `  ${line}`),
    "the daemon serves the Claude Code session named by CLAUDE_CODE_MESSAGING_SOCKET and exits with it;",
    "--id <name> names a file-sink daemon for a non-Claude agent instead, --pid <pid> ends it with that process;",
    `--interval has a floor of ${source.minIntervalSeconds} s`,
  ].join("\n");
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

function filesOf(dir: string, owner: Owner, source: AnySource): OwnerFiles {
  const files = ownerFiles(dir, owner, source.name);
  if (Buffer.byteLength(files.socket) > SOCKET_PATH_MAX) {
    usage(
      `the socket path ${files.socket} is longer than the ${SOCKET_PATH_MAX} bytes a Unix socket allows; use a shorter --id or SESSION_EVENTS_DIR`,
    );
  }
  return files;
}

function describeOwner(owner: Owner): string {
  return owner.inbox === null ? `file sink ${owner.key}` : `session ${owner.key}`;
}

function startCommand({ entry }: Program, owner: Owner): string {
  const program = entry.map((part) => `"${part}"`).join(" ");
  return `bun ${program} daemon${owner.inbox === null ? ` --id ${owner.key}` : ""}`;
}

// --- control protocol --------------------------------------------------------

type Command =
  | { cmd: "watch"; target: unknown }
  | { cmd: "unwatch"; key: string | null }
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

function unwrap(reply: Reply): Reply & { ok: true } {
  if (!reply.ok) throw new ToolingError(`daemon: ${reply.error}`);
  return reply;
}

// --- argument parsing --------------------------------------------------------

const OWNER_OPTIONS = { id: { type: "string" } } as const;

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

/** The CLI side: one source, one runtime directory, and the daemon's socket for the resolved owner. */
class Cli {
  readonly source: AnySource;

  constructor(
    readonly program: Program,
    readonly dir: string,
  ) {
    this.source = program.source;
  }

  files(owner: Owner): OwnerFiles {
    return filesOf(this.dir, owner, this.source);
  }

  // The CLI never starts the daemon: a child of the CLI would outlive it detached, and a detached
  // process is a cross-session sender whose frames the session holds for approval.
  async request(owner: Owner, files: OwnerFiles, command: Command): Promise<Reply> {
    const reply = await requestIfRunning(files, command);
    if (reply === null) {
      throw new NoDaemonError(
        `no ${this.source.name} daemon answers for ${describeOwner(owner)} on ${files.socket}; start one as a background task of this session:\n  ${startCommand(this.program, owner)}`,
      );
    }
    return reply;
  }

  async watch(command: string, args: string[]): Promise<number> {
    const spec = this.source.commands[command] as NonNullable<AnySource["commands"][string]>;
    const { values, positionals } = parse(
      args,
      { ...OWNER_OPTIONS, ...spec.options },
      spec.positionals,
    );
    const target = spec.parse(positionals, values as OptionValues);
    const owner = resolveOwner(values as { id?: string });
    const reply = unwrap(await this.request(owner, this.files(owner), { cmd: "watch", target }));
    console.log(
      `watching ${this.source.describeTarget(target)} for ${describeOwner(owner)}; ${reply.watched} target(s)`,
    );
    return 0;
  }

  async unwatch(args: string[]): Promise<number> {
    const { values, positionals } = parse(args, { ...OWNER_OPTIONS, all: { type: "boolean" } }, 1);
    if (values.all === true && positionals.length > 0) usage("--all takes no target");
    const target = values.all === true ? null : this.source.unwatch.parse(positionals[0]);
    const owner = resolveOwner(values);
    unwrap(
      await this.request(owner, this.files(owner), {
        cmd: "unwatch",
        key: target === null ? null : target.key,
      }),
    );
    console.log(
      `unwatched ${target === null ? "everything" : target.label} for ${describeOwner(owner)}`,
    );
    return 0;
  }

  async poll(args: string[]): Promise<number> {
    const { values } = parse(args, OWNER_OPTIONS, 0);
    const owner = resolveOwner(values);
    const reply = unwrap(await this.request(owner, this.files(owner), { cmd: "poll" }));
    console.log(`polled; ${reply.events} event(s)`);
    return 0;
  }

  async stop(args: string[]): Promise<number> {
    const { values } = parse(args, OWNER_OPTIONS, 0);
    const owner = resolveOwner(values);
    const reply = await requestIfRunning(this.files(owner), { cmd: "stop" });
    if (reply === null) {
      console.log(`no daemon running for ${describeOwner(owner)}`);
      return 0;
    }
    unwrap(reply);
    console.log("daemon stopped");
    return 0;
  }

  async status(args: string[]): Promise<number> {
    const { values } = parse(args, OWNER_OPTIONS, 0);
    const owner = resolveOwner(values);
    const files = this.files(owner);
    const status = unwrap(await this.request(owner, files, { cmd: "status" }))
      .status as StatusReply;
    const { state } = status;
    const delivery = state.delivery
      ? `${state.delivery.outcome} (#${state.delivery.eventIds.join(",#")} at ${state.delivery.at})`
      : "none";
    const lines = [
      `daemon: running (pid ${status.pid}) for ${describeOwner(owner)}`,
      `socket: ${files.socket}`,
      `log: ${files.log}`,
      `events: ${files.events}`,
      `delivery: ${delivery}`,
      ...this.source.describeStatus(state.saved),
    ];
    const last = readEventsSince(files, state.lastEventId - 1).at(-1);
    lines.push(
      last
        ? `last event: #${last.id} at ${last.at} ${last.kind} ${this.source.subjectOf(last) ?? "daemon"}: ${last.text.split("\n")[0]}`
        : "last event: none",
    );
    console.log(lines.join("\n"));
    return 0;
  }

  async wait(args: string[]): Promise<number> {
    const { values } = parse(
      args,
      { ...OWNER_OPTIONS, since: { type: "string" }, timeout: { type: "string" } },
      0,
    );
    const owner = resolveOwner(values);
    const files = this.files(owner);
    // A wait with no daemon would block for its whole timeout on a log nothing appends to.
    const status = unwrap(await this.request(owner, files, { cmd: "status" }))
      .status as StatusReply;
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
        console.log(`cursor: ${(events.at(-1) as Event).id}`);
        return 0;
      }
      if (daemon === null) {
        console.log(`cursor: ${since}`);
        throw new NoDaemonError(
          `the ${this.source.name} daemon for ${describeOwner(owner)} stopped while this wait was running; start one as a background task of this session:\n  ${startCommand(this.program, owner)}`,
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

  async daemon(args: string[]): Promise<number> {
    const { values } = parse(
      args,
      { ...OWNER_OPTIONS, pid: { type: "string" }, interval: { type: "string" } },
      0,
    );
    const owner = resolveOwner(values);
    const floor = this.source.minIntervalSeconds;
    const interval = parsePositiveInt(values.interval, "--interval") ?? floor;
    if (interval < floor) {
      usage(`--interval must be at least ${floor} seconds, got: ${interval}`);
    }
    return runDaemon(this.source, owner, this.files(owner), interval);
  }
}

/**
 * The pid of the daemon holding the socket, or null when none does, without a connection a tick:
 * a daemon inside a read accepts nothing for up to a minute, and probes queued in its listen
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
 * left by a daemon that died and is replaced, once. A second refusal after the replacement is
 * another start that bound first, and this one leaves too. `preflight` runs once the socket is
 * held: what it refuses is closed and its socket removed.
 */
async function bindControlSocket(
  path: string,
  log: (line: string) => void,
  preflight: () => void,
): Promise<Server | null> {
  const ready = async (server: Server): Promise<Server> => {
    try {
      preflight();
    } catch (error) {
      server.close();
      await once(server, "close");
      rmSync(path, { force: true });
      throw new ToolingError(errorText(error));
    }
    return server;
  };
  const first = await tryListen(path);
  if (first !== null) return ready(first);
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (found !== undefined && !found.isSocket()) {
    throw new ToolingError(`${path} is not a socket; remove it`);
  }
  try {
    (await connectOnce(path)).destroy();
    log(`another daemon answers on ${path}; exiting`);
    return null;
  } catch (error) {
    if (!isNobodyListening(error)) throw error;
  }
  log(`replacing the stale control socket ${path}`);
  rmSync(path, { force: true });
  const second = await tryListen(path);
  if (second === null) {
    log(`another start bound ${path} first; exiting`);
    return null;
  }
  return ready(second);
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

async function runDaemon(
  source: AnySource,
  owner: Owner,
  files: OwnerFiles,
  intervalSeconds: number,
): Promise<number> {
  const log = (line: string) => appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
  // The socket first: only its holder may read or repair the state and the log, or a second daemon
  // starting while the first has saved a poll it has not yet appended would append it too.
  // The source's preflight (gh on PATH) is asked only of the daemon that will poll: a second start
  // without it finds the first daemon serving and exits 0 like any other second start, instead of
  // hiding it behind exit 2.
  const server = await bindControlSocket(files.socket, log, () => source.preflight?.());
  if (server === null) {
    console.log(`another ${source.name} daemon already serves ${describeOwner(owner)}; exiting`);
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
  const { state, unlogged, newestEventAt, staleOwner, movedEvents } = loadState(
    files,
    incarnation,
    source.restore,
  );
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
  const banner = `${source.name} daemon ${process.pid} for ${describeOwner(owner)}; socket ${files.socket}; log ${files.log}; poll every ${intervalSeconds} s`;
  console.log(banner);
  log(banner);

  let polling: Promise<number> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let troubled = false;
  let stopping = false;
  // Connections accepted whose first line has not arrived; one that has is answered and closes.
  const silent = new Set<Socket>();
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const watchedCount = (): number => source.countTargets(state.saved);

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
  const checkAbort = (): void => {
    const reason = ownerGoneReason();
    if (reason !== null) throw new Aborted(reason);
  };

  // The poll's events are numbered here, in the order the source gave them, and reach the disk
  // in the state first and then the log (`commitPoll` below).
  const number = (inputs: EventInput[]): Event[] =>
    inputs.map((input) => {
      const event = nextEvent(state, input);
      log(
        `event #${event.id} ${event.kind} ${source.subjectOf(event) ?? "daemon"}: ${event.text.split("\n")[0]}`,
      );
      return event;
    });

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
  const deliverDigest = async (emitted: Event[]): Promise<void> => {
    if (owner.inbox === null || emitted.length === 0) return;
    const gap = lastDeliveryAt + MIN_DELIVERY_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    const from = `uds:${files.socket}`;
    const frame: InboxFrame = {
      type: "user",
      message: {
        role: "user",
        content: envelope(from, source.name, renderDigest(source, emitted)),
      },
      from,
      from_name: source.name,
      msg_id: `${source.name}-${(emitted[0] as Event).id}-${randomUUID()}`,
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

  // The state is saved first, the poll's events inside it, and the log appended from it; a daemon
  // killed between the two completes the log on restart and judges nothing twice. The delivery
  // comes last, so one killed before it leaves the events in the log for `status` and `wait`.
  const commitPoll = (emitted: Event[]): void => {
    state.lastPoll = emitted;
    saveState(files, state);
    appendEvents(files, emitted);
  };

  const troubleText = ({ where, message, advice }: PollError): string =>
    `polling failed ${MAX_CONSECUTIVE_POLL_FAILURES} times in a row (${where}: ${message}); not a verdict. ${advice ?? "Polling retries on the next interval"}`;

  const poll = async (scope: string | null): Promise<number> => {
    const result = await source.poll({
      saved: state.saved,
      scope,
      logPath: files.log,
      log,
      checkAbort,
    });
    state.saved = result.saved;
    for (const { where, message } of result.errors) log(`poll: ${where}: ${message}`);
    const emitted = number(result.events);
    if (result.aborted !== undefined) {
      log(`poll stopped: ${result.aborted}`);
      commitPoll(emitted);
      return emitted.length;
    }
    // The daemon's health is judged on full polls, which read every target: a scoped poll that
    // succeeds has not retried the read that failed, and one that fails is retried within a minute.
    if (scope === null) {
      const daemonWide = { ...source.blankTarget, kind: "trouble" };
      const lastError = result.errors.at(-1);
      if (lastError !== undefined) {
        failures += 1;
        if (failures === MAX_CONSECUTIVE_POLL_FAILURES) {
          troubled = true;
          emitted.push(...number([{ ...daemonWide, text: troubleText(lastError) }]));
        }
      } else {
        failures = 0;
        if (troubled) {
          troubled = false;
          emitted.push(...number([{ ...daemonWide, text: "polling recovered" }]));
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
  const runPoll = (scope: string | null = null): Promise<number | null> => {
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

  const subscribe = async (target: unknown): Promise<number> => {
    const { saved, key, logLine } = source.subscribe(state.saved, target);
    state.saved = saved;
    saveState(files, state);
    log(logLine);
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
      case "unwatch":
        state.saved = source.unsubscribe(state.saved, command.key);
        saveState(files, state);
        return { ok: true, watched: watchedCount() };
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

// --- entry ---------------------------------------------------------------------

export async function main(argv: string[], { exported, entry }: Entry): Promise<number> {
  const [command, ...rest] = argv;
  let program: Program | null = null;
  try {
    const source = buildSource(exported);
    if (source === null) {
      throw new ToolingError(
        `${entry.at(-1)} does not export a source: its default export must be a source factory, (kit) => ({ ... }), see source.mts`,
      );
    }
    program = { source, entry };
    if (process.platform === "win32") {
      throw new ToolingError(
        "Windows inboxes require an auth token this tool does not send; not supported",
      );
    }
    if (command === undefined) usage("missing <command>");
    const cli = new Cli(program, runtimeDir());
    if (Object.hasOwn(program.source.commands, command)) return await cli.watch(command, rest);
    switch (command) {
      case "daemon":
        return await cli.daemon(rest);
      case "unwatch":
        return await cli.unwatch(rest);
      case "wait":
        return await cli.wait(rest);
      case "poll":
        return await cli.poll(rest);
      case "status":
        return await cli.status(rest);
      case "stop":
        return await cli.stop(rest);
      default:
        usage(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError && program !== null) {
      console.error(`${error.message}\n${usageFor(program, command)}`);
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
