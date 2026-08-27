import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// scripts/install-hooks.ts (the package "prepare" script) copies the
// dispatcher into the repository's hooks directory and removes any stale
// core.hooksPath, so hooks work identically in the main checkout and every
// linked worktree, and a checkout without hook logic fails closed at commit
// time instead of silently skipping (a checkout-relative core.hooksPath
// would do exactly that).

const SCRIPT = join(ROOT, "scripts", "install-hooks.ts");
const DISPATCHER = readFileSync(join(ROOT, ".githooks", "pre-commit"), "utf-8");

function sh(cwd: string, ...cmd: string[]) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "install-hooks-test-"));
  expect(sh(dir, "git", "init", "-q", "-b", "main").code).toBe(0);
  return dir;
}

function install(cwd: string) {
  return sh(cwd, process.execPath, SCRIPT);
}

describe("install-hooks", () => {
  test("installs the dispatcher into .git/hooks, executable, byte-identical", () => {
    const repo = makeRepo();
    try {
      expect(install(repo).code).toBe(0);
      const installed = join(repo, ".git", "hooks", "pre-commit");
      expect(readFileSync(installed, "utf-8")).toBe(DISPATCHER);
      expect(statSync(installed).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("removes a stale core.hooksPath and still installs into the DEFAULT hooks dir", () => {
    // Regression, observed live: `--git-path hooks` honors core.hooksPath,
    // so resolving the hooks dir before the unset installed the dispatcher
    // into the stale .husky/_ and left .git/hooks empty - a silent no-hook
    // state. The unset must come first.
    const repo = makeRepo();
    try {
      expect(sh(repo, "git", "config", "core.hooksPath", ".husky/_").code).toBe(0);
      expect(install(repo).code).toBe(0);
      expect(sh(repo, "git", "config", "core.hooksPath").code).toBe(1); // unset
      expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf-8")).toBe(DISPATCHER);
      expect(existsSync(join(repo, ".husky"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a linked worktree installs into the shared hooks directory", () => {
    const repo = makeRepo();
    try {
      expect(sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "initial").code).toBe(0);
      const worktree = join(repo, "linked-wt");
      expect(sh(repo, "git", "worktree", "add", "-q", worktree).code).toBe(0);
      expect(install(worktree).code).toBe(0);
      // One shared hooks dir serves every worktree; each checkout's own
      // .githooks/pre-commit.mts is what the dispatcher runs.
      expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf-8")).toBe(DISPATCHER);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("outside a git repository it skips without failing the install", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-hooks-norepo-"));
    try {
      const r = install(dir);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("skipping hook installation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
