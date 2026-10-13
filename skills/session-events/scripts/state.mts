// The daemon's files: one private runtime directory per user, and in it the control socket, the
// events log, the saved state, and the daemon's own log, each named by the owner and the source.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** One line of the events log: `id` and `at` first, then the source's fields in its order. */
export type Event = { id: number; at: string; kind: string; text: string; url: string } & Record<
  string,
  unknown
>;

/** Everything the daemon keeps between polls: the targets, each carrying its source's cursor, and the counter. */
export interface State<Target> {
  targets: Record<string, Target>;
  lastEventId: number;
}

/**
 * The daemon's one owner: the Claude Code session whose inbox it delivers to and whose pid ends
 * it, or a named file sink (`--id`) a non-Claude agent reads with `wait`, ended by `--pid` or `stop`.
 */
export interface Owner {
  id: string | null;
  inbox: string | null;
  pid: number | null;
  /** The session's start token: with the pid it names one session, since pids are reused. */
  start: string | null;
}

export interface Files {
  socket: string;
  events: string;
  state: string;
  log: string;
}

/**
 * `<pid>-<start>.<source>.{state.json,events.jsonl,log}` and `<pid>.<source>.sock` for a session;
 * `<id>.<source>.*` for a file sink. The start token in the stem is what keeps a recycled pid from
 * inheriting an earlier session's targets: it opens other files and finds them empty.
 */
export function ownerFiles(dir: string, owner: Owner, source: string): Files {
  const key = owner.id ?? String(owner.pid);
  const stem = join(dir, `${owner.id ?? `${owner.pid}-${owner.start}`}.${source}`);
  return {
    socket: join(dir, `${key}.${source}.sock`),
    events: `${stem}.events.jsonl`,
    state: `${stem}.state.json`,
    log: `${stem}.log`,
  };
}

export class RuntimeDirError extends Error {}

/**
 * One private directory per user, the ladder Claude Code uses for its own sockets. A candidate that
 * exists but belongs to someone else is skipped, never shared: the sockets inside it are open inboxes.
 * The override must be absolute: the daemon and the CLI are started from different directories,
 * and a relative one would name two sockets.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? 0;
  const candidates: string[] = [];
  if (env.SESSION_EVENTS_DIR) {
    if (!isAbsolute(env.SESSION_EVENTS_DIR) || /[\r\n]/.test(env.SESSION_EVENTS_DIR)) {
      throw new RuntimeDirError(
        `SESSION_EVENTS_DIR must be an absolute path on one line, got: ${JSON.stringify(env.SESSION_EVENTS_DIR)}`,
      );
    }
    candidates.push(env.SESSION_EVENTS_DIR);
  }
  if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "session-events"));
  // Claude Code's own temp root, which os.tmpdir() does not read.
  if (env.CLAUDE_CODE_TMPDIR) {
    candidates.push(join(env.CLAUDE_CODE_TMPDIR, `session-events-${uid}`));
  }
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
      refused.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new RuntimeDirError(
    `no usable runtime directory; set SESSION_EVENTS_DIR to a private directory\n  ${refused.join("\n  ")}`,
  );
}

/** An empty targets map. No prototype: a target typed as `__proto__` is a key like any other, not a setter. */
export function noTargets<Target>(): Record<string, Target> {
  return Object.create(null) as Record<string, Target>;
}

/** The saved state, or an empty one on a fresh start. A file that is not a state object is refused by path. */
export function loadState<Target>(files: Files): State<Target> {
  let text: string;
  try {
    text = readFileSync(files.state, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { targets: noTargets(), lastEventId: 0 };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${files.state} is not JSON; move it aside to start fresh`);
  }
  const state = parsed as Partial<State<Target>> | null;
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error(`${files.state} is not an object; move it aside to start fresh`);
  }
  return {
    targets: Object.assign(noTargets<Target>(), state.targets),
    lastEventId: state.lastEventId ?? 0,
  };
}

export function saveState(files: Files, state: State<unknown>): void {
  const tmp = `${files.state}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, files.state);
}

export function appendEvents(files: Files, events: Event[]): void {
  if (events.length === 0) return;
  // A crash mid-append leaves a line without its newline; the next line must not glue onto it.
  const prefix = endsWithoutNewline(files.events) ? "\n" : "";
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  appendFileSync(files.events, `${prefix}${lines}`, { mode: 0o600 });
}

function endsWithoutNewline(path: string): boolean {
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size === 0) return false;
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Every logged event with an id above `sinceId`, oldest first. A line cut short by a crash is skipped. */
export function readEventsSince(files: Files, sinceId: number): Event[] {
  let text: string;
  try {
    text = readFileSync(files.events, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Event).id === "number") {
      const event = parsed as Event;
      if (event.id > sinceId) events.push(event);
    }
  }
  return events;
}
