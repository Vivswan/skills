import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Incident-class tests for the pre-commit hook: git exports GIT_DIR and
// GIT_INDEX_FILE to hooks, and everything `bun run check` spawns inherits
// them, so an unscrubbed fixture git flow in a test would mutate the real
// repository (fixture commits landed on real branches; core.bare/identity
// overwrites corrupted the shared .git/config). The hook must scrub every
// GIT_* variable before running the checks. The old snapshot guard over
// .git/config is gone: the hermetic test environment (see
// tests/git-isolation.test.ts) makes the repository unreachable from tests
// by construction, so the hook only scrubs, runs the checks, and propagates
// their exit status.
//
// A fake `bun` on PATH stands in for the check pipeline; scratch repos in
// tmp stand in for the real repository ("victim") and a test fixture. The
// hermetic launcher environment keeps every git spawned here contained, so
// no extra per-suite env scrubbing is needed; simulated hook leaks are
// added explicitly per test.

const DISPATCHER = join(ROOT, ".githooks", "pre-commit");
const HOOK = join(ROOT, ".githooks", "pre-commit.mts");

// The fake `bun` handles the two call shapes the hook chain produces: the
// dispatcher's `bun .githooks/pre-commit.mts` is forwarded to the real bun
// so the hook logic really runs, and the hook's `bun run check` is
// intercepted - it dumps the GIT_* environment and argv it received, then
// plays a scenario: an unscrubbed fixture git flow (init + commit that would
// land on the victim if GIT_DIR leaked through), a check failure, or death
// by signal.
const FAKE_BUN = `#!/usr/bin/env bash
if [ "$1" != "run" ]; then
  exec "\${HOOK_REAL_BUN}" "$@"
fi
env | grep '^GIT_' > "\${HOOK_ENV_DUMP:-/dev/null}" || true
[ -n "\${HOOK_ARGV_DUMP:-}" ] && echo "$*" > "\${HOOK_ARGV_DUMP}"
case "\${HOOK_BUN_MODE:-ok}" in
  fixture-flow)
    mkdir -p "\${HOOK_FIXTURE_DIR}"
    cd "\${HOOK_FIXTURE_DIR}"
    git init -q -b main
    echo data > file.txt
    git add file.txt
    git -c user.email=f@f -c user.name=f commit -q -m "fixture commit"
    ;;
  fail)
    exit 3
    ;;
  signal)
    kill -TERM $$
    ;;
esac
exit 0
`;

const binDir = mkdtempSync(join(tmpdir(), "pre-commit-hook-test-"));
writeFileSync(join(binDir, "bun"), FAKE_BUN);
chmodSync(join(binDir, "bun"), 0o755);
// An empty PATH entry for the bun-missing scenario.
const emptyBinDir = join(binDir, "empty-bin");
mkdirSync(emptyBinDir);

afterAll(() => rmSync(binDir, { recursive: true, force: true }));

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

let scenario = 0;
// A scratch checkout: a git repo whose .githooks/pre-commit.mts is a copy of
// the real one, the way a real checkout ships it (the dispatcher resolves
// hook logic from the checkout it runs in).
function makeCheckout(): string {
  scenario += 1;
  const dir = mkdtempSync(join(binDir, `repo-${scenario}-`));
  git("init", "-q", "-b", "main", dir);
  git("-C", dir, "commit", "-q", "--allow-empty", "-m", "initial");
  mkdirSync(join(dir, ".githooks"));
  copyFileSync(HOOK, join(dir, ".githooks", "pre-commit.mts"));
  return dir;
}

