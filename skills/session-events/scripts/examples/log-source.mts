#!/usr/bin/env bun
// The worked example of a source: an event when a watched file changes size or disappears. The
// daemon does the rest: the socket, the delivery, the log, the saved state, the schedule.
//
//   bun "<skill-dir>/scripts/examples/log-source.mts" daemon --interval 5    # once per session, as a BACKGROUND task
//   bun "<skill-dir>/scripts/examples/log-source.mts" watch /var/log/build.log

import { statSync } from "node:fs";
import { runEvents, UsageError } from "../session-events.mts";

/** The cursor: the size at the last poll, null before the file has been seen or while it is gone. */
type File = { path: string; size: number | null };

runEvents<File>({
  name: "log-events",
  interval: 5,
  parseTarget([path]) {
    if (path === undefined || !path.startsWith("/"))
      throw new UsageError("watch needs an absolute path");
    return { path, size: null };
  },
  async poll(targets) {
    const events = [];
    for (const file of Object.values(targets)) {
      const size = statSync(file.path, { throwIfNoEntry: false })?.size ?? null;
      const url = `file://${file.path}`;
      if (size === null && file.size !== null) {
        events.push({ kind: "gone", text: `${file.path}: gone`, url });
      } else if (size !== null && file.size !== null && size !== file.size) {
        events.push({ kind: "changed", text: `${file.path}: ${file.size} to ${size} bytes`, url });
      }
      file.size = size;
    }
    return { events, busy: events.length > 0 };
  },
});
