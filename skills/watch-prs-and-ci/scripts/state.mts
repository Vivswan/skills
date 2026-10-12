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
import type { PrKey, Row } from "./pr-rows.mts";

export type EventKind = "comment" | "review" | "ci" | "head" | "merged" | "closed" | "trouble";

/** One line of the write-ahead log; every line is addressed to the daemon's one owner. */
export interface PrEvent {
  id: number;
  at: string;
  repo: string;
  pr: number | null;
  sha: string | null;
  kind: EventKind;
  text: string;
  url: string;
}

export type EventInput = Omit<PrEvent, "id" | "at">;

/** What the owner asked for on a PR: the head they pushed, and the complete gate set. */
export interface PrWatch {
  head: string | null;
  expected: string[];
}

/** `${repo}@${sha}`: a fork shares its commits' shas with the upstream repository. */
export type CommitKey = string;

export function commitKey(repo: string, sha: string): CommitKey {
  return `${repo}@${sha}`;
}

/**
 * What a head still being judged carries between full polls: the polls in a row on which no run had
 * registered (the grace before a trouble event), and the workflow ids the last poll saw (a green
 * with no gate named is terminal only once two polls agree on that set). The read a `watch`
 * triggers leaves both alone.
 */
export interface Grace {
  missingPolls: number;
  registered: string[];
}

export function freshGrace(): Grace {
  return { missingPolls: 0, registered: [] };
}

export interface CommitWatch {
  repo: string;
  sha: string;
  expected: string[];
  firstSeenAt: string;
  grace: Grace;
}

export type RowCi = { pending: true; grace: Grace } | { pending: false };

export interface SavedRow extends Row {
  ci: RowCi;
  /** The activity ids the last two detail reads returned, oldest read first; what is in neither is news. */
  seenActivity: string[][];
  /** Polls spent on a merged row whose merge commit GitHub has not reported yet. */
  mergeCommitPolls: number;
}

export interface Delivery {
  eventIds: number[];
  at: string;
  /** The frame's msg_id; the receiver's status report names it. */
  msgId: string;
  /** `sending` (saved before the frame goes out), `sent`, `failed: <code>`, or the state the receiver reported back: held, released, denied, expired, refused, dropped. */
  outcome: string;
}

export interface State {
  prs: Record<PrKey, PrWatch>;
  commits: Record<CommitKey, CommitWatch>;
  rows: Record<PrKey, SavedRow>;
  /** The last delivery to the owner's inbox, so `status` can show how it went. */
  delivery: Delivery | null;
  lastEventId: number;
  /** The newest poll's events, saved before they are appended to the log; a restart appends the ones the log lacks. */
  lastPoll: PrEvent[];
}

export function emptyState(): State {
  return { prs: {}, commits: {}, rows: {}, delivery: null, lastEventId: 0, lastPoll: [] };
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

export function ownerFiles(dir: string, owner: Owner): OwnerFiles {
  const stem = join(dir, owner.key);
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
  if (env.PR_EVENTS_DIR) {
    if (!isAbsolute(env.PR_EVENTS_DIR)) {
      throw new RuntimeDirError(
        `PR_EVENTS_DIR must be an absolute path, got: ${env.PR_EVENTS_DIR}`,
      );
    }
    candidates.push(env.PR_EVENTS_DIR);
  }
  if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "pr-events"));
  // Claude Code's own temp root, which os.tmpdir() does not read.
  if (env.CLAUDE_CODE_TMPDIR) candidates.push(join(env.CLAUDE_CODE_TMPDIR, `pr-events-${uid}`));
  candidates.push(join(tmpdir(), `pr-events-${uid}`), `/tmp/pr-events-${uid}`);
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
    `no usable runtime directory; set PR_EVENTS_DIR to a private directory\n  ${refused.join("\n  ")}`,
  );
}

export interface LoadedState {
  state: State;
  /** The saved poll's events the log lacks: the daemon died between saving the state and appending them. */
  unlogged: PrEvent[];
  /** When the newest event was written, the unlogged ones included. */
  newestEventAt: string | null;
}

function readSavedState(files: OwnerFiles): State | null {
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
  return { ...emptyState(), ...(parsed as Partial<State>) };
}

// The state is the source of the log: an id is never reused, so the counter also clears any line
// a log left by an earlier daemon carries past the saved state.
export function loadState(files: OwnerFiles): LoadedState {
  const state = readSavedState(files) ?? emptyState();
  const logged = readEventsSince(files, 0).at(-1);
  const unlogged = state.lastPoll.filter((event) => event.id > (logged?.id ?? 0));
  const newest = unlogged.at(-1) ?? logged;
  state.lastEventId = Math.max(state.lastEventId, newest?.id ?? 0);
  return { state, unlogged, newestEventAt: newest?.at ?? null };
}

export function saveState(files: OwnerFiles, state: State): void {
  const tmp = `${files.state}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, files.state);
}

/** The next event, numbered by the state's counter; `appendEvents` puts it in the log. */
export function nextEvent(state: State, input: EventInput): PrEvent {
  state.lastEventId += 1;
  return { id: state.lastEventId, at: new Date().toISOString(), ...input };
}

export function appendEvents(files: OwnerFiles, events: PrEvent[]): void {
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
export function readEventsSince(files: OwnerFiles, sinceId: number): PrEvent[] {
  let text: string;
  try {
    text = readFileSync(files.events, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: PrEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PrEvent).id === "number"
    ) {
      const event = parsed as PrEvent;
      if (event.id > sinceId) events.push(event);
    }
  }
  return events;
}
