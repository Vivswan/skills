import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  const raw = result.stdout.toString();
  return {
    code: result.exitCode,
    stdout: raw.trim(),
    raw,
    stderr: result.stderr.toString(),
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "install-hooks-test-"));
  expect(sh(dir, "git", "init", "-q", "-b", "main").code).toBe(0);
  return dir;
}

// Every install runs against an isolated HOME/XDG_CONFIG_HOME: the
// installer deliberately scrubs ALL GIT_* selectors (they are transient and
// diverge from what unmasked commits see), so global-scope fixtures are
// injected the way real machines carry them - as files under HOME.
const cleanHome = mkdtempSync(join(tmpdir(), "install-hooks-home-"));

function homeEnv(home: string): Record<string, string> {
  return { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
}

function install(cwd: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd,
    env: { ...process.env, ...homeEnv(cleanHome), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
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

  test("removes a stale husky hooksPath and still installs into the DEFAULT hooks dir", () => {
    // Regression, observed live: `--git-path hooks` honors core.hooksPath,
    // so resolving the hooks dir before the unset installed the dispatcher
    // into the stale .husky/_ and left .git/hooks empty - a silent no-hook
    // state. The unset must come first, and absolute husky paths (husky
    // itself writes those) migrate the same way.
    const repo = makeRepo();
    try {
      expect(sh(repo, "git", "config", "core.hooksPath", "/somewhere/.husky/_").code).toBe(0);
      expect(install(repo).code).toBe(0);
      expect(sh(repo, "git", "config", "core.hooksPath").code).toBe(1); // unset
      expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf-8")).toBe(DISPATCHER);
      expect(existsSync(join(repo, ".husky"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a local hooksPath this repo did not write aborts the install untouched", () => {
    // Only the known husky value is ours to migrate; anything else is the
    // contributor's intentional configuration. Sneaky near-husky shapes -
    // relative paths merely ENDING in /.husky/_ - are not ours either.
    const repo = makeRepo();
    try {
      for (const value of ["my-custom-hooks", "custom/.husky/_", "../.husky/_"]) {
        expect(sh(repo, "git", "config", "core.hooksPath", value).code).toBe(0);
        const r = install(repo);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("something this repo did not write");
        expect(r.stderr).toContain(value);
        expect(sh(repo, "git", "config", "core.hooksPath").stdout).toBe(value);
        expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an EMPTY local hooksPath value aborts the install untouched", () => {
    // An empty value is a real configuration state (it disables hooks
    // entirely) and it is not husky's; it must abort like any other foreign
    // value instead of vanishing in a filter and passing vacuously.
    const repo = makeRepo();
    try {
      expect(sh(repo, "git", "config", "core.hooksPath", "").code).toBe(0);
      const r = install(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("something this repo did not write");
      expect(sh(repo, "git", "config", "--get-all", "core.hooksPath").code).toBe(0); // still set
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a husky value plus an empty value still aborts", () => {
    const repo = makeRepo();
    try {
      expect(sh(repo, "git", "config", "core.hooksPath", ".husky/_").code).toBe(0);
      expect(sh(repo, "git", "config", "--add", "core.hooksPath", "").code).toBe(0);
      const before = sh(repo, "git", "config", "--get-all", "core.hooksPath");
      expect(before.code).toBe(0);
      // Untrimmed: the empty value is a trailing blank line that .trim()
      // would erase, making a comparison blind to exactly the value whose
      // survival this test exists to prove.
      expect(before.raw).toBe(".husky/_\n\n");
      const r = install(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("something this repo did not write");
      // The mixed configuration survives the aborted install untouched.
      const after = sh(repo, "git", "config", "--get-all", "core.hooksPath");
      expect(after.code).toBe(0);
      expect(after.raw).toBe(before.raw);
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a pre-existing hook not written by this repo aborts the install untouched", () => {
    // husky's core.hooksPath BYPASSED an existing .git/hooks/pre-commit; the
    // migration must not DELETE it.
    const repo = makeRepo();
    try {
      const target = join(repo, ".git", "hooks", "pre-commit");
      writeFileSync(target, "#!/bin/sh\necho user-managed hook\n");
      const r = install(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing to overwrite");
      expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho user-managed hook\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an abort AFTER validation leaves the husky wiring fully intact", () => {
    // Ordering invariant: a checkout with a migratable husky hooksPath AND a
    // foreign pre-existing hook must abort with the hooksPath STILL SET -
    // unsetting first would leave husky unwired with no dispatcher
    // installed, a hook-less state from a refused install.
    const repo = makeRepo();
    try {
      expect(sh(repo, "git", "config", "core.hooksPath", ".husky/_").code).toBe(0);
      const target = join(repo, ".git", "hooks", "pre-commit");
      writeFileSync(target, "#!/bin/sh\necho user-managed hook\n");
      const r = install(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing to overwrite");
      expect(sh(repo, "git", "config", "core.hooksPath").stdout).toBe(".husky/_");
      expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho user-managed hook\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a symlinked pre-commit aborts without following it", () => {
    // lstat, not stat: a DANGLING symlink looks absent through stat, and a
    // copy would follow it and create the linked-to file outside the hooks
    // directory.
    const repo = makeRepo();
    try {
      const target = join(repo, ".git", "hooks", "pre-commit");
      const linkedTo = join(repo, "somewhere-else");
      symlinkSync(linkedTo, target);
      const r = install(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not a regular file");
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(existsSync(linkedTo)).toBe(false); // never created through the link
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a foreign hooksPath reached through a local include aborts untouched", () => {
    // Scoped reads skip include.path by default, but commit-time git follows
    // it: an included hooksPath that slipped past validation would shadow
    // the dispatcher. The installer reads the local scope with --includes.
    const repo = makeRepo();
    try {
      const included = join(repo, "included.gitconfig");
      writeFileSync(included, "[core]\n\thooksPath = included-hooks\n");
      expect(sh(repo, "git", "config", "include.path", included).code).toBe(0);
      const r = install(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("something this repo did not write");
      expect(r.stderr).toContain("included-hooks");
      expect(readFileSync(included, "utf-8")).toContain("included-hooks");
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a dangling .git symlink fails the install instead of skipping", () => {
    // stat follows symlinks into "no entry here"; a broken .git symlink is a
    // broken checkout, not a tarball.
    const dir = mkdtempSync(join(tmpdir(), "install-hooks-dangling-"));
    try {
      symlinkSync(join(dir, "missing-target"), join(dir, ".git"));
      const r = install(dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("git cannot read the repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a .git entry git cannot read fails the install instead of skipping", () => {
    // Skipping is only for genuine non-repositories (tarball installs); a
    // broken checkout skipped silently would end up with no hook at all.
    const dir = mkdtempSync(join(tmpdir(), "install-hooks-broken-"));
    try {
      writeFileSync(join(dir, ".git"), "not a gitdir pointer\n");
      const r = install(dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("git cannot read the repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a previous install of our own dispatcher is overwritten (upgrade path)", () => {
    const repo = makeRepo();
    try {
      const target = join(repo, ".git", "hooks", "pre-commit");
      // An older dispatcher version: recognizable by the self-description.
      writeFileSync(target, "#!/bin/sh\n# old version, installed by scripts/install-hooks.ts\n");
      expect(install(repo).code).toBe(0);
      expect(readFileSync(target, "utf-8")).toBe(DISPATCHER);
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

  test("a hooksPath surviving in an outer scope aborts the install untouched", () => {
    // A local unset cannot remove a global/system/include/worktree value;
    // installing anyway would be shadowed at commit time - or clobber the
    // user-wide hook location the config points at. The installer must
    // refuse and name the survivor. The fixture lives where a real machine
    // carries it: in HOME/.gitconfig.
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "install-hooks-global-"));
    try {
      writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = /somewhere/user-hooks\n");
      const r = install(repo, homeEnv(home));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("core.hooksPath is still set outside the repository scope");
      expect(r.stderr).toContain("global");
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a transient GIT_CONFIG_GLOBAL mask cannot hide the global hooksPath", () => {
    // The reported bypass: `GIT_CONFIG_GLOBAL=/dev/null bun install` would
    // blind the survivor check while every later UNMASKED commit still
    // resolves ~/.gitconfig's hooksPath and silently skips the dispatcher.
    // The installer scrubs the selector, reads the real global file, and
    // aborts.
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "install-hooks-global-"));
    try {
      writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = /somewhere/user-hooks\n");
      const r = install(repo, { ...homeEnv(home), GIT_CONFIG_GLOBAL: "/dev/null" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("core.hooksPath is still set outside the repository scope");
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a transient GIT_CONFIG_SYSTEM selector is inert", () => {
    // The inverse direction: a transient selector pointing AT a hooksPath
    // file must not abort an install that unmasked commits would be fine
    // with - commit-time git never sees that selector either.
    const repo = makeRepo();
    const sysDir = mkdtempSync(join(tmpdir(), "install-hooks-system-"));
    const sysConfig = join(sysDir, "gitconfig");
    try {
      writeFileSync(sysConfig, "[core]\n\thooksPath = /system/hooks\n");
      const r = install(repo, { GIT_CONFIG_SYSTEM: sysConfig });
      expect(r.code).toBe(0);
      expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf-8")).toBe(DISPATCHER);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(sysDir, { recursive: true, force: true });
    }
  });

  test("a failed installation step leaves the husky wiring in place", () => {
    // Publish first, unwire last: when the dispatcher cannot be written
    // (read-only hooks directory here), the husky hooksPath must survive so
    // commits stay checked - never unwired-with-nothing-installed.
    const repo = makeRepo();
    const hooksDir = join(repo, ".git", "hooks");
    try {
      expect(sh(repo, "git", "config", "core.hooksPath", ".husky/_").code).toBe(0);
      chmodSync(hooksDir, 0o555);
      const r = install(repo);
      expect(r.code).not.toBe(0);
      expect(sh(repo, "git", "config", "core.hooksPath").stdout).toBe(".husky/_");
      expect(existsSync(join(hooksDir, "pre-commit"))).toBe(false);
    } finally {
      chmodSync(hooksDir, 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an inherited GIT_CONFIG file is ignored and left byte-identical", () => {
    // GIT_CONFIG points `git config` at an arbitrary file the way --file
    // does. Inherited, it would make the local unset edit that file and
    // blind the survivor check while the REAL local hooksPath keeps
    // shadowing the install. The installer must scrub it: the decoy stays
    // byte-identical, the real local hooksPath is removed, the dispatcher
    // lands in .git/hooks.
    const repo = makeRepo();
    const decoyDir = mkdtempSync(join(tmpdir(), "install-hooks-decoy-"));
    const decoy = join(decoyDir, "gitconfig");
    try {
      writeFileSync(decoy, "[core]\n\thooksPath = /decoy/hooks\n");
      const decoyBefore = readFileSync(decoy, "utf-8");
      expect(sh(repo, "git", "config", "core.hooksPath", ".husky/_").code).toBe(0);
      const r = install(repo, { GIT_CONFIG: decoy });
      expect(r.code).toBe(0);
      expect(readFileSync(decoy, "utf-8")).toBe(decoyBefore);
      expect(sh(repo, "git", "config", "--local", "core.hooksPath").code).toBe(1); // unset
      expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf-8")).toBe(DISPATCHER);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(decoyDir, { recursive: true, force: true });
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
