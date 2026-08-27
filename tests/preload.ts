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

// Probe 2: the child-visible GIT_* surface must be EXACTLY the hermetic set
// the launcher builds - same keys, same values, nothing extra. Spot-checking
// a few variables would miss redirects the discovery probe cannot see (a
// stray GIT_CONFIG pointing at the real .git/config, say: discovery still
// fails from a scratch cwd, yet a default-env `git config` write would land
// in the real file). Measured by a Bun child reporting its own birth
// environment as JSON - portable where `env -0` is not (BSD env) - and
// fail-closed on any probe failure.
const dump = Bun.spawnSync(
  [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
  { stdout: "pipe", stderr: "pipe" },
);
if (dump.exitCode !== 0) {
  refuse(`the birth-environment probe child failed (exit ${dump.exitCode})`);
}
const childGit = new Map<string, string>();
for (const [key, value] of Object.entries(
  JSON.parse(dump.stdout.toString()) as Record<string, string>,
)) {
  if (key.toUpperCase().startsWith("GIT_")) childGit.set(key, value);
}
const expectedGit = new Map(
  Object.entries(hermeticGitEnv({})).filter(([key]) => key.startsWith("GIT_")),
);
for (const [key, value] of expectedGit) {
  if (childGit.get(key) !== value) {
    refuse(
      `child-visible ${key} is ${JSON.stringify(childGit.get(key))}, expected ${JSON.stringify(value)}`,
    );
  }
}
for (const key of childGit.keys()) {
  if (!expectedGit.has(key)) {
    refuse(`child-visible environment carries an unexpected git variable: ${key}`);
  }
}

const env = hermeticGitEnv(process.env);
for (const key of Object.keys(process.env)) {
  if (!(key in env)) delete process.env[key];
}
Object.assign(process.env, env);
