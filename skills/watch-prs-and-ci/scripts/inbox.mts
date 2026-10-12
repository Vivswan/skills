// The sending side of a Claude Code inbox: one connection per message carrying one JSON line, the
// pid a session's inbox is named by, and the text a poll's events become. The daemon is a child of
// the session it serves, so its frames render as plain text with no envelope and no permission hold.

import { once } from "node:events";
import { connect } from "node:net";
import { basename } from "node:path";
import { finished } from "node:stream/promises";
import type { PrEvent } from "./state.mts";

export interface InboxFrame {
  type: "user";
  message: { role: "user"; content: string };
  from: string;
  from_name: string;
  msg_id: string;
}

export const FROM_NAME = "pr-events";
export const CLOSING_LINE = "automated notice from pr-events; no reply needed";

// A delivery is complete once the line is flushed and the write side closed; whether the receiver
// reads it is its own business, and its status report, if any, goes to the `from` socket. The
// timeout only bounds a connect or flush that never returns.
const DELIVER_TIMEOUT_MS = 5_000;

export async function deliver(socketPath: string, frame: InboxFrame): Promise<void> {
  const socket = connect(socketPath);
  const signal = AbortSignal.timeout(DELIVER_TIMEOUT_MS);
  try {
    await once(socket, "connect", { signal });
    socket.end(`${JSON.stringify(frame)}\n`);
    await finished(socket, { readable: false, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw Object.assign(new Error(`no answer from ${socketPath}`), { code: "ETIMEDOUT" });
    }
    throw error;
  } finally {
    socket.destroy();
  }
}

/** A Claude Code inbox is `<pid>.sock`, named by the session that listens on it. */
export function pidOf(socketPath: string): number | null {
  const match = /^(\d+)\.sock$/.exec(basename(socketPath));
  return match ? Number(match[1]) : null;
}

/** A signal 0 answered with EPERM is a process that exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function renderEvent(event: PrEvent): string {
  const subject =
    event.pr !== null
      ? `PR ${event.repo}#${event.pr}`
      : event.sha !== null
        ? `commit ${event.repo}@${event.sha.slice(0, 12)}`
        : "pr-events";
  const lines = [`${subject}: ${event.text}`];
  if (event.url !== "") lines.push(event.url);
  return lines.join("\n");
}

/**
 * One poll's events as one message: the receiver drops a second frame from the same sender within
 * the same second, so a poll never sends two. Events are separated by a blank line, each keeping
 * its own text and URL, and the closing line comes once.
 */
export function renderDigest(events: PrEvent[]): string {
  return `${events.map(renderEvent).join("\n\n")}\n${CLOSING_LINE}`;
}
