#!/usr/bin/env bun
// The PR source as a command: the daemon with pr-source.mts loaded, so `pr-events.mts watch ...`
// is one command, not two paths.

import { main } from "./daemon.mts";
import source from "./pr-source.mts";

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { source, entry: [import.meta.path] });
}
