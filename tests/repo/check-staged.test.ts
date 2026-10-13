import { describe, expect, test } from "bun:test";
import { selectTests } from "../../scripts/check-staged.mts";

// The hook selects tests by following imports and by name, so what would drift silently is a
// selection that misses a dependency: a test whose script imports the staged module, a launcher
// module no test imports, or a script a test runs by path.
const FILES = new Map<string, string>([
  ["scripts/lib.mts", "export const ROOT = 1;"],
  ["scripts/hermetic-git-env.mts", "export function hermeticGitEnv() {}"],
  [
    "scripts/run-tests.mts",
    'import { hermeticGitEnv } from "./hermetic-git-env.mts";\nimport { ROOT } from "./lib.mts";',
  ],
  ["scripts/sync-xeno.mts", 'import { ROOT } from "./lib.mts";'],
  ["scripts/probe.ts", "export const probe = 1;"],
  ["tests/repo/sync-xeno.test.ts", 'import { update } from "../../scripts/sync-xeno.mts";'],
  ["tests/repo/probe.test.ts", 'import { probe } from "../../scripts/probe";'],
  [
    "tests/skills/watch-github/github-events.test.ts",
    'const SCRIPT = join(ROOT, "skills", "watch-github", "scripts", "github-events.mts");',
  ],
  [
    "tests/repo/doc-drift.test.ts",
    'const SKILL = join(ROOT, "skills", "rubber-duck-review", "SKILL.md");',
  ],
]);
const ALL = [...FILES.keys()].filter((p) => p.endsWith(".test.ts")).sort();

describe("selectTests", () => {
  test.each([
    [
      "a script selects the test that imports it",
      ["scripts/sync-xeno.mts"],
      ["tests/repo/sync-xeno.test.ts"],
    ],
    ["an extension-less import is followed", ["scripts/probe.ts"], ["tests/repo/probe.test.ts"]],
    ["a launcher module no test imports selects every test", ["scripts/hermetic-git-env.mts"], ALL],
    ["the preload selects every test even when it is not in the map", ["tests/preload.ts"], ALL],
    [
      "a skill script run by path selects the test that names it",
      ["skills/watch-github/scripts/github-events.mts"],
      ["tests/skills/watch-github/github-events.test.ts"],
    ],
    [
      "a staged test runs itself",
      ["tests/repo/doc-drift.test.ts"],
      ["tests/repo/doc-drift.test.ts"],
    ],
    [
      "a deleted script, absent from the map, still selects the test that names it",
      ["scripts/gone.mts", "skills/watch-github/scripts/github-events.mts"],
      ["tests/skills/watch-github/github-events.test.ts"],
    ],
    [
      "a SKILL.md selects the doc pin only",
      ["skills/unslop/SKILL.md"],
      ["tests/repo/doc-drift.test.ts"],
    ],
    ["a stem under three characters selects nothing", ["ab.md", "x.ts"], []],
    ["nothing staged selects nothing", [], []],
  ])("%s", (_name, staged, expected) => {
    expect(selectTests(staged, FILES)).toEqual(expected);
  });

  test("a shared module reaches tests through their scripts, not through the launcher alone", () => {
    // Without the launcher importing lib, the selection is exactly the import chains that reach it.
    const files = new Map(FILES);
    files.set("scripts/run-tests.mts", 'import { hermeticGitEnv } from "./hermetic-git-env.mts";');
    expect(selectTests(["scripts/lib.mts"], files)).toEqual(["tests/repo/sync-xeno.test.ts"]);
  });
});
