/**
 * The hermetic git environment every test process must run inside.
 *
 * Incident class: git exports GIT_DIR, GIT_INDEX_FILE, and other GIT_*
 * variables to hooks, and test suites spawned under a hook inherit them; a
 * fixture git operation in a test with no env hygiene of its own then
 * mutates the real repository instead of its fixture (observed: fixture
 * commits landing on real branches, core.bare/identity overwrites in the
 * shared .git/config). The previous pre-commit hook answered with a config
 * snapshot guard - detection after the fact. This environment replaces it
 * structurally: tests cannot reach the real repository in the first place.
 *
 * Built by scripts/run-tests.ts BEFORE the test process starts, because Bun
 * hands children spawned without an explicit `env` the environ snapshot
 * taken at process birth - values a preload sets on process.env (or even
 * libc setenv via bun:ffi) never reach them, so only an environment
 * established at launch contains a leaky default-env spawn. Verified
 * empirically on bun 1.3.14, the hard way: a canary repo-level config write
 * escaped a process.env-only preload and hit the real shared .git/config.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./lib";

/** Pure: builds a child environment from a base; never mutates the input. */
export function hermeticGitEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  // Drop every inherited GIT_* variable (GIT_DIR / GIT_INDEX_FILE /
  // GIT_WORK_TREE from a hook, GIT_EXTERNAL_DIFF, ...) so nothing a test
  // spawns can be redirected at the real repository.
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }

  // No user or system config: fixture git behavior cannot depend on - or
  // write through to - the machine's real configuration.
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";

  // Repository discovery may never climb up into this repository or out of
  // the temp tree that holds fixtures: a git spawned in a non-repo directory
  // fails loudly instead of finding and mutating the real repo. Raw and
  // resolved paths are both listed because git compares these entries
  // textually against a symlink-resolved cwd (macOS: /var -> /private/var).
  const ceilings = new Set([ROOT, tmpdir()]);
  for (const dir of [...ceilings]) ceilings.add(realpathSync(dir));
  env.GIT_CEILING_DIRECTORIES = [...ceilings].join(":");

  // Deterministic identity for fixture commits that configure none of their
  // own; with GIT_CONFIG_GLOBAL pinned to /dev/null they would otherwise
  // fail on machines without a global identity and diverge on machines with
  // one.
  env.GIT_AUTHOR_NAME = "fixture";
  env.GIT_AUTHOR_EMAIL = "fixture@example.com";
  env.GIT_COMMITTER_NAME = "fixture";
  env.GIT_COMMITTER_EMAIL = "fixture@example.com";

  return env;
}
