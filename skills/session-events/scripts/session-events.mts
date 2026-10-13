#!/usr/bin/env bun
// The daemon as a command over any source: `session-events.mts <source.mts> <command> [options]`.
// The source path comes first so the CLI and the daemon load the same module and so name the same
// socket. A skill that ships a source wraps the two paths in one command (pr-events.mts).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./daemon.mts";

if (import.meta.main) {
  const [path, ...argv] = process.argv.slice(2);
  if (path === undefined) {
    console.error("usage: session-events.mts <source.mts> <command> [options]");
    process.exitCode = 2;
  } else if (!existsSync(resolve(path))) {
    console.error(`${resolve(path)} does not exist; the first argument is a source module`);
    process.exitCode = 2;
  } else {
    const resolved = resolve(path);
    let exported: unknown;
    try {
      ({ default: exported } = (await import(pathToFileURL(resolved).href)) as {
        default?: unknown;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${resolved} cannot be loaded as a source module: ${message}`);
      process.exitCode = 2;
    }
    process.exitCode ??= await main(argv, { exported, entry: [import.meta.path, resolved] });
  }
}
