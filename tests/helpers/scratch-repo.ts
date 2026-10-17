// A scratch git repository for the worktree readings: the hermetic git runner, a six-file
// repository with its worktrees on canonical paths, and a process parked in a directory. Without
// it each suite carries its own copy, and a fixture fix lands in one and drifts from the other.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The process env without GIT_*: hooks (the pre-commit check runs these suites) export GIT_DIR and GIT_INDEX_FILE at the outer repository, which would hijack every fixture git call. */
export function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

/** Runs git in `cwd` with no user or system config and a fixture identity, and returns its stdout; a nonzero exit throws. */
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    timeout: 30_000, // module-top-level fixture calls must never hang the suite
    env: {
      ...cleanEnv(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

/** The scratch repository `scratchRepo` builds: its canonical root, the repository, and each worktree by name. */
export interface ScratchRepo<Name extends string> {
  /** The canonical temp root, as git and the daemon report paths: a temp dir can sit behind a symlink. */
  base: string;
  /** The repository: six tracked files on `main`, one commit. */
  repo: string;
  /** Each worktree's path by its directory name, under `base`. */
  worktrees: Record<Name, string>;
}

/** A repository of six files on `main`, with one worktree per entry of `worktrees` (directory name to branch). */
export function scratchRepo<Name extends string>(
  root: string,
  worktrees: Record<Name, string>,
): ScratchRepo<Name> {
  const base = realpathSync(root);
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  mkdirSync(join(repo, "lib"));
  for (const name of ["a", "b", "c", "d", "e"]) {
    writeFileSync(join(repo, "lib", `${name}.txt`), `${name}\n`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");

  const made = {} as Record<Name, string>;
  for (const [name, branch] of Object.entries<string>(worktrees)) {
    const path = join(base, name);
    git(repo, "worktree", "add", path, "-b", branch);
    made[name as Name] = path;
  }
  return { base, repo, worktrees: made };
}

/** A process parked in `cwd` for lsof to attribute to that directory; the caller kills it. */
export function park(cwd: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["sleep", "60"], { cwd, stdout: "ignore" });
}
