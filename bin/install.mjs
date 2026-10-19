#!/usr/bin/env node
// One-command install of this catalog and its upstream skills through the skills CLI.
//   npx -y github:Vivswan/skills [flags]    runs `npx -y skills add <target> [flags]` for this repository, then
//                                           once per upstream skill of .claude-plugin/marketplace.json
//   npx -y github:Vivswan/skills --help     prints those commands and runs nothing
// Flags pass through unchanged, plus `-y` unless they say yes (the CLI's overwrite prompt would stop an
// unattended run) and `-a universal` unless the agents cover it (install-shared.mjs). A failed call does not
// stop the next: the run ends with the failures summarized on stderr, exit 1. Only a launcher that cannot start
// (no npx) ends it at once, since every call would fail the same way.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CatalogError,
  callFlags,
  copiesBefore,
  failureSummary,
  flagValues,
  installedSkillsDir,
  markWrittenCopies,
  repoCoordinate,
  runCall,
  upstreamSkills,
} from "./install-shared.mjs";

const BY_HAND = "run this through npx (npx -y github:Vivswan/skills), which gives it npm's path";

/** One stderr line and exit 1; a line break inside the message (JSON.parse's source quote, a catalog value) folds. */
function fail(message) {
  console.error(`install: ${message.replace(/\s*\n\s*/g, " ")}`);
  process.exit(1);
}

/**
 * The skill names the flags select (`-s` or `--skill`, repeatable), lowercased as the CLI compares them; `*` or
 * `--all` means every skill. Undefined when nothing is selected or every skill is, so the caller runs every call.
 */
function selectedSkills(flags) {
  const names = flagValues(flags, ["-s", "--skill"]);
  if (flags.includes("--all") || names.includes("*") || names.length === 0) return undefined;
  return new Set(names.map((name) => name.toLowerCase()));
}

/**
 * The `skills add` targets: this repository, then each upstream skill's folder as <owner/repo>/<path>. With a
 * selection, only the sources that ship a selected name: an upstream when its entry name is selected, this
 * repository when any other name is.
 */
function targets(selected, coordinate, upstream) {
  if (selected === undefined) return [coordinate, ...upstream.map(({ target }) => target)];

  const upstreamNames = new Set(upstream.map(({ name }) => name));
  const wanted = upstream.filter(({ name }) => selected.has(name)).map(({ target }) => target);
  const ownNamed = [...selected].some((name) => !upstreamNames.has(name));
  return ownNamed ? [coordinate, ...wanted] : wanted;
}

/** The catalog, or the catalog failure as the one stderr line. */
function catalogOrFail() {
  try {
    return { coordinate: repoCoordinate(), upstream: upstreamSkills() };
  } catch (error) {
    if (error instanceof CatalogError) fail(error.message);
    throw error;
  }
}

/**
 * How npx starts: npm's npx-cli.js under node when it sits beside the npm-cli.js that npm_execpath names (bun
 * sets npm_execpath to itself, with no npx-cli.js beside it), otherwise `npx` from PATH.
 */
function npxLauncher() {
  const npmCli = process.env.npm_execpath;
  const npxCli = npmCli === undefined ? undefined : join(dirname(npmCli), "npx-cli.js");
  if (npxCli !== undefined && existsSync(npxCli)) {
    return [process.env.npm_node_execpath ?? process.execPath, npxCli];
  }
  return ["npx"];
}

const argv = process.argv.slice(2);
const help = argv.includes("--help");
const flags = argv.filter((flag) => flag !== "--help");
const installing = !help && !flags.includes("-l") && !flags.includes("--list");
const { coordinate, upstream } = catalogOrFail();
const skillsDir = installedSkillsDir(flags);
const [file, ...launcherArgs] = npxLauncher();
const calls = targets(selectedSkills(flags), coordinate, upstream);
const failures = [];
for (const target of calls) {
  const command = ["-y", "skills", "add", target, ...callFlags(flags)];
  console.log(["npx", ...command].join(" "));
  if (help) continue;
  const skill = upstream.find((candidate) => candidate.target === target);
  const before =
    installing && skill?.explicitOnly
      ? copiesBefore(skill.name, skillsDir, dirname(dirname(skillsDir)))
      : undefined;
  const result = await runCall(file, [...launcherArgs, ...command]);
  if (result.error?.code === "ENOENT") fail(BY_HAND);
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    failures.push({ target, result });
    continue;
  }
  if (before === undefined) continue;
  const { marked, notices } = markWrittenCopies(before);
  for (const path of marked) console.log(`marked explicit-invocation-only: ${path}`);
  for (const notice of notices) console.error(`install: ${notice}`);
}
if (failures.length > 0) {
  console.error(`install: ${failureSummary(failures, calls.length)}`);
  process.exitCode = 1;
}
