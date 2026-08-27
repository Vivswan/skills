/**
 * Interlock for the hermetic git test environment, loaded by
 * scripts/run-tests.ts via --preload and by any direct `bun test` at the
 * repo root via bunfig.toml [test].preload.
 *
 * Layer 1 - verify the CHILD-VISIBLE birth environment, measured rather
 * than trusted: children spawned without an explicit `env` get the environ
 * snapshot from the test process's birth, which nothing set here can reach
 * (see scripts/hermetic-git-env.ts), and a trusted marker variable could be
 * forged around an unsafe environ. So the probes below spawn real children
 * and refuse the run - before any test executes - unless containment
 * demonstrably holds for exactly the spawn shape a hygiene-free test uses.
 *
 * Layer 2 - pin the in-process view: suites that build child envs by
 * spreading {...process.env} get the same hermetic base the environ has.
 */

import { hermeticGitEnv } from "../scripts/hermetic-git-env";
import { ROOT } from "../scripts/lib";

function refuse(reason: string): never {
  throw new Error(
    [
      `unsafe test environment: ${reason}.`,
      "Run tests via 'bun run test' (or 'bun run check'): the hermetic git environment must",
      "exist before the test process starts, and it must start outside the repository -",
      "otherwise a leaky fixture git flow reaches the real repository (this exact leak once",
      "rewrote the shared .git/config; see scripts/hermetic-git-env.ts and",
      "tests/git-isolation.test.ts).",
    ].join("\n"),
  );
}

// Probe 1: a git spawned exactly like a hygiene-free test would spawn it -
// no env, no cwd - must fail to discover ANY repository. This one probe
// covers every leak shape at once: an inherited GIT_DIR redirect, a starting
// directory inside a repository (GIT_CEILING_DIRECTORIES never protects the
// start directory itself), and a missing ceiling.
const discovery = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (discovery.exitCode === 0) {
  refuse(
    `a git child with default env and cwd can discover a repository (${discovery.stdout.toString().trim()})`,
  );
}

// Probe 2: the machine's global and system git config must be masked for
// default-env children (so fixtures neither depend on nor write through to
// the real configuration), and the discovery ceiling must cover the
// repository root - probe 1 alone cannot tell "ceiling in place" from "this
// run merely started outside any repository", and only the ceiling contains
// a later child given an explicit cwd inside the repository's subtree.
const probe = Bun.spawnSync(
  [
    "/bin/sh",
    "-c",
    'printf "%s\\n%s\\n%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM" "$GIT_CEILING_DIRECTORIES"',
  ],
  { stdout: "pipe" },
);
const [configGlobal, configSystem, ceiling] = probe.stdout.toString().split("\n");
if (configGlobal !== "/dev/null" || configSystem !== "/dev/null") {
  refuse("GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are not masked for child processes");
}
if (!(ceiling ?? "").split(":").includes(ROOT)) {
  refuse("GIT_CEILING_DIRECTORIES does not cover the repository root for child processes");
}

const env = hermeticGitEnv(process.env);
for (const key of Object.keys(process.env)) {
  if (!(key in env)) delete process.env[key];
}
Object.assign(process.env, env);
