#!/usr/bin/env node
// One-command install of this catalog and its upstream skills through the skills CLI.
//   npx -y github:Vivswan/skills [flags]    runs `npx -y skills add <target> [flags]` for this repository, then
//                                           once per upstream skill of .claude-plugin/marketplace.json
//   npx -y github:Vivswan/skills --help     prints those commands and runs nothing
// The flags pass through unchanged (-g, -a <agents>, -y). Each command prints before it runs, and the first
// nonzero exit ends the run with that code. On Windows the npx shim is npx.cmd, which node runs only through a
// shell, and the shell joins the arguments: one with whitespace is wrapped in double quotes, one carrying a double
// quote is refused.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST = new URL("../.claude-plugin/plugin.json", import.meta.url);
const MARKETPLACE = new URL("../.claude-plugin/marketplace.json", import.meta.url);
// The test suite builds the win32 command on another platform through this override.
const PLATFORM = process.env.SKILLS_INSTALL_PLATFORM ?? process.platform;

function fail(message) {
  console.error(`install: ${message}`);
  process.exit(1);
}

/** The JSON object in one catalog file; a file that does not read, parse, or hold an object fails with its path. */
function loadObject(url) {
  const path = fileURLToPath(url);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // JSON.parse quotes the source around the error, newlines included; the diagnostic stays one line.
    fail(`${path}: ${error.message.replace(/\s*\n\s*/g, " ")}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail(`${path}: the root must be an object`);
  }
  return data;
}

/** This catalog as GitHub owner/repo, read from the plugin manifest's repository URL. */
function repoCoordinate() {
  const { repository } = loadObject(MANIFEST);
  if (typeof repository !== "string")
    fail(`${fileURLToPath(MANIFEST)}: repository must be a URL string`);
  return new URL(repository).pathname.replace(/^\/|\.git$/g, "");
}

/** The `skills add` targets: this repository, then each upstream skill's folder as <owner/repo>/<path>. */
function targets() {
  const { plugins } = loadObject(MARKETPLACE);
  if (!Array.isArray(plugins)) fail(`${fileURLToPath(MARKETPLACE)}: plugins must be an array`);
  const upstream = plugins
    .filter((plugin) => plugin.source?.source === "git-subdir")
    .map((plugin) => `${plugin.source.url}/${plugin.source.path}`);
  return [repoCoordinate(), ...upstream];
}

/** One argument as cmd.exe will split it. */
function cmdArgument(argument) {
  if (argument.includes('"')) {
    fail(
      `argument ${JSON.stringify(argument)} carries a double quote, which cmd.exe cannot pass through`,
    );
  }
  return /\s/.test(argument) ? `"${argument}"` : argument;
}

/** The spawn for one target: bare `npx` with no shell, except on win32, where the shim is npx.cmd and needs one. */
function command(target, flags) {
  const args = ["-y", "skills", "add", target, ...flags];
  return PLATFORM === "win32"
    ? { file: "npx.cmd", args: args.map(cmdArgument), shell: true }
    : { file: "npx", args, shell: false };
}

const argv = process.argv.slice(2);
const help = argv.includes("--help");
const flags = argv.filter((flag) => flag !== "--help");
for (const target of targets()) {
  const { file, args, shell } = command(target, flags);
  console.log([file, ...args].join(" "));
  if (help) continue;
  const result = spawnSync(file, args, { stdio: "inherit", shell });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
