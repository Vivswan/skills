import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ROOT } from "../scripts/lib";

// Regression tests for the hermetic git test environment (the launcher in
// scripts/run-tests.ts plus the tests/preload.ts interlock), the structural
// replacement for the old pre-commit config snapshot guard. The claim under
// test: a deliberately leaky fixture flow - git spawned with NO env option
// and no per-suite hygiene, so it inherits the raw environ - cannot reach
// the real repository. Every spawn in this file deliberately omits `env`;
// that is the exact shape whose canary write once escaped a
// process.env-only preload and rewrote the real shared .git/config.

function run(cwd: string | undefined, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
}

// The exact GIT_* surface the launcher must establish, spelled out here
// rather than taken from hermeticGitEnv: an expected value derived from the
// code under test would move in step with a dropped or changed pin.
function expectedCeilings(): string {
  const dirs = new Set([ROOT, resolve(tmpdir())]);
  for (const dir of [...dirs]) dirs.add(realpathSync(dir));
  return [...dirs].join(":");
}
const HERMETIC_GIT: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CEILING_DIRECTORIES: expectedCeilings(),
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

// The GIT_* slice of an environment, matched case-insensitively like
// hermeticGitEnv drops it: the whole surface the launcher pins.
function gitSubset(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase().startsWith("GIT_")),
  );
}

// What a default-env child actually sees - NOT process.env, which the
// preload pins regardless of how this run was launched. A Bun child reports
// its own birth environment as JSON (portable where `env -0` is not).
function childEnv(): Record<string, string> {
  const r = Bun.spawnSync(
    [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString());
}

// Hard interlock, measured on real children (the preload runs the same
// probes before any test loads; repeating them here keeps this file safe
// even under a runner that skipped the preload): containment must be proven
// for the default spawn shape before anything leaky is spawned.
function assertChildEnvContained(): void {
  // A default-spawn git must not discover ANY repository: not via an
  // inherited GIT_DIR, not from the starting directory, not by climbing.
  expect(run(undefined, "rev-parse", "--git-dir").code).not.toBe(0);
  // Exactly the hermetic GIT_* set - same keys, same values, nothing
  // extra. Discovery alone misses a stray GIT_CONFIG redirect, which would
  // still route a default-env `git config` write into the real file.
  expect(gitSubset(childEnv())).toEqual(HERMETIC_GIT);
}

// The real repository's config file - the file the original incident (and
// the canary) corrupted. Resolved via --git-path so linked worktrees find
// the shared one. Discovery starting AT the repo root works even under the
// ceiling: GIT_CEILING_DIRECTORIES only stops upward traversal, which is
// exactly why the launcher must start the test process outside the repo.
function realConfigPath(): string {
  const r = run(ROOT, "rev-parse", "--git-path", "config");
  expect(r.code).toBe(0);
  return isAbsolute(r.stdout) ? r.stdout : resolve(ROOT, r.stdout);
}

describe("test git isolation (launcher + preload)", () => {
  test("default-env children see exactly the hermetic GIT_* environment", () => {
    assertChildEnvContained();
  });

  test("the in-process GIT_* view equals the hermetic set", () => {
    expect(gitSubset(process.env)).toEqual(HERMETIC_GIT);
  });

  test("a leaky repo-level config write with default env AND default cwd is contained", () => {
    assertChildEnvContained();

    const config = realConfigPath();
    expect(readFileSync(config, "utf-8")).not.toContain("leaky-test-wrote-this");
    // The laziest possible leak: no env, no cwd. The launcher starts the
    // test process outside the repository, so discovery dies in a ceilinged
    // non-repo scratch directory instead of finding this repo.
    const r = run(undefined, "config", "user.name", "leaky-test-wrote-this");
    expect(r.code).not.toBe(0);
    // Canary-scoped, not byte-scoped: a sibling worktree may legitimately
    // append [branch]/[remote] sections to the SHARED config mid-test - the
    // fleet-concurrency false positive the deleted byte-guard had.
    expect(readFileSync(config, "utf-8")).not.toContain("leaky-test-wrote-this");
  });

  test("a leaky repo-level config write from inside the working tree is contained", () => {
    assertChildEnvContained();

    const config = realConfigPath();
    expect(readFileSync(config, "utf-8")).not.toContain("leaky-test-wrote-this");
    // A non-repo fixture directory inside the real working tree: without the
    // ceiling, git discovery climbs up, finds this repository, and writes
    // into its config - the incident shape, live-confirmed by the canary.
    const leaky = mkdtempSync(join(ROOT, ".leaky-fixture-"));
    try {
      const r = run(leaky, "config", "user.name", "leaky-test-wrote-this");
      expect(r.code).not.toBe(0);
    } finally {
      rmSync(leaky, { recursive: true, force: true });
    }
    expect(readFileSync(config, "utf-8")).not.toContain("leaky-test-wrote-this");
  });

  test("the machine's global git config cannot leak into fixtures", () => {
    // A fixture repo with no identity of its own: user.name must be unset
    // (exit 1) even on machines whose ~/.gitconfig sets one.
    const dir = mkdtempSync(join(tmpdir(), "isolation-fixture-"));
    try {
      expect(run(dir, "init", "-q", "-b", "main").code).toBe(0);
      expect(run(dir, "config", "--get", "user.name").code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fixture commits without per-suite identity are deterministic", () => {
    const dir = mkdtempSync(join(tmpdir(), "isolation-fixture-"));
    try {
      expect(run(dir, "init", "-q", "-b", "main").code).toBe(0);
      expect(run(dir, "commit", "-q", "--allow-empty", "-m", "fixture").code).toBe(0);
      const r = run(dir, "log", "-1", "--format=%an <%ae> %cn <%ce>");
      expect(r.stdout).toBe("fixture <fixture@example.com> fixture <fixture@example.com>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
