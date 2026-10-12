// The subscriber side of a Claude Code inbox: one connection per message carrying one JSON line,
// the liveness rule for a socket named by its session's pid, and the text an event becomes.

import { once } from "node:events";
import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
import { finished } from "node:stream/promises";
import type { Mode, PrEvent } from "./state.mts";

export interface InboxFrame {
  type: "user";
  message: { role: "user"; content: string };
  from: string;
  from_name: string;
  from_mode: Mode;
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

/**
 * A Claude Code inbox is live when the pid in its file name answers a signal 0 (EPERM counts: the
 * process exists) and the path is still a socket. Stale socket files are the norm, so the pid check
 * is what prunes.
 */
export function isLiveSubscriber(
  socketPath: string,
  pid: number | null = pidOf(socketPath),
): boolean {
  if (pid !== null && !isProcessAlive(pid)) return false;
  try {
    return lstatSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

export function pidOf(socketPath: string): number | null {
  const match = /^(\d+)\.sock$/.exec(basename(socketPath));
  return match ? Number(match[1]) : null;
}

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
  lines.push(CLOSING_LINE);
  return lines.join("\n");
}
