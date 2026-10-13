// The session-events daemon's test harness, shared by every test file that starts one: the daemon
// is started the way a session starts it, as a child, owned by a fake Claude Code inbox, a Unix
// socket named by this live pid that collects every connection's bytes. Polls are driven with
// `poll` and `watch`, so no timer needs to fire. A `Program` names the source script that runs the
// daemon, so the same scenario drives the fake source and the GitHub source. Call
// sessionEventsHarness() at the file's top level: bun:test binds hooks to the registering file,
// and the harness holds that file's temp dirs and daemons; the test's end kills what `stop` did
// not, and the file's end asserts none is left alive.

import { afterAll, afterEach, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { isProcessAlive, startToken } from "../../skills/session-events/scripts/inbox.mts";
import { type Files, ownerFiles } from "../../skills/session-events/scripts/state.mts";
import { type TempDirs, tempDirs } from "./temp-dirs";

/** What a scenario runs: the source script, the source's name (its file stem), and the environment it needs. */
export interface Program {
  script: string;
  source: string;
  env(scenario: Scenario): Record<string, string>;
}

// --- plumbing -------------------------------------------------------------------

export interface Inbox {
  path: string;
  /** Waits for `expected` closed connections (or gives up after a few seconds), then settles: the
   * bytes arrived while spawnSync held this process's event loop. */
  frames: (expected: number) => Promise<string[]>;
  /** The events log's ids as they stood when each connection arrived. */
  logAtConnect: number[][];
  /** The saved counter as it stood when each connection arrived. */
  savedAtConnect: number[];
  /** When each connection arrived, meaningful only while this process's event loop was free. */
  arrivedAt: number[];
  close: () => void;
}

export function readOr<T>(read: () => T, absent: T): T {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
    throw error;
  }
}

function eventIds(logPath: string): number[] {
  return readOr(() => readFileSync(logPath, "utf-8"), "")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: number }).id);
}

function savedCounter(statePath: string): number {
  return readOr(
    () => (JSON.parse(readFileSync(statePath, "utf-8")) as { lastEventId: number }).lastEventId,
    0,
  );
}

/** A fake Claude Code inbox at <dir>/<this pid>.sock: the owner it names is this live process. */
function listen(dir: string, files: () => Files): Promise<Inbox> {
  const path = join(dir, `${process.pid}.sock`);
  const connections: string[] = [];
  const logAtConnect: number[][] = [];
  const savedAtConnect: number[] = [];
  const arrivedAt: number[] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
      logAtConnect.push(eventIds(files().events));
      savedAtConnect.push(savedCounter(files().state));
      arrivedAt.push(Date.now());
      let bytes = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk: string) => {
        bytes += chunk;
      });
      socket.on("close", () => connections.push(bytes));
    });
    server.once("error", reject);
    server.listen(path, () =>
      resolve({
        path,
        frames: async (expected: number) => {
          const deadline = Date.now() + 3000;
          while (connections.length < expected && Date.now() < deadline) await Bun.sleep(20);
          await Bun.sleep(150);
          return [...connections];
        },
        logAtConnect,
        savedAtConnect,
        arrivedAt,
        close: () => server.close(),
      }),
    );
  });
}

/** A socket file nobody listens on: the listener was killed before it could unlink it. */
export function deadSocketFile(path: string): void {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      'require("node:net").createServer().listen(process.env.DEAD_SOCKET, () => process.kill(process.pid, "SIGKILL"))',
    ],
    { env: { ...process.env, DEAD_SOCKET: path }, stdout: "ignore", stderr: "inherit" },
  );
  if (!existsSync(path)) {
    throw new Error(`no dead socket file at ${path} (exit ${result.exitCode})`);
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** The owner's inbox, handed to the process as CLAUDE_CODE_MESSAGING_SOCKET. */
  inbox?: string;
  env?: Record<string, string>;
}

export interface StartOptions extends RunOptions {
  /** A file-sink daemon's name; without it and without an inbox the daemon exits 2. */
  id?: string;
  args?: string[];
}

export type Daemon = ReturnType<typeof Bun.spawn>;

/** Whose files: a file sink by id, or a session by its pid and inbox (this process by default). */
export type OwnerKey = { id: string } | { pid: number; inbox: string };

export class Scenario {
  readonly dir: string;
  /** Where a scenario's fixtures go: the fake source's polls, or the stub gh's replies. */
  readonly fixtureDir: string;
  private readonly inboxes: Inbox[] = [];
  private readonly daemons: Daemon[] = [];
  private sessionInbox = "";

  constructor(
    readonly program: Program,
    name: string,
  ) {
    this.dir = harness().temp.dir(`session-events-${name}-`);
    this.fixtureDir = join(this.dir, "fixtures");
    mkdirSync(this.fixtureDir);
    harness().scenarios.push(this);
  }

