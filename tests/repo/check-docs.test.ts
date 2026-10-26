// reaches: skills/working-text/scripts/docs-probe.mts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../../scripts/lib.mts";
import { tempDirs } from "../helpers/temp-dirs";

// The gate is a wrapper around the probe, so what would drift silently is the wrapper, not the
// probe: a probe exit it swallows, a --shape-only it drops, a page set that shrinks to nothing
// and passes vacuously, or a first set's failure that hides the second set's findings (a README
// path finding masked a 71-word skill paragraph, which only a reviewer caught).
//
// The gate spawns the probe, whose first run installs and bundles: under a loaded machine that passed
// bun's 5 s default, so every case gets what the suite gives its other spawned CLIs.

const SCRIPT = join(ROOT, "scripts", "check-docs.mts");
const CLI_TIMEOUT = 60_000;
const temp = tempDirs();

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const CLEAN = "# T\n\nShort.\n";
const LONG = `# T\n\n${words(71)}\n`;
const LONG_FINDING =
  "paragraph of 71 words; the cap is 70. Split it, or turn its facts into bullets, a table, or numbered steps";
const MISSING_PATH = "# S\n\nRead `docs/gone.md` in your repository.\n";
const MISSING_PATH_FINDING = "`docs/gone.md` does not exist";

const TREE: Record<string, string> = {
  // One page per pattern of both sets.
  "README.md": CLEAN,
  "CONTRIBUTING.md": CLEAN,
  "docs/guide.md": CLEAN,
  "skills/README.md": CLEAN,
  "skills/one/README.md": CLEAN,
  "memories/note.md": CLEAN,
  "template/README.md": CLEAN,
  "template/references/ref.md": CLEAN,
  // The skill page names a missing file under a real directory, which only the path check sees.
  "skills/one/SKILL.md": MISSING_PATH,
  "skills/one/references/ref.md": CLEAN,
  "skills/one/references/languages/nested.md": CLEAN,
  "template/SKILL.md": CLEAN,
};

function run(root: string) {
  const proc = spawnSync("bun", [SCRIPT, root], { encoding: "utf8" });
  return [proc.status, proc.stdout, proc.stderr.replaceAll(root, "<root>")];
}

function tree(overrides: Record<string, string | null>): string {
  const root = temp.dir("check-docs-");
  for (const [path, content] of Object.entries({ ...TREE, ...overrides })) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("check-docs", () => {
  test.each([
    [
      "a clean tree exits 0, and the skill set runs shape-only (its missing path is no finding)",
      {},
      [
        0,
        "docs-probe: 8 page(s) clean (cap 70 words)\ndocs-probe: 4 page(s) clean (cap 70 words)\n",
        "",
      ],
    ],
    [
      "a long paragraph in a repository page exits 1 with the probe's finding, and the second set still runs",
      { "README.md": LONG },
      [
        1,
        "docs-probe: 4 page(s) clean (cap 70 words)\n",
        `docs-probe: 1 finding(s)\n  README.md:3: ${LONG_FINDING}\n`,
      ],
    ],
    [
      "a long paragraph in a nested skill reference page exits 1 after the first set passed: shape-only still counts words",
      { "skills/one/references/languages/nested.md": LONG },
      [
        1,
        "docs-probe: 8 page(s) clean (cap 70 words)\n",
        `docs-probe: 1 finding(s)\n  skills/one/references/languages/nested.md:3: ${LONG_FINDING}\n`,
      ],
    ],
    [
      "a README path finding and a long skill paragraph both print before the exit 1: the first set's failure never hides the second's",
      { "README.md": MISSING_PATH, "skills/one/references/languages/nested.md": LONG },
      [
        1,
        "",
        `docs-probe: 1 finding(s)\n  README.md:3: ${MISSING_PATH_FINDING}\ndocs-probe: 1 finding(s)\n  skills/one/references/languages/nested.md:3: ${LONG_FINDING}\n`,
      ],
    ],
    [
      "a pattern matching no page exits 2 naming it, before any probe runs",
      { "memories/note.md": null },
      [2, "", "check-docs: memories/*.md matches no page under <root>\n"],
    ],
  ])(
    "%s",
    (_name, overrides, expected) => {
      expect(run(tree(overrides))).toEqual(expected);
    },
    CLI_TIMEOUT,
  );
});
