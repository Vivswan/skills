#!/usr/bin/env bun
// A builder as an ACP agent: `start` spawns an adapter (codex-acp, claude-agent-acp, `gemini --acp`)
// in the builder's worktree, opens one session there, and keeps it alive behind a control socket.
// `prompt` hands the builder a turn, `cancel` interrupts it, `status` reads it, `stop` ends it.
//
//   <dir>/<name>.acp-runner.state.json    phase, the last stop reason, the adapter, the session
//   <dir>/<name>.acp-runner.events.jsonl  one line per session update, permission, prompt, stop, exit
//   <dir>/<name>.acp-runner.sock          the control socket; <dir> is the session-events runtime directory
//
// The permission rule is the owner's: a builder writes its own worktree and nothing else. Every
// command runs; a file tool whose locations all sit inside the worktree runs; one outside is refused.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import type * as acpTypes from "@agentclientprotocol/sdk";

const USAGE = [
  "usage: acp-runner.mts <command> [options]",
  "  start --name <builder> --cwd <worktree> [--mode <id>] [--allow-outside] --adapter <command> [args...]",
  "      spawn the adapter in the worktree, open one ACP session there, and serve the control socket until stop",
  "  prompt --name <builder> (<text> | --file <path>)   send the text as the builder's next turn",
  "  status --name <builder>                            print the state file as JSON",
  "  cancel --name <builder>                            interrupt the running turn",
  "  stop --name <builder>                              end the session and the adapter",
  "--name is [a-z0-9-]{1,40}; --cwd is the builder's worktree, absolute; --adapter is last and takes the rest of the line",
  "--mode names a session mode the adapter advertises (codex-acp: read-only, workspace-write, agent, agent-full-access;",
  "  claude-agent-acp: default, acceptEdits, plan, auto, bypassPermissions); one it does not advertise is a usage error",
  "permissions: every command runs; a file tool whose locations all sit inside the worktree runs; one outside is refused",
  "  and recorded, unless --allow-outside",
  "files: <dir>/<name>.acp-runner.{state.json,events.jsonl,sock}; <dir> is $SESSION_EVENTS_DIR, else $XDG_RUNTIME_DIR/session-events,",
  "  else $CLAUDE_CODE_TMPDIR/session-events-<uid>, else <os tmpdir>/session-events-<uid>, else /tmp/session-events-<uid>",
  "prints: start, one banner line, then nothing until it exits; prompt, one word: prompted, or busy while a turn runs;",
  "  status, the state object; cancel and stop, one word: cancelled, stopped",
  "exits: 0 ok; 1 prompt refused (busy, or the runner still starting), or start ending because the adapter exited;",
  "       2 usage, a mode the adapter lacks, or a runner of this name already serving; 3 no runner answers for this name",
].join("\n");

// Above the self-build: a cold install with no network still answers --help.
if (import.meta.main && (process.argv[2] === "--help" || process.argv[2] === "-h")) {
  console.log(USAGE);
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
const acp = await import("@agentclientprotocol/sdk");

const SOURCE = "acp-runner";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOCKET_PATH_MAX = 104;
const STOP_GRACE_MS = 2000;
const LAUNCHER_POLL_MS = 1000;
const SYMLINK_HOPS = 40;
const EXIT_USAGE = 2;
const EXIT_NO_RUNNER = 3;
/** The source script, named in messages: both scripts/ and .build/ sit one level under the skill. */
const SELF = join(dirname(dirname(import.meta.path)), "scripts", "acp-runner.mts");

type Phase = "starting" | "idle" | "busy" | "permission" | "ended";

/** What `status` prints and what a monitor reads: the runner's standing facts, rewritten whole on every change. */
interface State {
  name: string;
  pid: number;
  adapter: string[];
  cwd: string;
  sessionId: string | null;
  phase: Phase;
  startedAt: string;
  lastUpdateAt: string | null;
  lastStop: string | null;
  steering: boolean;
  endedAt: string | null;
  reason: string | null;
}

interface Files {
  state: string;
  events: string;
  socket: string;
}

type Command =
  | { command: "prompt"; text: string }
  | { command: "status" }
  | { command: "cancel" }
  | { command: "stop" };

type Reply = { ok: true; result: string; state?: State } | { ok: false; error: string };

interface StartOptions {
  name: string;
  cwd: string;
  adapter: string[];
  mode: string | null;
  allowOutside: boolean;
}

class UsageError extends Error {}

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(EXIT_USAGE);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The directory the session-events daemons keep their sockets in, so the runner's files sit beside
 * theirs under one rule: the same ladder, a private directory per user, the override first and
 * absolute. A bundled script cannot import the rule across skills.
 */
function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? 0;
  const candidates: string[] = [];
  if (env.SESSION_EVENTS_DIR) {
    if (!isAbsolute(env.SESSION_EVENTS_DIR) || /[\r\n]/.test(env.SESSION_EVENTS_DIR)) {
      usage(
        `SESSION_EVENTS_DIR must be an absolute path on one line, got: ${JSON.stringify(env.SESSION_EVENTS_DIR)}`,
      );
    }
    candidates.push(env.SESSION_EVENTS_DIR);
  }
  if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "session-events"));
  if (env.CLAUDE_CODE_TMPDIR)
    candidates.push(join(env.CLAUDE_CODE_TMPDIR, `session-events-${uid}`));
  candidates.push(join(tmpdir(), `session-events-${uid}`), `/tmp/session-events-${uid}`);
  const refused: string[] = [];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== uid) {
        refused.push(`${dir}: not a directory owned by uid ${uid}`);
        continue;
      }
      if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
      return dir;
    } catch (error) {
      refused.push(`${dir}: ${errorText(error)}`);
    }
  }
  usage(
    `no usable runtime directory; set SESSION_EVENTS_DIR to a private directory\n  ${refused.join("\n  ")}`,
  );
}

