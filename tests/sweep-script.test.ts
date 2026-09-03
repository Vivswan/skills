import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ROOT } from "../scripts/lib";

// Fixture-repo test for the fleet sweep script: a temp git repo with a live
// worktree (ahead of origin, dirty + untracked), a repo-wiping worktree, a
// worktree whose directory was deleted, a divergent origin/develop branch for
// the --base option, and a transcript directory, pinning the contracts the
// sweep exists for - a vanished worktree is an ok:false row and never a zeros
// row, newestDirtyMtime tracks dirty AND untracked files (never the index),
// treeFileCount exposes a wipe commit that every other field reads as normal,
// aheadBehind follows --base and an unresolvable base is loud, and the
// transcript sensor survives truncated final JSONL lines, including one
// larger than the sensor's base tail window.

const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "sweep.mts");
const SWEEP_TIMEOUT = 60_000;

const fixtureRoot = mkdtempSync(join(tmpdir(), "sweep-test-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

// Hooks (the pre-commit check runs this suite) export GIT_DIR/GIT_INDEX_FILE
// pointed at the outer repo; they would hijack every fixture git call.
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function git(cwd: string, ...args: string[]): string {
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

// Fixture: repo (6 tracked files) with an origin so aheadBehind is
// computable, a live worktree one commit ahead with dirty and untracked
// files (one nested), a wipe worktree whose commit deletes lib/, and a
// registered worktree whose directory is deleted afterwards.
const repo = join(fixtureRoot, "repo");
mkdirSync(repo);
git(repo, "init", "-b", "main");
writeFileSync(join(repo, "tracked.txt"), "v1\n");
mkdirSync(join(repo, "lib"));
for (const name of ["a", "b", "c", "d", "e"]) {
  writeFileSync(join(repo, "lib", `${name}.txt`), `${name}\n`);
}
git(repo, "add", ".");
git(repo, "commit", "-m", "initial");
git(fixtureRoot, "clone", "--bare", repo, "origin.git");
git(repo, "remote", "add", "origin", join(fixtureRoot, "origin.git"));
git(repo, "fetch", "origin");
git(repo, "remote", "set-head", "origin", "main");

const wtLive = join(fixtureRoot, "wt-live");
git(repo, "worktree", "add", wtLive, "-b", "track-live");
writeFileSync(join(wtLive, "built.txt"), "output\n");
git(wtLive, "add", "built.txt");
git(wtLive, "commit", "-m", "track work");
const dirtyFile = join(wtLive, "tracked.txt");
const untrackedFile = join(wtLive, "scratch.txt");
const nestedUntrackedFile = join(wtLive, "newdir", "inner.txt");
writeFileSync(dirtyFile, "v2 uncommitted\n");
writeFileSync(untrackedFile, "notes\n");
mkdirSync(join(wtLive, "newdir"));
writeFileSync(nestedUntrackedFile, "nested\n");

const wtWipe = join(fixtureRoot, "wt-wipe");
git(repo, "worktree", "add", wtWipe, "-b", "track-wipe");
git(wtWipe, "rm", "-r", "lib");
git(wtWipe, "commit", "-m", "initial");

const wtGone = join(fixtureRoot, "wt-gone");
git(repo, "worktree", "add", wtGone, "-b", "track-gone");
const wtGoneReal = realpathSync(wtGone);
rmSync(wtGone, { recursive: true, force: true });

// A divergent non-default mainline for the --base option: origin/develop is
// main plus one commit main does not have, so counts against it differ from
// counts against origin/main in BOTH directions for wt-live (ahead by its own
// commit, behind by the develop-only commit). The temporary worktree is
// removed so the sweep's row set stays at four.
const wtDev = join(fixtureRoot, "wt-dev");
git(repo, "worktree", "add", wtDev, "-b", "develop");
writeFileSync(join(wtDev, "dev-only.txt"), "develop\n");
git(wtDev, "add", "dev-only.txt");
git(wtDev, "commit", "-m", "develop work");
git(wtDev, "push", "origin", "develop");
git(repo, "worktree", "remove", wtDev);
git(repo, "fetch", "origin");

function runSweep(root: string, extraEnv: Record<string, string> = {}, ...extraArgs: string[]) {
  return Bun.spawnSync(["bun", SCRIPT, root, ...extraArgs], {
    timeout: SWEEP_TIMEOUT,
    env: { ...cleanEnv(), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// JSON.parse keeps the rows untyped; assertions below pin the actual shape.
function sweepWithEnv(root: string, extraEnv: Record<string, string>, ...extraArgs: string[]) {
  const result = runSweep(root, extraEnv, ...extraArgs);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

function sweepAt(root: string, ...extraArgs: string[]) {
  return sweepWithEnv(root, {}, ...extraArgs);
}

function sweep(...extraArgs: string[]) {
  return sweepAt(repo, ...extraArgs);
}

function rowFor(rows: ReturnType<typeof sweep>, worktreeBasename: string) {
  const row = rows.find((r) => "worktree" in r && basename(r.worktree) === worktreeBasename);
  if (!row) throw new Error(`no row for ${worktreeBasename} in ${JSON.stringify(rows)}`);
  return row;
}

// An error row is exactly these three keys: any count field beside ok:false
// is the zeros row the sweep must never emit. Worktree paths are compared as
// realpaths because git records them that way (/private/var vs /var).
function expectErrorRow(row: unknown, expected: { worktree: string; error: string }) {
  expect(row).toEqual({ worktree: expected.worktree, ok: false, error: expected.error });
}

// Whole-second timestamps so filesystem mtime precision cannot skew equality.
function stamp(msAgo: number): { date: Date; iso: string } {
  const date = new Date(Math.floor((Date.now() - msAgo) / 1000) * 1000);
  return { date, iso: date.toISOString() };
}

function stampAll(dirtyMsAgo: number, untrackedMsAgo: number, nestedMsAgo: number) {
  const dirty = stamp(dirtyMsAgo);
  const untracked = stamp(untrackedMsAgo);
  const nested = stamp(nestedMsAgo);
  utimesSync(dirtyFile, dirty.date, dirty.date);
  utimesSync(untrackedFile, untracked.date, untracked.date);
  utimesSync(nestedUntrackedFile, nested.date, nested.date);
  return { dirty, untracked, nested };
}

describe("sweep.mts worktree rows", () => {
  test(
    "healthy fixture repo yields sane rows, live process attribution, no control failure",
    () => {
      // A real process parked on wt-live's cwd must show up in that row: the
      // lsof attribution path, not just its error path.
      const parked = Bun.spawn(["sleep", "60"], { cwd: wtLive, stdout: "ignore" });
      try {
        const rows = sweep();
        expect(rows.some((r) => r.control === "FAILED")).toBe(false);
        // An lsof degraded note (ok:true) is legitimate on multi-user hosts;
        // an ok:false lsof line here would mean attribution silently died.
        expect(rows.some((r) => "lsof" in r && r.lsof.ok === false)).toBe(false);
        expect(rows.some((r) => "defaultRef" in r)).toBe(false);
        expect(rows.filter((r) => "worktree" in r).length).toBe(4);

        const main = rowFor(rows, "repo");
        expect(main.ok).toBe(true);
        expect(main.branch).toBe("main");
        expect(main.headSha).toMatch(/^[0-9a-f]{40}$/);
        expect(main.aheadBehind).toEqual({ ahead: 0, behind: 0 });
        expect(main.treeFileCount).toBe(6);
        expect(main.dirtyCount).toBe(0);
        expect(main.untrackedCount).toBe(0);
        expect(main.newestDirtyMtime).toBeNull();
        expect(main.statusHash).toMatch(/^[0-9a-f]{16}$/);
        expect(Array.isArray(main.processes)).toBe(true);

        const live = rowFor(rows, "wt-live");
        expect(live.ok).toBe(true);
        expect(live.branch).toBe("track-live");
        expect(live.aheadBehind).toEqual({ ahead: 1, behind: 0 });
        expect(live.treeFileCount).toBe(7);
        expect(live.dirtyCount).toBe(1);
        expect(live.untrackedCount).toBe(2);
        expect(live.statusHash).not.toBe(main.statusHash);
        type Proc = { pid: number; command: string; state: string };
        const procs: Proc[] = live.processes;
        const mine = procs.find((p) => p.pid === parked.pid);
        if (!mine) throw new Error(`parked pid ${parked.pid} not in ${JSON.stringify(procs)}`);
        // The whole attributed record: a dead ps probe reads as state
        // "unknown" and a broken lsof field parse as command "".
        expect(mine).toEqual({
          pid: parked.pid,
          command: "sleep",
          state: expect.stringMatching(/^S/),
        });
      } finally {
        parked.kill();
      }
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a wipe commit reads as a collapsed treeFileCount while every other field looks normal",
    () => {
      const wipe = rowFor(sweep(), "wt-wipe");
      expect(wipe.ok).toBe(true);
      expect(wipe.aheadBehind).toEqual({ ahead: 1, behind: 0 });
      expect(wipe.dirtyCount).toBe(0);
      expect(wipe.untrackedCount).toBe(0);
      expect(wipe.treeFileCount).toBe(1); // base has 6; the commit deleted lib/
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a deleted worktree directory is an ok:false row, never a zeros row",
    () => {
      expectErrorRow(rowFor(sweep(), "wt-gone"), {
        worktree: wtGoneReal,
        error: "worktree directory no longer exists",
      });
    },
    SWEEP_TIMEOUT,
  );

  // msAgo is [dirty, untracked, nested], the stampAll argument order.
  const newestDirtyCases: {
    id: string;
    newest: "dirty" | "untracked" | "nested";
    msAgo: [number, number, number];
    reason: string;
  }[] = [
    {
      id: "newest-untracked",
      newest: "untracked",
      msAgo: [600_000, 300_000, 900_000],
      reason: "untracked files count, not only tracked modifications",
    },
    {
      id: "newest-nested",
      newest: "nested",
      msAgo: [600_000, 300_000, 120_000],
      reason: "guards --untracked-files=all; a collapsed newdir/ entry never moves on inner edits",
    },
    {
      id: "newest-dirty",
      newest: "dirty",
      msAgo: [60_000, 300_000, 900_000],
      reason: "tracked modifications count, not only untracked files",
    },
  ];

  test.each(newestDirtyCases)(
    "newestDirtyMtime follows the newest of dirty, untracked, nested: $id ($reason)",
    ({ id, newest, msAgo }) => {
      const stamps = stampAll(...msAgo);
      expect(rowFor(sweep(), "wt-live").newestDirtyMtime, id).toBe(stamps[newest].iso);
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a dangling untracked symlink is counted and dated by its own lstat mtime",
    () => {
      const link = join(wtLive, "dangling-link");
      symlinkSync(join(wtLive, "no-such-target"), link);
      try {
        const linkStamp = stamp(30_000);
        lutimesSync(link, linkStamp.date, linkStamp.date);
        stampAll(600_000, 300_000, 900_000);

        const live = rowFor(sweep(), "wt-live");
        expect(live.ok).toBe(true);
        expect(live.untrackedCount).toBe(3);
        expect(live.newestDirtyMtime).toBe(linkStamp.iso);
      } finally {
        rmSync(link);
      }
    },
    SWEEP_TIMEOUT,
  );

  test(
    "an untracked filename that is not valid UTF-8 is counted and dated by raw bytes",
    () => {
      // A utf8 decode of the porcelain output would fold the name to U+FFFD,
      // making the mtime stat miss the real file. APFS and some CI
      // filesystems reject such names outright - probe first and bail.
      const rawPath = Buffer.concat([Buffer.from(`${wtLive}/raw-`), Buffer.from([0xff, 0xfe])]);
      try {
        writeFileSync(rawPath, "raw bytes\n");
      } catch (error) {
        // Skip ONLY on the filename-rejection errno class; anything else
        // (EACCES, ENOSPC, ...) is a real failure, not a skippable quirk.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EILSEQ" || code === "EINVAL") {
          console.warn(`skipping: this filesystem rejects invalid-UTF-8 filenames (${code})`);
          return;
        }
        throw error;
      }
      try {
        const raw = stamp(15_000);
        utimesSync(rawPath, raw.date, raw.date);
        stampAll(600_000, 300_000, 900_000);

        const live = rowFor(sweep(), "wt-live");
        expect(live.ok).toBe(true);
        expect(live.untrackedCount).toBe(3);
        expect(live.newestDirtyMtime).toBe(raw.iso);
      } finally {
        rmSync(rawPath, { force: true });
      }
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a dangling origin/HEAD falls back to a verifiable default ref",
    () => {
      // Simulates a default-branch rename: the symbolic ref survives pointing
      // at a remote branch that no longer exists.
      git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/renamed-away");
      try {
        const rows = sweep();
        expect(rows.some((r) => "defaultRef" in r)).toBe(false);
        expect(rowFor(rows, "repo").aheadBehind).toEqual({ ahead: 0, behind: 0 });
      } finally {
        git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      }
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a worktree dir that lost its .git file is ok:false, never the parent's numbers",
    () => {
      // The stale dir nests INSIDE its repo, so git discovery without the
      // .git file escapes to the parent checkout - the row must refuse
      // rather than report the parent's status as the worker's.
      const staleRepo = join(fixtureRoot, "stale-repo");
      mkdirSync(staleRepo);
      git(staleRepo, "init", "-b", "main");
      writeFileSync(join(staleRepo, "base.txt"), "x\n");
      git(staleRepo, "add", ".");
      git(staleRepo, "commit", "-m", "base");
      const inner = join(staleRepo, "inner");
      git(staleRepo, "worktree", "add", inner, "-b", "track-inner");
      const innerReal = realpathSync(inner);
      rmSync(join(inner, ".git"));

      const rows = sweepAt(staleRepo);
      const outer = rowFor(rows, "stale-repo");
      expect(outer.ok).toBe(true);
      expectErrorRow(rowFor(rows, "inner"), {
        worktree: innerReal,
        error: `git discovery escaped the worktree: found toplevel ${realpathSync(staleRepo)}`,
      });
    },
    SWEEP_TIMEOUT,
  );

  test(
    "broken discovery emits control:FAILED as the FIRST line and exits 1",
    () => {
      const notRepo = join(fixtureRoot, "not-a-repo");
      mkdirSync(notRepo);
      const result = runSweep(notRepo);
      expect(result.exitCode).toBe(1);
      const lines = result.stdout.toString().trim().split("\n");
      const first = JSON.parse(lines[0] as string);
      expect(first.control).toBe("FAILED");
      expect(first.reason).toContain("worktree discovery failed");
    },
    SWEEP_TIMEOUT,
  );

  test(
    "hostile inherited GIT_* env cannot redirect the sweep off its argument",
    () => {
      // Each variable is chosen to FAIL a specific half of the sanitizer if
      // it regressed: GIT_OBJECT_DIRECTORY (never in the old fixed strip
      // list) breaks every object lookup if it leaks through, proving the
      // all-GIT_* loop; the hostile config files ignore '*' (hiding every
      // untracked file from status) if honored, proving the /dev/null pin.
      // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE cover the classic redirects.
      const hostileExcludes = join(fixtureRoot, "hostile-excludes");
      writeFileSync(hostileExcludes, "*\n");
      const hostileConfig = join(fixtureRoot, "hostile-gitconfig");
      writeFileSync(hostileConfig, `[core]\n\texcludesFile = ${hostileExcludes}\n`);
      const emptyObjects = join(fixtureRoot, "empty-objects");
      mkdirSync(emptyObjects, { recursive: true });

      const rows = sweepWithEnv(repo, {
        GIT_DIR: join(fixtureRoot, "origin.git"),
        GIT_WORK_TREE: fixtureRoot,
        GIT_INDEX_FILE: join(fixtureRoot, "bogus-index"),
        GIT_OBJECT_DIRECTORY: emptyObjects,
        GIT_CONFIG_GLOBAL: hostileConfig,
        GIT_CONFIG_SYSTEM: hostileConfig,
      });
      expect(rows.some((r) => r.control === "FAILED")).toBe(false);
      const main = rowFor(rows, "repo");
      expect(main.ok).toBe(true);
      expect(main.branch).toBe("main");
      expect(main.treeFileCount).toBe(6);
      expect(main.dirtyCount).toBe(0);
      const live = rowFor(rows, "wt-live");
      expect(live.ok).toBe(true);
      expect(live.dirtyCount).toBe(1);
      expect(live.untrackedCount).toBe(2); // 0 if the hostile excludesFile were honored
    },
    SWEEP_TIMEOUT,
  );

  test(
    "an lsof exiting 0 with no output is a loud instrument failure, not a quiet fleet",
    () => {
      // Zero parsed cwd records is impossible for a working probe (the
      // sweep's own process holds a cwd), so it must read as broken even on
      // a clean exit - never as processes:[] fleet-wide with no diagnostic.
      const binDir = join(fixtureRoot, "fake-bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "lsof"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "lsof"), 0o755);

      const rows = sweepWithEnv(repo, { PATH: `${binDir}:${process.env.PATH}` });
      const line = rows.find((r) => "lsof" in r)?.lsof;
      expect(line.ok).toBe(false);
      expect(line.error).toContain("zero cwd records");
      expect(line.error).toContain("empty output");
      const main = rowFor(rows, "repo");
      expect(main.ok).toBe(true);
      expect(main.processes).toEqual([]);
    },
    SWEEP_TIMEOUT,
  );

  test(
    "every git spawn carries GIT_OPTIONAL_LOCKS=0, even against a hostile inherited value",
    () => {
      // Observer effect guard: a probe that takes index.lock contends with
      // the workers it observes. The shim logs EVERY spawn with the setting
      // it saw, so an empty log means it was bypassed and proves nothing.
      const realGit = Bun.which("git");
      if (!realGit) throw new Error("git not found on PATH");
      const shimDir = join(fixtureRoot, "git-shim");
      mkdirSync(shimDir, { recursive: true });
      const spawnLog = join(fixtureRoot, "git-spawns");
      writeFileSync(spawnLog, "");
      writeFileSync(
        join(shimDir, "git"),
        `#!/bin/sh\nprintf '%s %s\\n' "\${GIT_OPTIONAL_LOCKS:-unset}" "$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(shimDir, "git"), 0o755);

      const rows = sweepWithEnv(repo, {
        PATH: `${shimDir}:${process.env.PATH}`,
        GIT_OPTIONAL_LOCKS: "1",
      });
      const spawns = readFileSync(spawnLog, "utf8").split("\n").filter(Boolean);
      expect(spawns.length).toBeGreaterThan(0);
      expect(spawns.filter((line) => !line.startsWith("0 "))).toEqual([]);
      expect(rowFor(rows, "repo").ok).toBe(true);
      expect(rowFor(rows, "wt-live").ok).toBe(true);
    },
    SWEEP_TIMEOUT,
  );

  test(
    "--base measures aheadBehind against the given ref; omitted, the default base is unchanged",
    () => {
      const rows = sweep("--base", "origin/develop");
      expect(rows.some((r) => "baseRef" in r || "defaultRef" in r)).toBe(false);
      // Against develop: main lacks the develop-only commit and adds nothing.
      expect(rowFor(rows, "repo").aheadBehind).toEqual({ ahead: 0, behind: 1 });
      // wt-live is ahead by its own commit AND behind by the develop-only
      // commit - both numbers differ from the default-base reading below, so
      // a regression to the default resolution cannot pass by coincidence.
      expect(rowFor(rows, "wt-live").aheadBehind).toEqual({ ahead: 1, behind: 1 });

      const defaultRows = sweep();
      expect(rowFor(defaultRows, "repo").aheadBehind).toEqual({ ahead: 0, behind: 0 });
      expect(rowFor(defaultRows, "wt-live").aheadBehind).toEqual({ ahead: 1, behind: 0 });
    },
    SWEEP_TIMEOUT,
  );

  test(
    "an unresolvable --base ref is a loud baseRef error and null counts, never zeros",
    () => {
      const rows = sweep("--base", "origin/no-such-branch");
      const line = rows.find((r) => "baseRef" in r)?.baseRef;
      expect(line.ok).toBe(false);
      expect(line.error).toContain("origin/no-such-branch");
      // Never a silent fallback to the default branch either: that would be
      // exactly the wrong-branch counts the flag exists to prevent.
      expect(rows.some((r) => "defaultRef" in r)).toBe(false);
      expect(rowFor(rows, "repo").aheadBehind).toBeNull();
      expect(rowFor(rows, "wt-live").aheadBehind).toBeNull();
    },
    SWEEP_TIMEOUT,
  );

  test(
    "an ambiguous --base ref is refused, never resolved by git's precedence rules",
    () => {
      // A tag and a branch both named ambi, at DIFFERENT commits: rev-parse
      // exits 0 and silently picks the tag by precedence, so the sweep must
      // detect the ambiguity warning and refuse rather than guess.
      git(repo, "tag", "ambi", "origin/develop");
      git(repo, "branch", "ambi", "main");
      try {
        const rows = sweep("--base", "ambi");
        const line = rows.find((r) => "baseRef" in r)?.baseRef;
        expect(line.ok).toBe(false);
        expect(line.error).toContain("ambiguous");
        expect(rowFor(rows, "repo").aheadBehind).toBeNull();

        // A repo-local core.warnAmbiguousRefs=false suppresses the warning
        // the check reads; the probe must force it back on.
        git(repo, "config", "core.warnAmbiguousRefs", "false");
        try {
          const suppressed = sweep("--base", "ambi");
          const suppressedLine = suppressed.find((r) => "baseRef" in r)?.baseRef;
          expect(suppressedLine.ok).toBe(false);
          expect(suppressedLine.error).toContain("ambiguous");
        } finally {
          git(repo, "config", "--unset", "core.warnAmbiguousRefs");
        }
      } finally {
        git(repo, "tag", "-d", "ambi");
        git(repo, "branch", "-D", "ambi");
      }
    },
    SWEEP_TIMEOUT,
  );

  test(
    "--base without a value is a usage error",
    () => {
      const result = runSweep(repo, {}, "--base");
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        "usage: sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]",
      );
      // A "-"-prefixed value is the next option consumed by mistake (a
      // refname can never start with "-"): a usage error too, never an exit-0
      // sweep with a baseRef diagnostic about a ref named --transcripts.
      const flagEaten = runSweep(repo, {}, "--base", "--transcripts");
      expect(flagEaten.exitCode).toBe(2);
      expect(flagEaten.stderr.toString()).toContain("usage: sweep.mts");
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a repo without an origin default branch says so loudly, not silently",
    () => {
      const solo = join(fixtureRoot, "solo");
      mkdirSync(solo);
      git(solo, "init", "-b", "main");
      writeFileSync(join(solo, "only.txt"), "x\n");
      git(solo, "add", ".");
      git(solo, "commit", "-m", "solo");

      const rows = sweepAt(solo);
      const refError = rows.find((r) => "defaultRef" in r)?.defaultRef;
      expect(refError.ok).toBe(false);
      expect(refError.error).toContain("origin");
      const row = rowFor(rows, "solo");
      expect(row.ok).toBe(true);
      expect(row.aheadBehind).toBeNull();
    },
    SWEEP_TIMEOUT,
  );
});

describe("sweep.mts transcript sensor", () => {
  test(
    "agent names and last event types parse, tolerating truncated final lines",
    () => {
      const transcripts = join(fixtureRoot, "transcripts");
      mkdirSync(transcripts);
      const fooBody = '{"type":"start"}\n{"type":"message"}\n';
      const fooPath = join(transcripts, "agent-foo-abc.jsonl");
      writeFileSync(fooPath, fooBody);
      const fooStamp = stamp(120_000);
      utimesSync(fooPath, fooStamp.date, fooStamp.date);
      writeFileSync(
        join(transcripts, "agent-bar-def.jsonl"),
        '{"type":"start"}\n{"type":"done"}\n{"type":"trunc',
      );
      // A truncated line larger than the sensor's 64 KiB base window: the
      // window must widen until the previous complete event is visible.
      writeFileSync(
        join(transcripts, "agent-big-tail.jsonl"),
        `{"type":"done"}\n{"type":"${"x".repeat(100_000)}`,
      );
      writeFileSync(join(transcripts, "not-a-transcript.log"), "ignored\n");
      // A FIFO named like a transcript must be refused, not read (a blocking
      // synchronous read would hang the sweep). mkfifo may be unavailable.
      const fifoCreated =
        Bun.spawnSync(["mkfifo", join(transcripts, "agent-fifo-x.jsonl")], { timeout: 10_000 })
          .exitCode === 0;

      const before = Date.now();
      const rows = sweep("--transcripts", transcripts);
      const after = Date.now();
      const report = rows.find((r) => "transcripts" in r)?.transcripts;
      expect(report.ok).toBe(true);
      type AgentRow = { agent: string } & Record<string, unknown>;
      const agents: AgentRow[] = report.agents;
      const expected = ["bar-def", "big-tail", "foo-abc"];
      if (fifoCreated) expected.push("fifo-x");
      expect(agents.map((a) => a.agent).sort()).toEqual(expected.sort());

      if (fifoCreated) {
        const fifo = agents.find((a) => a.agent === "fifo-x");
        if (!fifo) throw new Error("missing fifo-x agent row");
        expect(fifo.ok).toBe(false);
        expect(fifo.error).toContain("not a regular file");
      }

      const foo = agents.find((a) => a.agent === "foo-abc");
      if (!foo) throw new Error("missing foo-abc agent row");
      expect(foo).toEqual({
        agent: "foo-abc",
        lastEventType: "message",
        sizeBytes: Buffer.byteLength(fooBody),
        mtime: fooStamp.iso,
        lastEventAgeSeconds: expect.any(Number),
      });
      // The sweep read its clock somewhere between before and after; rounding
      // is monotonic, so the rounded age lies within the rounded bounds.
      const ageAt = (nowMs: number) => Math.round((nowMs - fooStamp.date.getTime()) / 1000);
      expect(foo.lastEventAgeSeconds).toBeGreaterThanOrEqual(ageAt(before));
      expect(foo.lastEventAgeSeconds).toBeLessThanOrEqual(ageAt(after));

      const bar = agents.find((a) => a.agent === "bar-def");
      if (!bar) throw new Error("missing bar-def agent row");
      expect(bar.lastEventType).toBe("done");

      const big = agents.find((a) => a.agent === "big-tail");
      if (!big) throw new Error("missing big-tail agent row");
      expect(big.lastEventType).toBe("done");
    },
    SWEEP_TIMEOUT,
  );

  test(
    "a missing transcript directory reports a loud error, not silence",
    () => {
      const rows = sweep("--transcripts", join(fixtureRoot, "no-such-dir"));
      const report = rows.find((r) => "transcripts" in r)?.transcripts;
      expect(report.ok).toBe(false);
      expect(report.error).toContain("no-such-dir");
    },
    SWEEP_TIMEOUT,
  );
});
