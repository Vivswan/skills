#!/usr/bin/env node
// One-command install of this catalog and its upstream skills through the skills CLI.
//   npx -y github:Vivswan/skills [flags]    runs `npx -y skills add <target> [flags]` for this repository, then
//                                           once per upstream skill of .claude-plugin/marketplace.json
//   npx -y github:Vivswan/skills --help     prints those commands and runs nothing
// The flags pass through unchanged (-g, -a <agents>, -y). Each command prints before it runs, and the first
// nonzero exit ends the run with that code.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MANIFEST = new URL("../.claude-plugin/plugin.json", import.meta.url);
const MARKETPLACE = new URL("../.claude-plugin/marketplace.json", import.meta.url);

/** This catalog as GitHub owner/repo, read from the plugin manifest's repository URL. */
function repoCoordinate() {
  const { repository } = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return new URL(repository).pathname.replace(/^\/|\.git$/g, "");
}

/** The `skills add` targets: this repository, then each upstream skill's folder as <owner/repo>/<path>. */
function targets() {
  const { plugins } = JSON.parse(readFileSync(MARKETPLACE, "utf8"));
  const upstream = plugins
    .filter((plugin) => plugin.source?.source === "git-subdir")
    .map((plugin) => `${plugin.source.url}/${plugin.source.path}`);
  return [repoCoordinate(), ...upstream];
}

const argv = process.argv.slice(2);
const help = argv.includes("--help");
const flags = argv.filter((flag) => flag !== "--help");
for (const target of targets()) {
  const command = ["npx", "-y", "skills", "add", target, ...flags];
  console.log(command.join(" "));
  if (help) continue;
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.error) {
    console.error(`install: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