function filesOf(dir: string, name: string): Files {
  const stem = join(dir, `${name}.${SOURCE}`);
  const files = {
    state: `${stem}.state.json`,
    events: `${stem}.events.jsonl`,
    socket: `${stem}.sock`,
  };
  if (Buffer.byteLength(files.socket) > SOCKET_PATH_MAX) {
    usage(
      `the socket path ${files.socket} is longer than the ${SOCKET_PATH_MAX} bytes a Unix socket allows; use a shorter --name or SESSION_EVENTS_DIR`,
    );
  }
  return files;
}

function requireName(value: string | undefined): string {
  if (value === undefined || !NAME_PATTERN.test(value)) {
    usage(`--name must match ${NAME_PATTERN}, got ${JSON.stringify(value ?? "")}`);
  }
  return value;
}

/**
 * Where a path would land, walked one segment at a time from a real base: a symlink is followed as
 * it is met, so `link/../x` lands beside the link's target, never beside the link; a dangling link
 * counts as its target; a segment not there yet is appended as named. `..` steps up from wherever
 * the walk stands, never lexically.
 */
function landingPath(base: string, path: string, hops = 0): string {
  const absolute = isAbsolute(path);
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  let current = absolute ? "/" : base;
  for (const [index, segment] of segments.entries()) {
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = current === "/" ? `/${segment}` : `${current}/${segment}`;
    const stat = lstatSync(next, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() && hops < SYMLINK_HOPS) {
      const rest = segments.slice(index + 1).join("/");
      const target = readlinkSync(next);
      return landingPath(current, rest === "" ? target : `${target}/${rest}`, hops + 1);
    }
    current = next;
  }
  return current;
}

function insideWorktree(cwd: string, path: string): boolean {
  const rel = relative(realpathSync(cwd), landingPath(realpathSync(cwd), path));
  return rel === "" || (rel.split("/")[0] !== ".." && !isAbsolute(rel));
}

/** The owner's rule on one request: allowed, or the paths that refuse it; a path that cannot be judged refuses. */
function judgePermission(
  toolCall: acpTypes.RequestPermissionRequest["toolCall"],
  cwd: string,
  allowOutside: boolean,
): { allow: boolean; outside: string[] } {
  if (toolCall.kind === "execute" || allowOutside) return { allow: true, outside: [] };
  const outside: string[] = [];
  for (const location of toolCall.locations ?? []) {
    try {
      if (!insideWorktree(cwd, location.path)) outside.push(location.path);
    } catch (error) {
      outside.push(`${location.path} (${errorText(error)})`);
    }
  }
  return { allow: outside.length === 0, outside };
}

/** The first allow or the first reject the adapter offers; none to reject with is a cancel. */
function chooseOption(
  options: acpTypes.PermissionOption[],
  allow: boolean,
): acpTypes.RequestPermissionResponse {
  const kinds: acpTypes.PermissionOptionKind[] = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined)
      return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function adapterExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// --- the runner, the process `start` becomes -------------------------------------------------

class Runner {
  private state: State;
  private server: Server | null = null;
  /** The one shutdown in flight, which every stop caller awaits. */
  private stopping: Promise<void> | null = null;
  private readonly finished = Promise.withResolvers<void>();
  /** The adapter's exit, awaited by stop; taken at construction so an exit before stop is never missed. */
  private readonly exited: Promise<unknown>;

