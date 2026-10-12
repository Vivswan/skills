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

/** The kinds a PR subscription can narrow to; `trouble` is tooling news and always comes. */
export type SubscribedKind = Exclude<EventKind, "trouble">;
export const ALL_SUBSCRIBED: readonly SubscribedKind[] = [
  "comment",
  "review",
  "ci",
  "head",
  "merged",
  "closed",
];

export function isSubscribedKind(value: string): value is SubscribedKind {
  return (ALL_SUBSCRIBED as readonly string[]).includes(value);
}

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
  /** On a `ci` line: the GitHub Actions runs the verdict rests on, `id:status:conclusion:updatedAt` sorted and comma-joined. */
  runs?: string;
}

export type EventInput = Omit<PrEvent, "id" | "at">;

/** What the owner asked for on a PR: the head they pushed, the complete gate set, and the kinds they hear about, sorted. */
export interface PrWatch {
  head: string | null;
  expected: string[];
  events: SubscribedKind[];
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

/** What a settled verdict said, so a rollup that only catches up with it is told from a new result. */
export type CiOutcome = "green" | "red";

/**
 * A settled judgment: what it said, and a fingerprint of the GitHub Actions runs it judged (id,
 * status, conclusion, last change), so a later re-judgment that sees the same runs says nothing new. A head
 * being judged again after a verdict (a rollup move) carries that verdict's runs as `priorRuns`
 * for as many polls as the re-judgment stays pending; null when nothing was delivered on the head.
 */
export type RowCi =
  | { pending: true; grace: Grace; priorRuns: string | null }
  | { pending: false; outcome: CiOutcome; runs: string };

export function pendingCi(priorRuns: string | null = null): RowCi {
  return { pending: true, grace: freshGrace(), priorRuns };
}

export function outcomeOfVerdict(text: string): CiOutcome {
  return text.startsWith("CI green") ? "green" : "red";
}

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

/** One incarnation of the owning session: its pid and that process's start token. */
export interface OwnerIncarnation {
  pid: number;
  start: string;
}

export interface State {
  /** The session the saved targets belong to; a recycled pid with another start token is a stranger. */
  owner: OwnerIncarnation | null;
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
  return {
    owner: null,
    prs: {},
    commits: {},
    rows: {},
    delivery: null,
    lastEventId: 0,
    lastPoll: [],
  };
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
  const state = { ...emptyState(), ...(parsed as Partial<State>) };
  // A subscription saved before kinds could be narrowed hears everything, as it did then.
  for (const watch of Object.values(state.prs) as Array<Partial<PrWatch>>) {
    watch.events ??= [...ALL_SUBSCRIBED].sort();
  }
  return state;
}

// The state is the source of the log: an id is never reused, so the counter also clears any line
// a log left by an earlier daemon carries past the saved state.
export function loadState(
  files: OwnerFiles,
  incarnation: OwnerIncarnation | null = null,
): LoadedState {
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
  // The log ahead of the state is the other crash: a verdict appended, the daemon gone before the
  // state that drops its target was saved. The log carries the verdict, so the target is settled.
  // A line names its one target: a commit watch (no pr) or a PR; another watch on the same sha
  // may require other gates, so it keeps its own judgment.
  for (const event of log) {
    if (event.id <= state.lastEventId || event.kind !== "ci" || event.sha === null) continue;
    if (event.pr === null) {
      delete state.commits[commitKey(event.repo, event.sha)];
      continue;
    }
    const row = state.rows[`${event.repo}#${event.pr}`];
    if (row && row.headRefOid === event.sha && row.ci.pending) {
      row.ci = { pending: false, outcome: outcomeOfVerdict(event.text), runs: event.runs ?? "" };
    }
  }
  const newest = unlogged.at(-1) ?? logged;
  state.lastEventId = Math.max(state.lastEventId, newest?.id ?? 0);
  return { state, unlogged, newestEventAt: newest?.at ?? null, staleOwner, movedEvents };
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
