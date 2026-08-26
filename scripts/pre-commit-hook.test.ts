import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib";

// Incident-class test for the pre-commit hook: git exports GIT_DIR and
// GIT_INDEX_FILE to hooks, and test suites spawned by `bun run check`
// inherit them, so an unscrubbed fixture git flow in a test mutates the real
// repository (fixture commits landed on real branches; core.bare/identity
// overwrites corrupted the shared .git/config). The hook owns the fix: it
// must scrub every GIT_* variable before running checks, and block the
// commit if .git/config is not byte-identical afterwards. A fake `bun` on
// PATH stands in for the check pipeline; scratch repos in tmp stand in for
// the real repository ("victim") and a test fixture.

const SCRIPT = join(ROOT, ".husky", "pre-commit");

// The fake `bun` dumps the GIT_* environment it received, then plays one of
// the incident shapes: an unscrubbed fixture git flow (init + commit that
// lands on the victim when GIT_DIR leaks), a .git/config mutation against
// the hook's own repo, or a plain check failure.
const FAKE_BUN = `#!/usr/bin/env bash
env | grep '^GIT_' > "\${HOOK_ENV_DUMP:-/dev/null}" || true
case "\${HOOK_BUN_MODE:-ok}" in
  fixture-flow)
    mkdir -p "\${HOOK_FIXTURE_DIR}"
    cd "\${HOOK_FIXTURE_DIR}"
    git init -q -b main
    echo data > file.txt
    git add file.txt
    git -c user.email=f@f -c user.name=f commit -q -m "fixture commit"
    ;;
  corrupt-config)
    git config core.bare true
    ;;
  fail)
    exit 3
    ;;
esac
exit 0
`;

const binDir = mkdtempSync(join(tmpdir(), "pre-commit-hook-test-"));
writeFileSync(join(binDir, "bun"), FAKE_BUN);
chmodSync(join(binDir, "bun"), 0o755);

afterAll(() => rmSync(binDir, { recursive: true, force: true }));

// Every process this test spawns starts from an environment with no GIT_*
// variables: if the test itself runs under a hook that failed to scrub, an
// inherited GIT_DIR would otherwise let the setup helpers reproduce the very
// incident this test guards against. The simulated leak is added explicitly
// in runHook, never inherited.
function scrubbedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ) as Record<string, string>;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    env: scrubbedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

let scenario = 0;
function makeRepo(): string {
  scenario += 1;
  const dir = mkdtempSync(join(binDir, `repo-${scenario}-`));
  git("init", "-q", "-b", "main", dir);
  git(
    "-C",
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "initial",
  );
  return dir;
}

// The hook sees the scrubbed base environment plus only the simulated hook
// exports passed in by the scenario.
function runHook(cwd: string, env: Record<string, string>) {
  const result = Bun.spawnSync(["sh", SCRIPT], {
    cwd,
    env: { ...scrubbedEnv(), PATH: `${binDir}:${process.env.PATH}`, TMPDIR: binDir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("pre-commit hook git-env scrub", () => {
  test("leaked GIT_DIR/GIT_INDEX_FILE never reach the checks or the victim repo", () => {
    const hookRepo = makeRepo();
    const victim = makeRepo();
    mkdirSync(join(hookRepo, "node_modules"));
    const fixture = join(binDir, "fixture-1");
    const envDump = join(binDir, "env-dump-1");
    const victimHead = git("-C", victim, "rev-parse", "HEAD");
    const victimConfig = readFileSync(join(victim, ".git", "config"), "utf-8");

    const r = runHook(hookRepo, {
      GIT_DIR: join(victim, ".git"),
      GIT_INDEX_FILE: join(victim, ".git", "index"),
      GIT_AUTHOR_NAME: "leaked",
      HOOK_BUN_MODE: "fixture-flow",
      HOOK_FIXTURE_DIR: fixture,
      HOOK_ENV_DUMP: envDump,
    });
    expect(r.code).toBe(0);
    // The scrub is total: the check pipeline saw no GIT_* variable at all.
    expect(readFileSync(envDump, "utf-8")).toBe("");
    // The unscrubbed fixture flow stayed in its fixture...
    expect(git("-C", fixture, "log", "--format=%s")).toBe("fixture commit");
    // ...and the victim kept its branch tip and its config bytes.
    expect(git("-C", victim, "rev-parse", "HEAD")).toBe(victimHead);
    expect(readFileSync(join(victim, ".git", "config"), "utf-8")).toBe(victimConfig);
  });

  test("a check that mutates .git/config blocks the commit", () => {
    const hookRepo = makeRepo();
    mkdirSync(join(hookRepo, "node_modules"));
    const r = runHook(hookRepo, { HOOK_BUN_MODE: "corrupt-config" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("FATAL");
    expect(r.stderr).toContain("changed while 'bun run check' ran");
  });

  test("the config guard resolves the shared config from a linked worktree", () => {
    // In a linked worktree .git is a file and the shared config lives in the
    // main repository, so a literal ".git/config" would miss the file that
    // actually gets corrupted; the hook must resolve it via --git-path.
    const hookRepo = makeRepo();
    const worktree = join(binDir, "linked-worktree");
    git("-C", hookRepo, "worktree", "add", "-q", worktree);
    mkdirSync(join(worktree, "node_modules"));
    const r = runHook(worktree, { HOOK_BUN_MODE: "corrupt-config" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("FATAL");
  });

  test("a failing check propagates its exit status after the config comparison", () => {
    const hookRepo = makeRepo();
    mkdirSync(join(hookRepo, "node_modules"));
    const r = runHook(hookRepo, { HOOK_BUN_MODE: "fail" });
    expect(r.code).toBe(3);
  });

  test("missing node_modules refuses to run the checks", () => {
    const hookRepo = makeRepo();
    const r = runHook(hookRepo, {});
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Dependencies are missing");
  });
});