  constructor(
    private readonly files: Files,
    private readonly options: StartOptions,
    private readonly child: ReturnType<typeof spawn>,
    private readonly agent: acpTypes.ClientContext,
  ) {
    this.exited = once(child, "exit").catch(() => undefined);
    this.state = {
      name: options.name,
      pid: process.pid,
      adapter: options.adapter,
      cwd: options.cwd,
      sessionId: null,
      phase: "starting",
      startedAt: now(),
      lastUpdateAt: null,
      lastStop: null,
      steering: false,
      endedAt: null,
      reason: null,
    };
  }

  /** Resolves once the adapter is gone and the state says why. */
  get done(): Promise<void> {
    return this.finished.promise;
  }

  /** A stop in progress owns the end: the adapter's exit is ours, not a death to report. */
  get isStopping(): boolean {
    return this.stopping !== null;
  }

  /** Written whole and renamed into place, so a reader never sees half of it. */
  private save(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    writeFileSync(`${this.files.state}.tmp`, `${JSON.stringify(this.state)}\n`);
    renameSync(`${this.files.state}.tmp`, this.files.state);
  }

  private event(entry: Record<string, unknown>): void {
    appendFileSync(this.files.events, `${JSON.stringify({ at: now(), ...entry })}\n`);
  }

  snapshot(): State {
    return this.state;
  }

  async open(): Promise<void> {
    const init = await this.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const steering =
      (init._meta as { steering?: { supported?: boolean } } | undefined)?.steering?.supported ===
      true;
    const session = await this.agent.request(acp.methods.agent.session.new, {
      cwd: this.options.cwd,
      mcpServers: [],
    });
    if (this.options.mode !== null) {
      const offered = (session.modes?.availableModes ?? []).map((mode) => mode.id);
      if (!offered.includes(this.options.mode)) {
        throw new UsageError(
          `the adapter offers no mode ${JSON.stringify(this.options.mode)}; it offers: ${offered.length === 0 ? "none" : offered.join(", ")}`,
        );
      }
      await this.agent.request(acp.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: this.options.mode,
      });
    }
    this.save({ sessionId: session.sessionId, phase: "idle", steering });
    this.event({
      kind: "started",
      sessionId: session.sessionId,
      mode: this.options.mode,
      steering,
    });
  }

  onUpdate(notification: acpTypes.SessionNotification): void {
    this.save({ lastUpdateAt: now() });
    this.event({ kind: "update", update: notification.update });
  }

  async onPermission(
    request: acpTypes.RequestPermissionRequest,
  ): Promise<acpTypes.RequestPermissionResponse> {
    const verdict = judgePermission(request.toolCall, this.options.cwd, this.options.allowOutside);
    const answer = chooseOption(request.options, verdict.allow);
    this.save({ phase: "permission", lastUpdateAt: now() });
    this.event({
      kind: "permission",
      title: request.toolCall.title,
      toolKind: request.toolCall.kind,
      locations: (request.toolCall.locations ?? []).map((location) => location.path),
      allowed: verdict.allow,
      outside: verdict.outside,
      answer: answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled",
    });
    this.save({ phase: "busy" });
    return answer;
  }

  private async turn(text: string): Promise<void> {
    const sessionId = this.state.sessionId as string;
    try {
      const response = await this.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      this.event({ kind: "stop", stopReason: response.stopReason });
      if (this.state.phase !== "ended") {
        this.save({ phase: "idle", lastStop: response.stopReason, lastUpdateAt: now() });
      }
    } catch (error) {
      this.event({ kind: "error", message: errorText(error) });
      if (this.state.phase !== "ended") this.save({ phase: "idle", lastStop: "error" });
    }
  }

  prompt(text: string): Reply {
    if (this.state.phase === "starting")
      return { ok: false, error: "the runner is still starting" };
    if (this.state.phase === "ended")
      return { ok: false, error: `the runner ended: ${this.state.reason}` };
    if (this.state.phase !== "idle") return { ok: true, result: "busy" };
    this.save({ phase: "busy", lastUpdateAt: now() });
    this.event({ kind: "prompt", text });
    void this.turn(text);
    return { ok: true, result: "prompted" };
  }

  async cancel(): Promise<string> {
    if (this.state.phase !== "busy" && this.state.phase !== "permission") return this.state.phase;
    await this.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.state.sessionId as string,
    });
    this.event({ kind: "cancel" });
    return "cancelled";
  }

  stop(reason: string): Promise<void> {
    this.stopping ??= this.shutdown(reason);
    return this.stopping;
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.state.phase === "busy" || this.state.phase === "permission") await this.cancel();
    if (!adapterExited(this.child)) {
      this.child.stdin?.end();
      // An adapter that ignores SIGTERM goes by SIGKILL after the grace, while this process still runs.
      const grace = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS);
      this.child.kill("SIGTERM");
      await this.exited;
      clearTimeout(grace);
    }
    this.end(reason);
  }

  end(reason: string): void {
    if (this.state.phase === "ended") return;
    this.save({ phase: "ended", endedAt: now(), reason });
    this.event({ kind: "ended", reason });
    this.server?.close();
    rmSync(this.files.socket, { force: true });
    this.finished.resolve();
  }

  async handle(command: Command): Promise<Reply> {
    switch (command.command) {
      case "status":
        return { ok: true, result: this.state.phase, state: this.state };
      case "prompt":
        return this.prompt(command.text);
      case "cancel":
        return { ok: true, result: await this.cancel() };
      case "stop":
        // The reply goes out before the stop, which ends the socket this reply travels on.
        setTimeout(() => void this.stop("stopped"), 0);
        return { ok: true, result: "stopped" };
    }
  }

  private async answer(socket: Socket, line: string): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.handle(JSON.parse(line) as Command);
    } catch (error) {
      reply = { ok: false, error: errorText(error) };
    }
    socket.end(`${JSON.stringify(reply)}\n`);
  }

  serve(server: Server): void {
    this.server = server;
    server.on("connection", (socket) => {
      let buffer = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        void this.answer(socket, line);
      });
      socket.on("error", () => socket.destroy());
    });
  }
}

