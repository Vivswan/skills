#!/usr/bin/env bun
// The schema checks behind `bun run lint:json`. uvx fetches check-jsonschema, so it needs no
// install step here.

import { ROOT } from "./lib";

const CHECKS: readonly (readonly string[])[] = [
  ["--schemafile", "https://json.schemastore.org/package.json", "package.json"],
  [
    "--builtin-schema",
    "vendor.github-issue-forms",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ],
  [
    "--schemafile",
    "https://json.schemastore.org/github-issue-config.json",
    ".github/ISSUE_TEMPLATE/config.yml",
  ],
];

for (const args of CHECKS) {
  const proc = Bun.spawnSync(["uvx", "--no-config", "check-jsonschema", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}