  /** Writes each fixture; a name without an extension gets `.json`. */
  fixtures(files: Record<string, string>): void {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(this.fixtureDir, name.includes(".") ? name : `${name}.json`), body);
    }
  }

  env(options: RunOptions = {}): Record<string, string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SESSION_EVENTS_DIR: this.dir,
      ...this.program.env(this),
      ...options.env,
    };
    // The test process may itself run inside a Claude Code session; the owner is the test's choice.
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    delete env.CLAUDE_PID;
    if (options.inbox !== undefined) env.CLAUDE_CODE_MESSAGING_SOCKET = options.inbox;
    return env;
  }

  command(args: string[]): string[] {
    return [process.execPath, this.program.script, ...args];
  }

  run(args: string[], options: RunOptions = {}): RunResult {
    const result = Bun.spawnSync(this.command(args), {
      env: this.env(options),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  /** The command as a child that outlives the call, for a CLI whose timing the test watches. */
  spawn(args: string[], options: RunOptions = {}): Daemon {
    return Bun.spawn(this.command(args), {
      env: this.env(options),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Starts a daemon as a session would, as a child, and waits for its banner in the log (or its exit). */
  async start(options: StartOptions = {}): Promise<Daemon> {
    const args = ["daemon", ...(options.id === undefined ? [] : ["--id", options.id])];
    const daemon = this.spawn([...args, ...(options.args ?? [])], options);
    this.daemons.push(daemon);
    harness().started.push(daemon);
    const owner: OwnerKey | undefined =
      options.id !== undefined
        ? { id: options.id }
        : options.inbox !== undefined
          ? { pid: Number(/(\d+)\.sock$/.exec(options.inbox)?.[1]), inbox: options.inbox }
          : undefined;
    const banner = `${this.program.source} daemon ${daemon.pid} for `;
    const deadline = Date.now() + 5000;
    while (!this.log(owner).includes(banner) && daemon.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    return daemon;
  }

  async inbox(name: string): Promise<Inbox> {
    const dir = join(this.dir, name);
    mkdirSync(dir);
    const box = await listen(dir, () => this.files());
    this.sessionInbox = box.path;
    this.inboxes.push(box);
    return box;
  }

  /** The daemon's files for an owner; by default this process, the fake inboxes' owner. */
  files(owner: OwnerKey = { pid: process.pid, inbox: this.sessionInbox }): Files {
    return ownerFiles(
      this.dir,
      "id" in owner
        ? { id: owner.id, inbox: null, pid: null, start: null }
        : {
            id: null,
            inbox: owner.inbox,
            pid: owner.pid,
            start: startToken(owner.pid, owner.inbox),
          },
      this.program.source,
    );
  }

  socketPath(owner?: OwnerKey): string {
    return this.files(owner).socket;
  }

  events(
    owner?: OwnerKey,
  ): Array<Record<string, unknown> & { id: number; kind: string; text: string }> {
    return readOr(() => readFileSync(this.files(owner).events, "utf-8"), "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  log(owner?: OwnerKey): string {
    return readOr(() => readFileSync(this.files(owner).log, "utf-8"), "");
  }

  state(owner?: OwnerKey): { targets: Record<string, unknown>; lastEventId: number } {
    return JSON.parse(readFileSync(this.files(owner).state, "utf-8"));
  }

  stop(options: RunOptions & { id?: string } = {}): void {
    const args = ["stop", ...(options.id === undefined ? [] : ["--id", options.id])];
    const result = this.run(args, options);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("daemon stopped");
    const owner: OwnerKey | undefined =
      options.id !== undefined
        ? { id: options.id }
        : options.inbox !== undefined
          ? { pid: process.pid, inbox: options.inbox }
          : undefined;
    expect(existsSync(this.socketPath(owner))).toBe(false);
  }

  /** Every daemon this scenario started is gone: SIGTERM, then SIGKILL for one that ignores it. */
  async cleanup(): Promise<void> {
    for (const daemon of this.daemons.splice(0)) {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
      const exited = await Promise.race([daemon.exited, Bun.sleep(3000).then(() => null)]);
      if (exited === null) {
        daemon.kill("SIGKILL");
        await daemon.exited;
      }
    }
    for (const box of this.inboxes.splice(0)) box.close();
  }
}

export function parseFrame(
  raw: string,
): Record<string, unknown> & { message: { role: string; content: string } } {
  const lines = raw.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0] as string);
}

/** A value as it sits inside a double-quoted envelope attribute. */
export function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function closingLine(name: string): string {
  return `automated notice from ${name}; no reply needed`;
}

/** The digest inside a frame's peer envelope: the envelope names the frame's own sender and its mode. */
export function digest(raw: string, name: string, mode = "bypass"): string {
  const frame = parseFrame(raw);
  const lines = frame.message.content.split("\n");
  expect(frame.from_mode).toBe(mode);
  expect(lines[0]).toBe(
    `<cross-session-message from="${attribute(frame.from as string)}" from-name="${name}" from-mode="${mode}">`,
  );
  expect(lines.at(-1)).toBe("</cross-session-message>");
  return lines.slice(1, -1).join("\n");
}

export function digestHeadlines(frames: string[], name: string): string[] {
  return frames.map((frame) => digest(frame, name).split("\n")[0] as string);
}

/** One test file's harness: its temp dirs and every daemon it started. */
export interface Harness {
  temp: TempDirs;
  scenarios: Scenario[];
  /** Every daemon any test of the file started; the file's end asserts each is gone. */
  started: Daemon[];
}

let current: Harness | null = null;

export function harness(): Harness {
  if (current === null) {
    throw new Error("call sessionEventsHarness() at the test file's top level first");
  }
  return current;
}

export function sessionEventsHarness(): Harness {
  const made: Harness = { temp: tempDirs(), scenarios: [], started: [] };
  current = made;
  afterEach(async () => {
    for (const scenario of made.scenarios.splice(0)) await scenario.cleanup();
  });
  afterAll(() => {
    const alive = made.started
      .filter((daemon) => isProcessAlive(daemon.pid))
      .map((daemon) => daemon.pid);
    expect(alive).toEqual([]);
  });
  return made;
}
