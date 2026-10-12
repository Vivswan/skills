// The daemon's durable state: where the runtime directory is, what the subscriptions and last-seen
// rows look like, and the write-ahead log every event is appended to before any delivery.

import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrKey, Row } from "./pr-rows.mts";

export type Sink = "socket" | "file";
export type Mode = "bypass" | "prompting";
export type EventKind = "comment" | "review" | "ci" | "head" | "merged" | "closed" | "trouble";

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

export interface PrSubscription {
  head: string | null;
  expected: string[];
}

export interface CommitSubscription {
  repo: string;
  expected: string[];
}

export interface Subscription {
  sink: Sink;
  /** The inbox socket path for a socket sink, the `--id` for a file sink; the key in `subscriptions`. */
  address: string;
  pid: number | null;
  mode: Mode;
  leaseUntil: string | null;
  prs: Record<PrKey, PrSubscription>;
  commits: Record<string, CommitSubscription>;
}

export interface SavedRow extends Row {
  ciPending: boolean;
  /** Polls in a row on which the expected gate had registered no run; the grace before a trouble event. */
  missingPolls: number;
}

export interface PendingCommit {
  repo: string;
  expected: string[];
  firstSeenAt: string;
  missingPolls: number;
}

export interface Delivery {
  eventId: number;
  at: string;
  outcome: string;
}

export interface State {
  subscriptions: Record<string, Subscription>;
  rows: Record<PrKey, SavedRow>;
  pendingCommits: Record<string, PendingCommit>;
  /** Last delivery per sink address, kept after a prune so `status` can say why a subscriber went. */
  deliveries: Record<string, Delivery>;
  lastEventId: number;
}

export function emptyState(): State {
  return { subscriptions: {}, rows: {}, pendingCommits: {}, deliveries: {}, lastEventId: 0 };
}

export const STATE_FILE = "state.json";
export const EVENTS_FILE = "events.jsonl";
export const CONTROL_SOCKET = "daemon.sock";
export const LOG_FILE = "daemon.log";

export class RuntimeDirError extends Error {}

/**
 * One private directory per user, the ladder Claude Code uses for its own sockets. A candidate that
 * exists but belongs to someone else is skipped, never shared: the socket inside it is an open inbox.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? 0;
  const candidates: string[] = [];
  if (env.PR_EVENTS_DIR) candidates.push(env.PR_EVENTS_DIR);
  if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "pr-events"));
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

export function loadState(dir: string): State {
  let text: string;
  try {
    text = readFileSync(join(dir, STATE_FILE), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...emptyState(), lastEventId: lastLoggedEventId(dir) };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${join(dir, STATE_FILE)} is not JSON; move it aside to start fresh`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${join(dir, STATE_FILE)} is not an object; move it aside to start fresh`);
  }
  const state = { ...emptyState(), ...(parsed as Partial<State>) };
  // The log is appended before the state is saved, so after a crash the log may be ahead of it.
  state.lastEventId = Math.max(state.lastEventId, lastLoggedEventId(dir));
  return state;
}

export function saveState(dir: string, state: State): void {
  const target = join(dir, STATE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** Appends the event to the log and returns its id; the state's counter is the id's owner. */
export function appendEvent(dir: string, state: State, input: EventInput): PrEvent {
  state.lastEventId += 1;
  const event: PrEvent = { id: state.lastEventId, at: new Date().toISOString(), ...input };
  appendFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

/** Every logged event with an id above `sinceId`, oldest first. A line cut short by a crash is skipped. */
export function readEventsSince(dir: string, sinceId: number): PrEvent[] {
  let text: string;
  try {
    text = readFileSync(join(dir, EVENTS_FILE), "utf-8");
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

function lastLoggedEventId(dir: string): number {
  const events = readEventsSince(dir, 0);
  return events.length === 0 ? 0 : (events.at(-1) as PrEvent).id;
}
