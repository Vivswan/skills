import { describe, expect, test } from "bun:test";
import { selectTests } from "../scripts/check-staged.mts";

// The hook selects tests by following imports and by name, so what would drift silently is a
// selection that misses a dependency: a test whose script imports the staged module, a launcher
// module no test imports, or a script a test runs by path.
const FILES = new Map<string, string>([
  ["scripts/lib.ts", "export const ROOT = 1;"],
  ["scripts/hermetic-git-env.ts", "export function hermeticGitEnv() {}"],
  [
    "scripts/run-tests.ts",
    'import { hermeticGitEnv } from "./hermetic-git-env";\nimport { ROOT } from "./lib";',
  ],
  ["scripts/sync-xeno.mts", 'import { ROOT } from "./lib";'],
  ["scripts/probe.ts", "export const probe = 1;"],
  ["tests/sync-xeno.test.ts", 'import { update } from "../scripts/sync-xeno.mts";'],
  ["tests/probe.test.ts", 'import { probe } from "../scripts/probe";'],
  [
    "tests/watch-ci-script.test.ts",
    'const SCRIPT = join(ROOT, "skills", "watch-ci-after-push", "scripts", "watch-ci.sh");',
  ],
  [
    "tests/doc-drift.test.ts",
    'const SKILL = join(ROOT, "skills", "rubber-duck-review", "SKILL.md");',
  ],
]);
const ALL = [...FILES.keys()].filter((p) => p.endsWith(".test.ts")).sort();

describe("selectTests", () => {
  test.each([
    [
      "a script selects the test that imports it",
      ["scripts/sync-xeno.mts"],
      ["tests/sync-xeno.test.ts"],
    ],
    ["an extension-less import is followed", ["scripts/probe.ts"], ["tests/probe.test.ts"]],
    ["a launcher module no test imports selects every test", ["scripts/hermetic-git-env.ts"], ALL],
    ["the preload selects every test even when it is not in the map", ["tests/preload.ts"], ALL],
    [
      "a skill script run by path selects the test that names it",
      ["skills/watch-ci-after-push/scripts/watch-ci.sh"],
      ["tests/watch-ci-script.test.ts"],
    ],
    ["a staged test runs itself", ["tests/doc-drift.test.ts"], ["tests/doc-drift.test.ts"]],
    [
      "a deleted script, absent from the map, still selects the test that names it",
      ["scripts/gone.mts", "skills/watch-ci-after-push/scripts/watch-ci.sh"],
      ["tests/watch-ci-script.test.ts"],
    ],
    [
      "a SKILL.md selects the doc pin only",
      ["skills/unslop/SKILL.md"],
      ["tests/doc-drift.test.ts"],
    ],
    ["a stem under three characters selects nothing", ["ab.md", "x.ts"], []],
    ["nothing staged selects nothing", [], []],
  ])("%s", (_name, staged, expected) => {
    expect(selectTests(staged, FILES)).toEqual(expected);
  });

  test("a shared module reaches tests through their scripts, not through the launcher alone", () => {
    // Without the launcher importing lib, the selection is exactly the import chains that reach it.
    const files = new Map(FILES);
    files.set("scripts/run-tests.ts", 'import { hermeticGitEnv } from "./hermetic-git-env";');
    expect(selectTests(["scripts/lib.ts"], files)).toEqual(["tests/sync-xeno.test.ts"]);
  });
});
