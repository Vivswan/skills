// The sweep's transcript sensor: the last event's type and the file's age, read from the tail of
// each agent-*.jsonl in a directory without ever walking the whole file.

import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_MAX_BYTES = 8 * 1024 * 1024;

export function readTail(fd: number, sizeBytes: number, windowBytes: number): string {
  const start = Math.max(0, sizeBytes - windowBytes);
  const buffer = Buffer.alloc(sizeBytes - start);
  const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
  return buffer.toString("utf8", 0, bytesRead);
}

type LastEvent = { found: true; type: string | null } | { found: false };

/**
 * The final line's "type", falling back line-by-line toward the front of the
 * tail so a mid-write truncated last line reads as the previous event rather
 * than as a parse failure. found:false means no line in the tail parsed at
 * all (e.g. one truncated line larger than the whole window).
 */
export function lastEventInTail(tail: string): LastEvent {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event === "object" && event !== null) {
        const type = (event as Record<string, unknown>).type;
        return { found: true, type: typeof type === "string" ? type : null };
      }
    } catch {
      // truncated or malformed line: keep walking back
    }
  }
  return { found: false };
}

/**
 * Widen the tail window until some line parses, so a single truncated event
 * larger than the base window cannot quietly erase the previous event. The
 * window is still capped: a transcript with megabytes of unparsable tail
 * honestly reads null rather than turning the sweep O(file).
 */
export function lastEventType(fd: number, sizeBytes: number): string | null {
  let window = TRANSCRIPT_TAIL_BYTES;
  for (;;) {
    const result = lastEventInTail(readTail(fd, sizeBytes, window));
    if (result.found) return result.type;
    if (window >= sizeBytes || window >= TRANSCRIPT_TAIL_MAX_BYTES) return null;
    window = Math.min(window * 4, TRANSCRIPT_TAIL_MAX_BYTES);
  }
}

export function transcriptReport(dir: string): unknown {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return { transcripts: { ok: false, error: `cannot read ${dir}: ${String(error)}` } };
  }
  const agents = [];
  for (const name of names.sort()) {
    const match = name.match(/^agent-(.+)\.jsonl$/);
    if (!match) continue;
    const path = join(dir, name);
    // A FIFO (or device) named like a transcript would hang the synchronous
    // tail read forever. The check is on the HANDLE, not the path: an
    // isFile-then-open pair could still open a FIFO swapped in between the
    // two calls. O_NONBLOCK makes even that open non-blocking (and is a
    // no-op for regular files); fstat on the fd then decides.
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        agents.push({ agent: match[1], ok: false, error: "not a regular file" });
        continue;
      }
      agents.push({
        agent: match[1],
        mtime: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        // Age from file mtime: JSONL events are not guaranteed to carry
        // timestamps, and mtime moves on every appended event.
        lastEventAgeSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)),
        lastEventType: lastEventType(fd, stat.size),
      });
    } catch (error) {
      agents.push({ agent: match[1], ok: false, error: String(error) });
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return { transcripts: { ok: true, dir, agents } };
}
