#!/usr/bin/env bun

/**
 * Test launcher behind `bun run test`: runs `bun test` inside the hermetic
 * git environment (see scripts/hermetic-git-env.ts for why the environment
 * must exist before the test process is born). Extra arguments replace the
 * default `tests` target, so `bun run test tests/foo.test.ts` runs one file.
 *
 * The test process starts in a scratch directory OUTSIDE the repository:
 * GIT_CEILING_DIRECTORIES never protects the starting directory itself, so
 * with cwd at the repo root a git spawned with neither `env` nor `cwd` would
 * still discover and mutate the real repository. From the scratch cwd such a
 * spawn dies in a ceilinged non-repo directory instead. bunfig.toml is not
 * discovered from the scratch cwd, so the preload - which verifies this
 * birth environment - is passed explicitly.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticGitEnv } from "./hermetic-git-env";
import { ROOT } from "./lib";

// Path-like arguments are resolved against the repository root (the scratch
// cwd contains no tests); flags and name filters pass through untouched.
// Known limits of the scratch cwd: flags that WRITE repo-relative outputs
// (--coverage-dir, reporter files) or discover the repo from the cwd
// (--changed) would need absolute paths; nothing in this repo uses them.
// Only an argument naming a real path counts as a target: bun test ORs
// positional filters together, and a bare word can be an option's value
// (--test-name-pattern baz) just as well as a name filter, so anything that
// is not a real path gets the default target appended - over-running is
// safe, a scratch-cwd invocation left with no target is not (bun exits 1 on
// zero tests found, but --pass-with-no-tests would turn that into success).
let hasPathTarget = false;
const args = process.argv.slice(2).map((arg) => {
  const resolved = resolve(ROOT, arg);
  if (existsSync(resolved)) {
    hasPathTarget = true;
    return resolved;
  }
  return arg;
});
if (!hasPathTarget) args.push(join(ROOT, "tests"));

const scratch = mkdtempSync(join(tmpdir(), "hermetic-tests-"));
let status: number;
try {
  const result = Bun.spawnSync(
    ["bun", "test", "--preload", join(ROOT, "tests", "preload.ts"), ...args],
    {
      cwd: scratch,
      env: hermeticGitEnv(process.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  status = result.exitCode ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