// Run the hook chain from its entry point (`sh` on the dispatcher, or the
// real bun directly on the .mts), with the fake bun first on PATH plus only
// the simulated hook exports passed in by the scenario.
function runHook(entry: string[], cwd: string, env: Record<string, string>) {
  const result = Bun.spawnSync(entry, {
    cwd,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOOK_REAL_BUN: process.execPath,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("pre-commit dispatcher", () => {
  test("a checkout without hook logic fails the commit instead of skipping silently", () => {
    const dir = mkdtempSync(join(binDir, "no-logic-"));
    git("init", "-q", "-b", "main", dir);
    const r = runHook(["/bin/sh", DISPATCHER], dir, {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to commit unchecked");
  });

  test("missing bun fails loudly with an install hint", () => {
    const checkout = makeCheckout();
    const r = Bun.spawnSync(["/bin/sh", DISPATCHER], {
      cwd: checkout,
      env: { PATH: emptyBinDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("bun not found");
    expect(r.stderr.toString()).toContain("https://bun.sh");
  });

  test("end to end: leaked GIT_DIR/GIT_INDEX_FILE never reach the checks or the victim repo", () => {
    const checkout = makeCheckout();
    const victim = makeCheckout();
    mkdirSync(join(checkout, "node_modules"));
    const fixture = join(binDir, "fixture-1");
    const envDump = join(binDir, "env-dump-1");
    const argvDump = join(binDir, "argv-dump-1");
    const victimHead = git("-C", victim, "rev-parse", "HEAD");
    const victimConfig = readFileSync(join(victim, ".git", "config"), "utf-8");

    const r = runHook(["/bin/sh", DISPATCHER], checkout, {
      GIT_DIR: join(victim, ".git"),
      GIT_INDEX_FILE: join(victim, ".git", "index"),
      GIT_AUTHOR_NAME: "leaked",
      HOOK_BUN_MODE: "fixture-flow",
      HOOK_FIXTURE_DIR: fixture,
      HOOK_ENV_DUMP: envDump,
      HOOK_ARGV_DUMP: argvDump,
    });
    expect(r.code).toBe(0);
    // The dispatcher reached the checkout's hook logic, and the hook invoked
    // the real check script.
    expect(readFileSync(argvDump, "utf-8").trim()).toBe("run check");
    // The scrub is total: the check pipeline saw no GIT_* variable at all.
    expect(readFileSync(envDump, "utf-8")).toBe("");
    // The unscrubbed fixture flow stayed in its fixture...
    expect(git("-C", fixture, "log", "--format=%s")).toBe("fixture commit");
    // ...and the victim kept its branch tip and its config bytes.
    expect(git("-C", victim, "rev-parse", "HEAD")).toBe(victimHead);
    expect(readFileSync(join(victim, ".git", "config"), "utf-8")).toBe(victimConfig);
  });
});

describe("pre-commit hook logic", () => {
  test("a failing check propagates its exit status", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "node_modules"));
    const r = runHook([process.execPath, HOOK], checkout, { HOOK_BUN_MODE: "fail" });
    expect(r.code).toBe(3);
  });

  test("a check killed by a signal propagates a shell-style status", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "node_modules"));
    const r = runHook([process.execPath, HOOK], checkout, { HOOK_BUN_MODE: "signal" });
    expect(r.code).toBe(128 + 15); // SIGTERM
  });

  test("missing node_modules refuses to run the checks", () => {
    const checkout = makeCheckout();
    const r = runHook([process.execPath, HOOK], checkout, {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Dependencies are missing");
    expect(r.stderr).toContain("bun install");
  });

  test("running outside a repository root refuses instead of checking the wrong tree", () => {
    const notARepo = mkdtempSync(join(binDir, "not-a-repo-"));
    const r = runHook([process.execPath, HOOK], notARepo, {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a repository root");
  });

  test("a linked-worktree root (.git is a file) is accepted", () => {
    // In a linked worktree .git is a FILE pointing at the common dir; the
    // root check must accept it, not demand a directory.
    const dir = mkdtempSync(join(binDir, "worktree-root-"));
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
    mkdirSync(join(dir, "node_modules"));
    const r = runHook([process.execPath, HOOK], dir, {});
    expect(r.code).toBe(0);
  });
});
