/**
 * Interlock for the hermetic git test environment, wired through
 * bunfig.toml [test].preload so `bun test` cannot load a file without it.
 *
 * Layer 1 - refuse non-hermetic runs: children spawned without an explicit
 * `env` get the environ snapshot from the test process's birth, which
 * nothing set here can reach (see scripts/hermetic-git-env.ts). A run whose
 * environ was not built by the launcher is therefore unsafe by construction
 * and is refused before any test executes.
 *
 * Layer 2 - pin the in-process view: suites that build child envs by
 * spreading {...process.env} get the same hermetic base the environ has.
 */

import { HERMETIC_GIT_ENV_MARKER, hermeticGitEnv } from "../scripts/hermetic-git-env";

if (process.env[HERMETIC_GIT_ENV_MARKER] !== "1") {
  throw new Error(
    [
      "tests must run inside the hermetic git environment: use 'bun run test' (or 'bun run check').",
      "Direct 'bun test' cannot be made safe: children spawned without an explicit env get the",
      "environ snapshot from the test process's birth, which no preload can scrub - a leaky",
      "fixture git flow would reach the real repository (this exact leak once rewrote the shared",
      ".git/config; see scripts/hermetic-git-env.ts and tests/git-isolation.test.ts).",
    ].join("\n"),
  );
}

const env = hermeticGitEnv(process.env);
for (const key of Object.keys(process.env)) {
  if (!(key in env)) delete process.env[key];
}
Object.assign(process.env, env);