// --- start -------------------------------------------------------------------------------

function takeOne(args: string[], at: number): string {
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`${args[at]} requires a value`);
  args.splice(at + 1, 1);
  return value;
}

/** `--adapter` is last and owns the rest of the line, so an adapter's own `--flags` pass through. */
function parseStart(args: string[]): StartOptions {
  const options: StartOptions = { name: "", cwd: "", adapter: [], mode: null, allowOutside: false };
  const flags: Record<string, (at: number) => void> = {
    "--name": (at) => {
      options.name = requireName(takeOne(args, at));
    },
    "--cwd": (at) => {
      options.cwd = takeOne(args, at);
    },
    "--mode": (at) => {
      options.mode = takeOne(args, at);
    },
    "--allow-outside": () => {
      options.allowOutside = true;
    },
    "--adapter": (at) => {
      options.adapter = args.splice(at + 1);
      if (options.adapter.length === 0) usage("--adapter requires a command");
    },
  };
  for (let at = 0; at < args.length; at += 1) {
    const handler = flags[args[at] as string];
    if (handler === undefined) usage(`unknown option: ${args[at]}`);
    handler(at);
  }
  if (options.name === "") usage("start requires --name");
  if (options.adapter.length === 0) usage("start requires --adapter <command> [args...]");
  if (
    !isAbsolute(options.cwd) ||
    !existsSync(options.cwd) ||
    !statSync(options.cwd).isDirectory()
  ) {
    usage(`--cwd must be an existing absolute directory, got ${JSON.stringify(options.cwd)}`);
  }
  return options;
}

async function connectOnce(path: string): Promise<Socket> {
  const socket = connect(path);
  await once(socket, "connect");
  return socket;
}

function isNobodyListening(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** The single-instance rule for a name: a socket somebody answers on is a running runner; one nobody answers on is stale and replaced. */
async function bindControlSocket(path: string): Promise<Server> {
  try {
    (await connectOnce(path)).destroy();
    usage(`a runner of this name already serves ${path}; stop it first, or choose another --name`);
  } catch (error) {
    if (!isNobodyListening(error)) throw error;
  }
  rmSync(path, { force: true });
  const server = createServer();
  server.listen(path);
  await once(server, "listening");
  chmodSync(path, 0o600);
  return server;
}

/** The adapter under the SDK's client, with the runner answering its permissions and logging its updates. */
function connectAdapter(
  options: StartOptions,
  files: Files,
): { child: ReturnType<typeof spawn>; runner: Runner } {
  const [command, ...rest] = options.adapter as [string, ...string[]];
  const child = spawn(command, rest, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin as NodeJS.WritableStream),
    Readable.toWeb(child.stdout as NodeJS.ReadableStream) as ReadableStream<Uint8Array>,
  );
  let runner: Runner | null = null;
  const connection = acp
    .client({ name: SOURCE })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      (runner as Runner).onPermission(ctx.params),
    )
    .onNotification(acp.methods.client.session.update, (ctx) => {
      runner?.onUpdate(ctx.params);
    })
    .connect(stream);
  runner = new Runner(files, options, child, connection.agent);
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter((entry) => entry.trim() !== "")) {
      appendFileSync(files.events, `${JSON.stringify({ at: now(), kind: "stderr", line })}\n`);
    }
  });
  return { child, runner };
}

