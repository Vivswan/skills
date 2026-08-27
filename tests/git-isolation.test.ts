import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// What a default-env child actually sees - NOT process.env, which the
// preload pins regardless of how this run was launched.
function childVisible(name: string): string {
  const r = Bun.spawnSync(["/bin/sh", "-c", `printf %s "$${name}"`], { stdout: "pipe" });
  return r.stdout.toString();
}

// Hard interlock, measured on real children (the preload runs the same
// probes before any test loads; repeating them here keeps this file safe
// even under a runner that skipped the preload): containment must be proven
// for the default spawn shape before anything leaky is spawned.
function assertChildEnvContained(): void {
  // A default-spawn git must not discover ANY repository: not via an
  // inherited GIT_DIR, not from the starting directory, not by climbing.
  expect(run(undefined, "rev-parse", "--git-dir").code).not.toBe(0);
  expect(childVisible("GIT_CEILING_DIRECTORIES")).toContain(ROOT);
  expect(childVisible("GIT_CONFIG_GLOBAL")).toBe("/dev/null");
  expect(childVisible("GIT_CONFIG_SYSTEM")).toBe("/dev/null");
  expect(childVisible("GIT_DIR")).toBe("");
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
  test("default-env children see the hermetic environment", () => {
    assertChildEnvContained();
    expect(childVisible("GIT_AUTHOR_NAME")).toBe("fixture");
    expect(childVisible("GIT_COMMITTER_EMAIL")).toBe("fixture@example.com");
  });

  test("the preload pinned the in-process view to the same base", () => {
    for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) {
      expect(process.env[key]).toBeUndefined();
    }
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(process.env.GIT_CEILING_DIRECTORIES ?? "").toContain(ROOT);
  });

  test("a leaky repo-level config write with default env AND default cwd is contained", () => {
    assertChildEnvContained();

    const config = realConfigPath();
    const before = readFileSync(config, "utf-8");
    expect(before).not.toContain("leaky-test-wrote-this");
    // The laziest possible leak: no env, no cwd. The launcher starts the
    // test process outside the repository, so discovery dies in a ceilinged
    // non-repo scratch directory instead of finding this repo.
    const r = run(undefined, "config", "user.name", "leaky-test-wrote-this");
    expect(r.code).not.toBe(0);
    expect(readFileSync(config, "utf-8")).toBe(before);
  });

  test("a leaky repo-level config write from inside the working tree is contained", () => {
    assertChildEnvContained();

    const config = realConfigPath();
    const before = readFileSync(config, "utf-8");
    expect(before).not.toContain("leaky-test-wrote-this");
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
    expect(readFileSync(config, "utf-8")).toBe(before);
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
