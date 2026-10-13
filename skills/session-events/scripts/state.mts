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
import type { Event, EventInput } from "./source.mts";

export interface Delivery {
  eventIds: number[];
  at: string;
  /** The frame's msg_id; the receiver's status report names it. */
  msgId: string;
  /** `sending` (saved before the frame goes out), `sent`, `failed: <code>`, or the state the receiver reported back: held, released, denied, expired, refused, dropped. */
  outcome: string;
}

/** One incarnation of the owning session: its pid and that process's start token. */
export interface OwnerIncarnation {
  pid: number;
  start: string;
}

export interface State<Saved = unknown> {
  /** The session the saved targets belong to; a recycled pid with another start token is a stranger. */
  owner: OwnerIncarnation | null;
  /** The last delivery to the owner's inbox, so `status` can show how it went. */
  delivery: Delivery | null;
  lastEventId: number;
  /** The newest poll's events, saved before they are appended to the log; a restart appends the ones the log lacks. */
  lastPoll: Event[];
  /** The source's own: its targets and what it saw of them. */
  saved: Saved;
}

function emptyState(): State<unknown> {
  return { owner: null, delivery: null, lastEventId: 0, lastPoll: [], saved: undefined };
}

/**
 * The daemon's one owner: the Claude Code session whose inbox it delivers to and whose pid ends it,
 * or a named file-sink reader (a non-Claude agent) that reads the log with `wait`.
 */
export interface Owner {
  /** The session pid, or the `--id` name: the stem of every file the daemon owns. */
  key: string;
  inbox: string | null;
  pid: number | null;
}

export const SOCKET_SUFFIX = ".sock";
export const EVENTS_SUFFIX = ".events.jsonl";
export const STATE_SUFFIX = ".state.json";
export const LOG_SUFFIX = ".log";

export interface OwnerFiles {
  socket: string;
  events: string;
  state: string;
  log: string;
}

/** `<dir>/<owner key>.<source name>.<suffix>`: two sources of one session never share a socket. */
export function ownerFiles(dir: string, owner: Owner, sourceName: string): OwnerFiles {
  const stem = join(dir, `${owner.key}.${sourceName}`);
  return {
    socket: `${stem}${SOCKET_SUFFIX}`,
    events: `${stem}${EVENTS_SUFFIX}`,
    state: `${stem}${STATE_SUFFIX}`,
    log: `${stem}${LOG_SUFFIX}`,
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
    if (!isAbsolute(env.SESSION_EVENTS_DIR)) {
      throw new RuntimeDirError(
        `SESSION_EVENTS_DIR must be an absolute path, got: ${env.SESSION_EVENTS_DIR}`,
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

export interface LoadedState<Saved> {
  state: State<Saved>;
  /** The saved poll's events the log lacks: the daemon died between saving the state and appending them. */
  unlogged: Event[];
  /** When the newest event was written, the unlogged ones included. */
  newestEventAt: string | null;
  /** The earlier session whose saved targets were set aside, when the pid was recycled. */
  staleOwner: OwnerIncarnation | null;
  /** Where that session's events log went, when it had one. */
  movedEvents: string | null;
}

/**
 * An earlier session's state and events files, renamed with a tag before the last extension:
 * `<pid>.events.<tag>.jsonl`. The events path, or null when it had no log. The events go first: a
 * crash between the two leaves the old state, seen stale again at the next start, beside no
 * events; the other order left a fresh start beside the old events, which it would have served.
 */
function setAside(files: OwnerFiles, tag: string): string | null {
  const move = (path: string): string | null => {
    const target = path.replace(/(\.[^.]+)$/, `.${tag}$1`);
    try {
      renameSync(path, target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const events = move(files.events);
  move(files.state);
  return events;
}

function tagOf(start: string): string {
  return start.replace(/[^A-Za-z0-9.]+/g, "-");
}

function readSavedState(files: OwnerFiles): State<unknown> | null {
  let text: string;
  try {
    text = readFileSync(files.state, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${files.state} is not JSON; move it aside to start fresh`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${files.state} is not an object; move it aside to start fresh`);
  }
  return { ...emptyState(), ...(parsed as Partial<State<unknown>>) };
}

/**
 * The state is the source of the log: an id is never reused, so the counter also clears any line
 * a log left by an earlier daemon carries past the saved state. `restore` is the source's: it gets
 * its saved part as the last daemon left it (undefined on a fresh start) and the log lines past the
 * saved counter, the other crash: a verdict appended, the daemon gone before the state that drops
 * its target was saved.
 */
export function loadState<Saved, Input extends EventInput>(
  files: OwnerFiles,
  incarnation: OwnerIncarnation | null,
  restore: (raw: unknown, logAhead: Event<Input>[]) => Saved,
): LoadedState<Saved> {
  const saved = readSavedState(files);
  let state = saved ?? emptyState();
  let staleOwner: OwnerIncarnation | null = null;
  let movedEvents: string | null = null;
  // A pid comes back around: targets saved by an earlier session that happened to have this pid
  // are not this session's, and neither are its events. Both files are set aside under its start
  // token, and this session's counter starts at zero: its readers are new too.
  if (
    incarnation &&
    state.owner &&
    (state.owner.pid !== incarnation.pid || state.owner.start !== incarnation.start)
  ) {
    staleOwner = state.owner;
    movedEvents = setAside(files, tagOf(staleOwner.start));
    state = emptyState();
  } else if (saved === null && readEventsSince(files, 0).length > 0) {
    // The state is saved before its events are appended, so a log beside no state is not this
    // daemon's: an earlier session's, left by a half-done rollover or a state file removed by hand.
    movedEvents = setAside(files, `unknown-${Date.now()}`);
  }
  if (incarnation) state.owner = incarnation;
  const log = readEventsSince(files, 0);
  const logged = log.at(-1);
  const unlogged = state.lastPoll.filter((event) => event.id > (logged?.id ?? 0));
  // The log's lines are the source's own: it wrote them, so it reads them back in its shape.
  const logAhead = log.filter((event) => event.id > state.lastEventId) as Event<Input>[];
  const restored: State<Saved> = { ...state, saved: restore(state.saved, logAhead) };
  const newest = unlogged.at(-1) ?? logged;
  restored.lastEventId = Math.max(restored.lastEventId, newest?.id ?? 0);
  return { state: restored, unlogged, newestEventAt: newest?.at ?? null, staleOwner, movedEvents };
}

export function saveState(files: OwnerFiles, state: State<unknown>): void {
  const tmp = `${files.state}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, files.state);
}

/** The next event, numbered by the state's counter; `appendEvents` puts it in the log. */
export function nextEvent(state: State<unknown>, input: EventInput): Event {
  state.lastEventId += 1;
  return { id: state.lastEventId, at: new Date().toISOString(), ...input };
}

export function appendEvents(files: OwnerFiles, events: Event[]): void {
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
export function readEventsSince(files: OwnerFiles, sinceId: number): Event[] {
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
