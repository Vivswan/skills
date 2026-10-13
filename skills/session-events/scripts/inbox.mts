// The sending side of a Claude Code inbox: one connection per message carrying one JSON line, the
// pid a session's inbox is named by, and the text a poll's events become. The daemon is a child of
// the session it serves, so its frames are delivered with no permission hold; the peer envelope
// around the text is what names the sender, since a bare frame renders as the owner's own typing.

import { once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
import { finished } from "node:stream/promises";
import type { Event, Source } from "./source.mts";

/** What a digest needs of its source: the sender's name, its fence, and how an event's subject reads. */
export type Voice = Pick<Source<unknown, unknown>, "name" | "quoted" | "subjectOf">;

export interface InboxFrame {
  type: "user";
  message: { role: "user"; content: string };
  from: string;
  from_name: string;
  msg_id: string;
}

// The proc mount; a test replaces it to give a live pid another start token, which nothing else can.
const PROC_ROOT = process.env.SESSION_EVENTS_PROC ?? "/proc";

const ENVELOPE_END = "</cross-session-message>";

export function closingLine(voice: Voice): string {
  return `automated notice from ${voice.name}; no reply needed`;
}

/**
 * A value inside a double-quoted attribute: a runtime directory can carry a quote, a bracket, or a
 * line break, and the opening tag must stay one line.
 */
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

/**
 * The text in the peer envelope the receiving session renders with the sender's name; `from` is
 * the frame's own. A closing tag inside the text (a quoted comment can carry one) is escaped, so
 * the envelope ends where the text does.
 */
export function envelope(from: string, fromName: string, text: string): string {
  const body = text.replaceAll(ENVELOPE_END, "<\\/cross-session-message>");
  return `<cross-session-message from="${attribute(from)}" from-name="${fromName}">\n${body}\n${ENVELOPE_END}`;
}

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

/**
 * The process's start time in clock ticks since boot, from /proc; with the pid it names one
 * incarnation, since pids are reused. Null where /proc is absent (macOS), and the pid stands alone.
 */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`${PROC_ROOT}/${pid}/stat`, "utf-8");
    // The command name sits in parentheses and may hold spaces; the fields follow the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * The owner's start token where /proc has none (macOS): its inbox socket file, which each session
 * creates afresh, so a recycled pid comes with another inode or birth time. Null once the file is
 * gone.
 *
 * Without a birth time, the inode's change time stands in. Nothing touches the socket's metadata
 * while a session lives. A token that did change sets the targets aside with a log line; a reused
 * inode alone would hand them to a stranger in silence.
 */
export function inboxToken(socketPath: string): string | null {
  try {
    const stat = statSync(socketPath);
    return `${stat.ino}:${stat.birthtimeMs || stat.ctimeMs}`;
  } catch {
    return null;
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

export function renderEvent(voice: Voice, event: Event): string {
  const lines = [`${voice.subjectOf(event) ?? voice.name}: ${event.text}`];
  if (event.url) lines.push(event.url);
  return lines.join("\n");
}

function opensFence(label: string, line: string): boolean {
  return line.endsWith(label) && /^ {2}`{3,}$/.test(line.slice(0, -label.length));
}

/**
 * One poll's events as one message: the receiver drops a second frame from the same sender within
 * the same second, so a poll never sends two. Events are separated by a blank line, each keeping
 * its own text and URL, and the closing line comes once.
 *
 * Quoted text (a comment body, a failed build's log) reaches the owner's session as user-role
 * text, the same channel the owner types in, and the inbox format has no data channel. The
 * boundary is in the text: the quoted lines sit in the source's fence, and a message with a fence
 * in it opens with the source's boundary sentence, once.
 */
export function renderDigest(voice: Voice, events: Event[]): string {
  let boundary = "";
  if (voice.quoted) {
    const { label } = voice.quoted;
    const fenced = events.some((event) =>
      event.text.split("\n").some((line) => opensFence(label, line)),
    );
    if (fenced) boundary = `${voice.quoted.boundary}\n\n`;
  }
  const rendered = events.map((event) => renderEvent(voice, event));
  return `${boundary}${rendered.join("\n\n")}\n${closingLine(voice)}`;
}
