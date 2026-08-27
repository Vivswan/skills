#!/usr/bin/env bun

/**
 * Test launcher behind `bun run test`: runs `bun test` inside the hermetic
 * git environment (see scripts/hermetic-git-env.ts for why the environment
 * must exist before the test process is born). Extra arguments replace the
 * default `tests` target, so `bun run test tests/foo.test.ts` runs one file.
 */

import { hermeticGitEnv } from "./hermetic-git-env";
import { ROOT } from "./lib";

const args = process.argv.length > 2 ? process.argv.slice(2) : ["tests"];
const result = Bun.spawnSync(["bun", "test", ...args], {
  cwd: ROOT,
  env: hermeticGitEnv(process.env),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode ?? 1);
