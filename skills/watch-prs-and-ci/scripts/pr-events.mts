#!/usr/bin/env bun
// The PR source as a command: the session-events daemon with pr-source.mts loaded, so
// `pr-events.mts watch ...` is one command, not two paths. The daemon is the session-events
// skill's, installed beside this one; `npx skills add --skill` copies one folder, so a single-skill
// install is told what else to add. SESSION_EVENTS_HOME names the folder for any other layout.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import prSource from "./pr-source.mts";

const INSTALL = "npx skills add Vivswan/skills -g --skill session-events";
const home = resolve(
  process.env.SESSION_EVENTS_HOME ?? join(import.meta.dir, "..", "..", "session-events"),
);
const daemon = join(home, "scripts", "daemon.mts");

if (import.meta.main) {
  if (!existsSync(daemon)) {
    console.error(
      `the session-events skill is not installed beside this one (${daemon} is missing); install it beside this skill: ${INSTALL}`,
    );
    process.exitCode = 2;
  } else {
    // The daemon reads SESSION_EVENTS_DIR; this skill's earlier name for it still works, with notice.
    if (process.env.SESSION_EVENTS_DIR === undefined && process.env.PR_EVENTS_DIR !== undefined) {
      process.env.SESSION_EVENTS_DIR = process.env.PR_EVENTS_DIR;
      console.error("PR_EVENTS_DIR is deprecated; set SESSION_EVENTS_DIR");
    }
    const { main } = (await import(
      pathToFileURL(daemon).href
    )) as typeof import("../../session-events/scripts/daemon.mts");
    process.exitCode = await main(process.argv.slice(2), {
      exported: prSource,
      entry: [import.meta.path],
    });
  }
}
