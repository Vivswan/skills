#!/usr/bin/env bun
/**
 * Integration test: run the real `npx skills` CLI against this checkout and
 * assert what a consumer would see. Needs network (npx downloads the CLI), so
 * it runs as its own CI job and is not part of `bun run check`.
 *
 * Asserts that every published skill is listed, that they are grouped under
 * the plugin title derived from .claude-plugin/plugin.json, and that the
 * internal template skill stays hidden.
 */

import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { fail, isRecord, loadJson, ROOT, runChecks, skillDirs } from "./lib";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");

function stripAnsi(text: string): string {
  return text.replace(CSI_SEQUENCE, "").replace(OSC_SEQUENCE, "");
}

// Mirrors the CLI's kebabToTitle: capitalize the first letter of each segment.
function kebabToTitle(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function main(): void {
  const manifest = loadJson(join(ROOT, ".claude-plugin", "plugin.json"));
  if (!isRecord(manifest) || typeof manifest.name !== "string") {
    fail(".claude-plugin/plugin.json: missing plugin name");
  }
  const groupTitle = kebabToTitle(manifest.name);
  const expected = skillDirs().map((dir) => basename(dir));

  const proc = spawnSync("npx", ["-y", "skills", "add", ROOT, "--list"], {
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (proc.error) fail(`npx skills failed to launch: ${proc.error.message}`);
  const output = stripAnsi(`${proc.stdout ?? ""}\n${proc.stderr ?? ""}`);
  if (proc.status !== 0) fail(`npx skills exited with ${proc.status}:\n${output}`);

  for (const name of expected) {
    // Boundary match: a listing for `foo-bar` must not satisfy `foo`.
    if (!new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`).test(output)) {
      fail(`skill '${name}' missing from CLI listing:\n${output}`);
    }
  }
  if (!output.includes(groupTitle)) {
    fail(`plugin group heading '${groupTitle}' missing from CLI listing:\n${output}`);
  }
  if (output.includes("template-skill")) {
    fail(`internal template skill leaked into the CLI listing:\n${output}`);
  }

  console.log(`CLI discovery test passed (${expected.length} skill(s) under '${groupTitle}').`);
}

runChecks(main);
