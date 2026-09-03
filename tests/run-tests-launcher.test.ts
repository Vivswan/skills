import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../scripts/lib";

// The launcher's zero-test guard: an invocation that runs zero tests must
// fail HOWEVER it was reached. bun test itself exits 0 with "Ran 0 tests"
// for --only with no .only test and for --pass-with-no-tests, so the
// launcher is the backstop that keeps `bun run test <anything>` from ever
// reporting a vacuous green.

const LAUNCHER = join(ROOT, "scripts", "run-tests.ts");
// The suite's smallest fast file; every scenario here nests a real bun test
// run, so the target must stay cheap.
const TARGET = join("tests", "lib.test.ts");

function run(...args: string[]) {
  return runWithEnv({}, ...args);
}

function runWithEnv(env: Record<string, string>, ...args: string[]) {
  const result = Bun.spawnSync(["bun", LAUNCHER, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

describe("run-tests zero-test guard", () => {
  test("--only with no .only test fails instead of passing on zero tests", () => {
    const r = run("--only", TARGET);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Ran 0 tests");
    expect(r.stderr).toContain("zero tests ran");
  });

  test("--pass-with-no-tests cannot turn a zero-test run into success", () => {
    // In this shape bun exits 0 while printing an "error: regex ... matched
    // 0 tests" line INSTEAD of the "Ran N tests" summary - the guard's
    // missing-summary branch is what catches it.
    const r = run("--pass-with-no-tests", "-t", "zzNoSuchTestAnywhere", TARGET);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to report success");
  });

  test("bun's echo of a summary-shaped CLI value cannot spoof the guard", () => {
    // bun prints `error: regex "Ran 1 test across 1 file. [x]" matched 0
    // tests` - a full summary mid-line, which an unanchored search would take
    // for a real one and let --pass-with-no-tests exit 0 on zero tests.
    const spoof = "Ran 1 test across 1 file. [x]";
    const r = run("--pass-with-no-tests", "-t", spoof, TARGET);
    // The echo must be present, or this run is only the missing-summary case.
    expect(r.stderr).toContain(`regex "${spoof}" matched 0 tests`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to report success");
  });

  test("a run with real tests still passes: the guard's summary parse matches bun", () => {
    // Positive control: if bun rewords the "Ran N tests" summary, the guard
    // fails THIS run loudly instead of silently disarming.
    const r = run(TARGET);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("zero tests ran");
  });

  test("fixture temp dirs live in the launcher's scratch and die with the run", () => {
    // A test that leaks a fixture without cleaning up, exactly like a leaky
    // suite would, and reports where it landed.
    const dir = mkdtempSync(join(tmpdir(), "launcher-tmpdir-probe-"));
    try {
      const probe = join(dir, "probe.test.ts");
      writeFileSync(
        probe,
        [
          'import { test } from "bun:test";',
          'import { mkdtempSync, realpathSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          "// realpath throughout: process.cwd() is symlink-resolved (macOS /private/tmp).",
          'test("leak", () => {',
          '  console.error("TMPDIR=" + realpathSync(tmpdir()));',
          '  console.error("CWD=" + process.cwd());',
          '  console.error("FIXTURE=" + realpathSync(mkdtempSync(join(tmpdir(), "leaked-"))));',
          "});",
          "",
        ].join("\n"),
      );
      const r = run(probe);
      expect(r.code).toBe(0);
      const seen = Object.fromEntries(
        [...r.stderr.matchAll(/^(TMPDIR|CWD|FIXTURE)=(.+)$/gm)].map((m) => [m[1], m[2]]),
      );
      expect(Object.keys(seen).sort()).toEqual(["CWD", "FIXTURE", "TMPDIR"]);
      // The run got its own temp dir, the cwd sits one level below it (the
      // git ceiling), the fixture landed in it, and all of it is gone.
      expect(seen.TMPDIR).not.toBe(realpathSync(tmpdir()));
      expect(dirname(seen.CWD as string)).toBe(seen.TMPDIR);
      expect(dirname(seen.FIXTURE as string)).toBe(seen.TMPDIR);
      expect(() => lstatSync(seen.TMPDIR as string)).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a forced-color summary still counts: ANSI codes cannot hide a real run", () => {
    // Under FORCE_COLOR bun wraps the summary's timing bracket in SGR codes;
    // an ANSI-blind parse would misread the passing run as summary-less and
    // fail it.
    const r = runWithEnv({ FORCE_COLOR: "1" }, TARGET);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("refusing to report success");
  });
});
