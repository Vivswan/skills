// The sending side of a Claude Code inbox: one connection per message carrying one JSON line, the
// envelope that names the sender, and the owner's identity. The daemon is a child of the session it
// serves, so its frames are delivered with no permission hold; the peer envelope around the text is
// what names the sender, since a bare frame renders as the owner's own typing.

import { once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
import { finished } from "node:stream/promises";

/** The sending session's permission mode, as the receiver compares it with its own. */
export type Mode = "bypass" | "prompting";

export interface InboxFrame {
  type: "user";
  message: { role: "user"; content: string };
  from: string;
  from_name: string;
  from_mode: Mode;
  msg_id: string;
}

// The proc mount; a test replaces it to give a live pid a start token of its choosing.
const PROC_ROOT = process.env.SESSION_EVENTS_PROC ?? "/proc";

/** A value inside a double-quoted attribute: a runtime directory can carry a quote or a bracket. */
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const CLOSER = "</cross-session-message>";

/**
 * The text in the peer envelope the receiving session renders as a named sender: the envelope
 * with its mode is the one frame shape measured to render so. The text is the source's own words,
 * never quoted from the polled system; an identifier the source relays (a path, a workflow name)
 * that spells the closing tag gets a space before its bracket, so the envelope ends once.
 */
export function envelope(from: string, fromName: string, mode: Mode, text: string): string {
  const body = text.replaceAll(CLOSER, `${CLOSER.slice(0, -1)} >`);
  return `<cross-session-message from="${attribute(from)}" from-name="${attribute(fromName)}" from-mode="${mode}">\n${body}\n${CLOSER}`;
}

// Bounds a connect or flush that never returns; whether the receiver reads the flushed line is its own business.
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

/**
 * The session's start token, part of every file stem the daemon owns: the process start time in
 * clock ticks from /proc, else (macOS) the inode of the inbox socket, which each session creates
 * afresh. A recycled pid therefore opens other files and starts from an empty state.
 */
export function startToken(pid: number, inbox: string): string {
  try {
    const stat = readFileSync(`${PROC_ROOT}/${pid}/stat`, "utf-8");
    // The command name sits in parentheses and may hold spaces; the fields follow the last ")".
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (start !== undefined) return start;
  } catch {
    // No /proc entry: the inbox socket's inode stands in below.
  }
  try {
    return `i${statSync(inbox).ino}`;
  } catch {
    return "0";
  }
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
