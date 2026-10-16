import { describe, expect, test } from "bun:test";
import { selectTests } from "../../scripts/check-staged.mts";

// The hook selects tests by following imports, by a skill's test folder, and by a root file's name,
// so what would drift silently is a selection that misses a dependency (a test whose script imports
// the staged module, a launcher module no test imports, a script a test runs by path) or one that
// over-selects on a generic name (`read.mts` once ran every test whose text contained "read").
const FILES = new Map<string, string>([
  ["scripts/lib.mts", "export const ROOT = 1;"],
  ["scripts/hermetic-git-env.mts", "export function hermeticGitEnv() {}"],
  [
    "scripts/run-tests.mts",
    'import { hermeticGitEnv } from "./hermetic-git-env.mts";\nimport { ROOT } from "./lib.mts";',
  ],
  ["scripts/catalog.mts", 'import { ROOT } from "./lib.mts";'],
  ["scripts/probe.ts", "export const probe = 1;"],
  // A quoted glob inside a fixture is not a declaration, nor is a reaches line below the first: only the first line selects by pattern.
  [
    "tests/repo/catalog.test.ts",
    'import { update } from "../../scripts/catalog.mts";\nconst text = `path: "*/*"\n// reaches: **/*.md\n`;',
  ],
  ["tests/repo/probe.test.ts", 'import { probe } from "../../scripts/probe";'],
  ["tests/repo/read.test.ts", 'const SCRIPT = join(ROOT, "scripts", "read.mts");'],
  // The name-rule control: "read" as a word, inside another word, and inside another file name, never the file itself.
  [
    "tests/repo/lib.test.ts",
    'import { readFileSync } from "node:fs";\nconst read = readFileSync("reread.mts");',
  ],
  [
    "tests/skills/watch-github/github-events.test.ts",
    'const SCRIPT = join(ROOT, "skills", "watch-github", "scripts", "github-events.mts");',
  ],
  [
    "tests/skills/worktree-hygiene/retire-branch.test.ts",
    'const READ = join(ROOT, "skills", "worktree-hygiene", "scripts", "retire", "read.mts");',
  ],
  ["tests/skills/project-naming/say.test.ts", 'const SAY = join(SCRIPTS, "columns", "say.mts");'],
  [
    "tests/skills/project-naming/cache.test.ts",
    'const CACHE = join(SCRIPTS, "core", "cache.mts");',
  ],
  [
    "tests/skills/working-text/docs-probe.test.ts",
    'const SCRIPT = join(ROOT, "skills", "working-text", "scripts", "docs-probe.mts");',
  ],
  [
    "tests/repo/usage-blocks.test.ts",
    "// reaches: **/*.md skills/*/scripts/**/*.mts\nconst pages = [];",
  ],
]);
const ALL = [...FILES.keys()].filter((p) => p.endsWith(".test.ts")).sort();
const USAGE = "tests/repo/usage-blocks.test.ts";

describe("selectTests", () => {
  test.each([
    [
      "a script selects the test that imports it",
      ["scripts/catalog.mts"],
      ["tests/repo/catalog.test.ts"],
    ],
    ["an extension-less import is followed", ["scripts/probe.ts"], ["tests/repo/probe.test.ts"]],
    ["a launcher module no test imports selects every test", ["scripts/hermetic-git-env.mts"], ALL],
    ["the preload selects every test even when it is not in the map", ["tests/preload.ts"], ALL],
    [
      "a root script, absent from the map as a deleted one is, selects every test naming its file name, not one with the stem as a word or inside another name",
      ["scripts/read.mts"],
      ["tests/repo/read.test.ts", "tests/skills/worktree-hygiene/retire-branch.test.ts"],
    ],
    [
      "a skill script selects its skill's tests and the test whose reaches line covers scripts, never a test elsewhere that names the same file name",
      ["skills/worktree-hygiene/scripts/retire/read.mts"],
      [USAGE, "tests/skills/worktree-hygiene/retire-branch.test.ts"],
    ],
    [
      "a skill script selects its skill's tests whether or not they name it",
      ["skills/project-naming/scripts/columns/say.mts"],
      [
        USAGE,
        "tests/skills/project-naming/cache.test.ts",
        "tests/skills/project-naming/say.test.ts",
      ],
    ],
    [
      "a skill module no test names selects its skill's tests",
      ["skills/watch-github/scripts/github/repository.mts"],
      [USAGE, "tests/skills/watch-github/github-events.test.ts"],
    ],
    [
      "a skill module whose stem is a common word selects its skill's tests only",
      ["skills/working-text/scripts/architecture/page.mts"],
      [USAGE, "tests/skills/working-text/docs-probe.test.ts"],
    ],
    [
      "a skill's page selects its skill's tests and the test whose reaches line covers pages",
      ["skills/watch-github/SKILL.md"],
      [USAGE, "tests/skills/watch-github/github-events.test.ts"],
    ],
    ["a staged test runs itself", [USAGE], [USAGE]],
    [
      "a SKILL.md of a skill with no tests selects the test whose reaches line covers pages, only",
      ["skills/unslop/SKILL.md"],
      [USAGE],
    ],
    [
      "a reference page selects the test whose reaches line covers pages",
      ["skills/orchestrator-mode/references/fleet-monitor.md"],
      [USAGE],
    ],
    [
      "a page selects by the reaches line, never by a glob quoted inside another test",
      ["docs/authoring.md"],
      [USAGE],
    ],
    ["a root file no test names selects nothing", ["ab.yml", "x.ts"], []],
    ["nothing staged selects nothing", [], []],
  ])("%s", (_name, staged, expected) => {
    expect(selectTests(staged, FILES)).toEqual(expected);
  });

  test("a shared module reaches tests through their scripts, not through the launcher alone", () => {
    // Without the launcher importing lib, the selection is exactly the import chains that reach it.
    const files = new Map(FILES);
    files.set("scripts/run-tests.mts", 'import { hermeticGitEnv } from "./hermetic-git-env.mts";');
    expect(selectTests(["scripts/lib.mts"], files)).toEqual(["tests/repo/catalog.test.ts"]);
  });
});
