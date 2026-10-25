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
 * structurally: accidental (cwd- or env-based) discovery of the real
 * repository is blocked; deliberate targeting of its path is not.
 *
 * Built by scripts/run-tests.mts BEFORE the test process starts, because Bun
 * hands children spawned without an explicit `env` the environ snapshot
 * taken at process birth - values a preload sets on process.env (or even
 * libc setenv via bun:ffi) never reach them, so only an environment
 * established at launch contains a leaky default-env spawn. Verified
 * empirically on bun 1.3.14, the hard way: a canary repo-level config write
 * escaped a process.env-only preload and hit the real shared .git/config.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ROOT } from "./lib.mts";

/** Linux allows 108 bytes for a Unix socket path and macOS 104; a longer one fails at bind. */
export const SOCKET_PATH_MAX = 104;

/** The launcher's scratch is a mkdtemp of this prefix under the parent scratchParent() picks. */
export const SCRATCH_PREFIX = "hermetic-tests-";

/** What a test adds below its TMPDIR for a daemon socket: a scenario directory and the socket file. */
export const TEST_SOCKET_ALLOWANCE = 68;

/**
 * Returns the directory the launcher's scratch is made under: the first candidate whose scratch
 * still leaves a test room for a daemon socket, the OS temp dir then /tmp by default. macOS keeps
 * the OS temp dir under /var/folders/<xx>/<long>/T, which leaves none.
 * @throws when no candidate is short enough; the message names each length and the remedy.
 */
export function scratchParent(candidates: string[] = [tmpdir(), "/tmp"]): string {
  const room = SOCKET_PATH_MAX - TEST_SOCKET_ALLOWANCE - `/${SCRATCH_PREFIX}XXXXXX`.length;
  const measured = candidates.map((dir) => realpathSync(dir));

  const fit = measured.find((dir) => Buffer.byteLength(dir) <= room);
  if (fit !== undefined) return fit;

  const lengths = measured.map((dir) => `${dir} (${Buffer.byteLength(dir)} bytes)`).join(", ");
  throw new Error(
    `no temp directory short enough for a Unix socket path under the test scratch: ${lengths}, ${room} allowed; set TMPDIR to a shorter directory`,
  );
}

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

  // The fixture temp tree: the launcher's per-run scratch when passed as
  // TMPDIR, else the OS default. resolve() normalizes a trailing slash so
  // the launcher and the preload compute the same ceiling.
  const fixtureTmp = resolve(base.TMPDIR ?? tmpdir());
  env.TMPDIR = fixtureTmp;

  // Repository discovery may never climb up into this repository or out of
  // the temp tree that holds fixtures: a git spawned in a non-repo directory
  // fails loudly instead of finding and mutating the real repo. Raw and
  // resolved paths are both listed because git compares these entries
  // textually against a symlink-resolved cwd (macOS: /var -> /private/var).
  const ceilings = new Set([ROOT, fixtureTmp]);
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
