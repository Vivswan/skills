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
const args = process.argv
  .slice(2)
  .map((arg) => (existsSync(resolve(ROOT, arg)) ? resolve(ROOT, arg) : arg));
if (args.length === 0) args.push(join(ROOT, "tests"));

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