async function start(args: string[]): Promise<number> {
  const options = parseStart(args);
  const files = filesOf(runtimeDir(), options.name);
  const server = await bindControlSocket(files.socket);
  rmSync(files.events, { force: true });
  const { child, runner } = connectAdapter(options, files);
  // Served from the first moment the socket exists: a command during the handshake is answered, not dropped.
  runner.serve(server);
  let exitCode = 0;
  child.on("exit", (code, signal) => {
    if (runner.isStopping) return;
    exitCode = 1;
    runner.end(`adapter exited ${code ?? signal ?? "unknown"}`);
  });
  child.on("error", (error) => {
    exitCode = 1;
    runner.end(`adapter failed to start: ${errorText(error)}`);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => void runner.stop(`runner received ${signal}`));
  }
  // Run as source, this process is the self-build wrapper's child, and a signal to the wrapper never
  // reaches it: a launcher that is gone ends the runner the same way a signal would.
  const launcher = process.ppid;
  setInterval(() => {
    if (process.ppid !== launcher) void runner.stop("the launcher exited");
  }, LAUNCHER_POLL_MS).unref();
  try {
    await runner.open();
  } catch (error) {
    await runner.stop(errorText(error));
    if (error instanceof UsageError) usage(error.message);
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  }
  const state = runner.snapshot();
  console.log(
    `${SOURCE} ${options.name} pid ${process.pid}: ${options.adapter.join(" ")} in ${options.cwd}; session ${state.sessionId}; socket ${files.socket}; state ${files.state}`,
  );
  await runner.done;
  return exitCode;
}

// --- the client commands -----------------------------------------------------------------

async function request(files: Files, command: Command): Promise<Reply> {
  let socket: Socket;
  try {
    socket = await connectOnce(files.socket);
  } catch (error) {
    if (isNobodyListening(error)) {
      process.stderr.write(
        `no ${SOURCE} answers on ${files.socket}; start one as a background task:\n  bun "${SELF}" start --name <builder> --cwd <worktree> --adapter <command>\n`,
      );
      process.exit(EXIT_NO_RUNNER);
    }
    throw error;
  }
  socket.setEncoding("utf-8");
  socket.write(`${JSON.stringify(command)}\n`);
  let buffer = "";
  for await (const chunk of socket) buffer += chunk as string;
  const line = buffer.split("\n")[0] ?? "";
  if (line === "") {
    process.stderr.write("the runner closed the connection without a reply\n");
    process.exit(EXIT_NO_RUNNER);
  }
  return JSON.parse(line) as Reply;
}

function takeValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`--${name} requires a value`);
  args.splice(at, 2);
  return value;
}

function promptText(args: string[]): string {
  const file = takeValue(args, "file");
  if (file !== undefined) {
    if (args.length > 0) usage(`prompt takes <text> or --file <path>, not both: ${args.join(" ")}`);
    return readFileSync(file, "utf8");
  }
  const text = args.join(" ");
  if (text.trim() === "") usage("prompt needs <text> or --file <path>");
  return text;
}

/** The command as the socket carries it, every argument checked before the runner is contacted. */
function clientRequest(command: string, args: string[]): Command {
  if (command === "prompt") return { command: "prompt", text: promptText(args) };
  if (command !== "status" && command !== "cancel" && command !== "stop") {
    usage(`unknown command: ${command}`);
  }
  if (args.length > 0) usage(`${command} takes no argument: ${args.join(" ")}`);
  return { command };
}

async function clientCommand(command: string, args: string[]): Promise<number> {
  const name = requireName(takeValue(args, "name"));
  const request_ = clientRequest(command, args);
  const reply = await request(filesOf(runtimeDir(), name), request_);
  if (!reply.ok) {
    process.stderr.write(`${reply.error}\n`);
    return 1;
  }
  if (command === "status") {
    console.log(JSON.stringify(reply.state, null, 2));
    return 0;
  }
  console.log(reply.result);
  return reply.result === "busy" ? 1 : 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "start") return await start(args);
  if (command === undefined) usage("a command is required");
  return await clientCommand(command, args);
}

if (import.meta.main) process.exit(await main());
