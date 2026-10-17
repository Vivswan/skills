#!/usr/bin/env node
// One-command install of this catalog and its upstream skills through the skills CLI.
//   npx -y github:Vivswan/skills [flags]    runs `npx -y skills add <target> [flags]` for this repository, then
//                                           once per upstream skill of .claude-plugin/marketplace.json
//   npx -y github:Vivswan/skills --help     prints those commands and runs nothing
// The flags pass through unchanged (-g, -a <agents>, -y, --skill <names>); a `--skill` selection also narrows
// the calls to the sources that ship a selected name (targets, below), since the CLI exits 1 against a source
// that ships none of them. Each command prints before it runs, and the first nonzero exit ends the run with that
// code. The CLI runs through npm's own npx-cli.js under node, with no shell on any platform: a bin that npx
// started inherits npm_execpath (npm-cli.js, with npx-cli.js beside it) and npm_node_execpath. Started by hand,
// the bin runs `npx` from PATH instead.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = new URL("../.claude-plugin/plugin.json", import.meta.url);
const MARKETPLACE = new URL("../.claude-plugin/marketplace.json", import.meta.url);
const BY_HAND = "run this through npx (npx -y github:Vivswan/skills), which gives it npm's path";

/** One stderr line and exit 1; a line break inside the message (JSON.parse's source quote, a catalog value) folds. */
function fail(message) {
  console.error(`install: ${message.replace(/\s*\n\s*/g, " ")}`);
  process.exit(1);
}

/** The JSON object in one catalog file; a file that does not read, parse, or hold an object fails with its path. */
function loadObject(url) {
  const path = fileURLToPath(url);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail(`${path}: the root must be an object`);
  }
  return data;
}

/** This catalog as GitHub owner/repo, read from the plugin manifest's repository URL. */
function repoCoordinate() {
  const path = fileURLToPath(MANIFEST);
  const { repository } = loadObject(MANIFEST);
  if (typeof repository !== "string") fail(`${path}: repository must be a URL string`);
  if (!URL.canParse(repository)) fail(`${path}: repository is not a URL: ${repository}`);
  return new URL(repository).pathname.replace(/^\/|\.git$/g, "");
}

/**
 * The skill names the flags select, lowercased as the CLI compares them. The CLI's grammar: `-s` or `--skill`
 * takes every following argument up to the next flag or an empty argument, and may repeat; `*` or `--all` means
 * every skill. Undefined when nothing is selected or every skill is, so the caller runs every call.
 */
function selectedSkills(flags) {
  const names = new Set();
  let every = flags.includes("--all");
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== "-s" && flags[i] !== "--skill") continue;
    while (i + 1 < flags.length && flags[i + 1] !== "" && !flags[i + 1].startsWith("-")) {
      i++;
      if (flags[i] === "*") every = true;
      else names.add(flags[i].toLowerCase());
    }
  }
  return every || names.size === 0 ? undefined : names;
}

/**
 * The `skills add` targets: this repository, then each upstream skill's folder as <owner/repo>/<path>. With a
 * selection, only the sources that ship a selected name: an upstream when its entry name is selected, this
 * repository when any other name is.
 */
function targets(selected) {
  const path = fileURLToPath(MARKETPLACE);
  const { plugins } = loadObject(MARKETPLACE);
  if (!Array.isArray(plugins)) fail(`${path}: plugins must be an array`);
  const upstream = plugins
    .filter((plugin) => plugin.source?.source === "git-subdir")
    .map(({ name, source }) => {
      if (typeof source.url !== "string" || typeof source.path !== "string") {
        fail(`${path}: plugin '${name}' git-subdir source needs url and path strings`);
      }
      return { name: String(name).toLowerCase(), target: `${source.url}/${source.path}` };
    });
  if (selected === undefined) return [repoCoordinate(), ...upstream.map(({ target }) => target)];

  const upstreamNames = new Set(upstream.map(({ name }) => name));
  const wanted = upstream.filter(({ name }) => selected.has(name)).map(({ target }) => target);
  const ownNamed = [...selected].some((name) => !upstreamNames.has(name));
  return ownNamed ? [repoCoordinate(), ...wanted] : wanted;
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
const [file, ...launcherArgs] = npxLauncher();
for (const target of targets(selectedSkills(flags))) {
  const command = ["-y", "skills", "add", target, ...flags];
  console.log(["npx", ...command].join(" "));
  if (help) continue;
  const result = spawnSync(file, [...launcherArgs, ...command], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") fail(BY_HAND);
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
