#!/usr/bin/env bun

/**
 * Test launcher behind `bun run test`: runs `bun test` inside the hermetic
 * git environment (see scripts/hermetic-git-env.ts for why the environment
 * must exist before the test process is born). Extra arguments replace the
 * default `tests` target, so `bun run test tests/foo.test.ts` runs one file.
 *
 * The test process starts in a scratch directory OUTSIDE the repository:
 * GIT_CEILING_DIRECTORIES never protects the starting directory itself, so
 * with cwd at the repo root a git spawned with neither `env` nor `cwd` would
 * still discover and mutate the real repository. From the scratch cwd such a
 * spawn dies in a ceilinged non-repo directory instead. bunfig.toml is not
 * discovered from the scratch cwd, so the preload - which verifies this
 * birth environment - is passed explicitly.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticGitEnv } from "./hermetic-git-env";
import { ROOT } from "./lib";

// Path-like arguments are resolved against the repository root (the scratch
// cwd contains no tests); flags and name filters pass through untouched.
// Known limits of the scratch cwd: flags that WRITE repo-relative outputs
// (--coverage-dir, reporter files) or discover the repo from the cwd
// (--changed) would need absolute paths; nothing in this repo uses them.
// The zero-test guard below is the fail-closed backstop for every flag that
// can shrink the run to nothing (--pass-with-no-tests, --only with no .only
// tests, an option value that happens to name a real path and suppresses
// the default target).

// Only an argument naming a real path counts as a target: bun test ORs
// positional filters together, and a bare word can be an option's value
// (--test-name-pattern baz) just as well as a name filter, so anything that
// is not a real path gets the default target appended - over-running is
// safe, a scratch-cwd invocation left with no target is not.
let hasPathTarget = false;
const args = process.argv.slice(2).map((arg) => {
  const resolved = resolve(ROOT, arg);
  if (existsSync(resolved)) {
    hasPathTarget = true;
    return resolved;
  }
  return arg;
});
if (!hasPathTarget) args.push(join(ROOT, "tests"));

const scratch = mkdtempSync(join(tmpdir(), "hermetic-tests-"));
let status: number;
let summary = "";
try {
  const child = Bun.spawn(
    ["bun", "test", "--preload", join(ROOT, "tests", "preload.ts"), ...args],
    {
      cwd: scratch,
      env: hermeticGitEnv(process.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "pipe",
    },
  );
  // Tee stderr (where bun test reports results) while keeping a copy: the
  // zero-test check below needs the "Ran N tests" summary line.
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    process.stderr.write(chunk);
    summary += decoder.decode(chunk, { stream: true });
  }
  summary += decoder.decode();
  status = await child.exited;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// A run of zero tests must fail HOWEVER it was reached: bun exits 1 when no
// test file matches, but exits 0 with "Ran 0 tests" for --pass-with-no-tests
// and for --only with no .only test - a vacuous green from a test launcher.
// ANSI color sequences are stripped first (under FORCE_COLOR bun wraps the
// summary's timing bracket in SGR codes, which would hide a genuine summary
// and fail a passing run). The match is anchored to a full line-start
// summary with bun's timing suffix, and the LAST one wins: bun echoes CLI
// values mid-line in its own diagnostics (-t "Ran 1 test across " appears
// inside an "error: regex ..." line), so an unanchored search could be
// spoofed into seeing tests that never ran. A missing summary on exit 0
// fails too, so a bun wording change breaks loudly here instead of silently
// disarming the guard.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC escape is exactly what is being stripped
const plain = summary.replace(/\u001b\[[0-9;]*m/g, "");
const ran = [...plain.matchAll(/(?:^|\n)Ran (\d+) tests? across \d+ files?\. \[/g)].at(-1);
if (status === 0 && (ran === undefined || Number(ran[1]) === 0)) {
  console.error(
    ran === undefined
      ? "run-tests: bun test exited 0 without a 'Ran N tests' summary; refusing to report success."
      : "run-tests: zero tests ran; a run that tests nothing must not pass.",
  );
  status = 1;
}
// exitCode, not process.exit(): an explicit exit can truncate stdio still
// draining to pipes (large failure output), and nothing here holds the event
// loop open once the child has exited.
process.exitCode = status;
