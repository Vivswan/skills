import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../scripts/lib";
import { tempDirs } from "./helpers/temp-dirs";

// The gate is a wrapper around the probe, so what would drift silently is the wrapper, not the
// probe: a probe exit it swallows, a --shape-only it drops, or a page set that shrinks to nothing
// and passes vacuously.
const SCRIPT = join(ROOT, "scripts", "check-docs.mts");
const temp = tempDirs();

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const CLEAN = "# T\n\nShort.\n";
const LONG = `# T\n\n${words(71)}\n`;
const LONG_FINDING =
  "paragraph of 71 words; the cap is 70. Split it, or turn its facts into bullets, a table, or numbered steps";

/** One page per pattern of both sets; the skill page names a missing file under a real directory, which only the path check sees. */
const TREE: Record<string, string> = {
  "README.md": CLEAN,
  "CONTRIBUTING.md": CLEAN,
  "docs/guide.md": CLEAN,
  "xeno/README.md": CLEAN,
  "skills/README.md": CLEAN,
  "skills/one/README.md": CLEAN,
  "memories/note.md": CLEAN,
  "template/README.md": CLEAN,
  "template/references/ref.md": CLEAN,
  "skills/one/SKILL.md": "# S\n\nRead `docs/gone.md` in your repository.\n",
  "skills/one/references/ref.md": CLEAN,
  "template/SKILL.md": CLEAN,
};

function tree(overrides: Record<string, string | null>): string {
  const root = temp.dir("check-docs-");
  for (const [path, content] of Object.entries({ ...TREE, ...overrides })) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(root: string) {
  const proc = spawnSync("bun", [SCRIPT, root], { encoding: "utf8" });
  return [proc.status, proc.stdout, proc.stderr.replaceAll(root, "<root>")];
}

describe("check-docs", () => {
  test.each([
    [
      "a clean tree exits 0, and the skill set runs shape-only (its missing path is no finding)",
      {},
      [
        0,
        "docs-probe: 9 page(s) clean (cap 70 words)\ndocs-probe: 3 page(s) clean (cap 70 words)\n",
        "",
      ],
    ],
    [
      "a long paragraph in a repository page exits 1 with the probe's finding, and the second set does not run",
      { "README.md": LONG },
      [1, "", `docs-probe: 1 finding(s)\n  README.md:3: ${LONG_FINDING}\n`],
    ],
    [
      "a long paragraph in a skill page exits 1 after the first set passed: shape-only still counts words",
      { "skills/one/references/ref.md": LONG },
      [
        1,
        "docs-probe: 9 page(s) clean (cap 70 words)\n",
        `docs-probe: 1 finding(s)\n  skills/one/references/ref.md:3: ${LONG_FINDING}\n`,
      ],
    ],
    [
      "a pattern matching no page exits 2 naming it, before any probe runs",
      { "memories/note.md": null },
      [2, "", "check-docs: memories/*.md matches no page under <root>\n"],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(run(tree(overrides))).toEqual(expected);
  });
});
