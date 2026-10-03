import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../scripts/lib";
import { tempDirs } from "./helpers/temp-dirs";

const RUN = join(ROOT, ".github", "actions", "docs-probe", "run.mts");
const temp = tempDirs();

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

function repo(files: Record<string, string>): string {
  const root = temp.dir("docs-probe-action-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function runAction(root: string, inputs: Record<string, string>, cwd = root) {
  const proc = spawnSync("bun", [RUN], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ROOT: root, BASES: "", MAX_WORDS: "", SHAPE_ONLY: "", ...inputs },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

// The action is what a consumer pins by sha, so its contract is what these pin: how the
// inputs reach the probe, and that the probe's exit code and lines come back unchanged.
describe("the docs-probe action", () => {
  const files = {
    "README.md": "# R\n\nShort.\n",
    "docs/a.md": "# A\n\nThe sync writes `.github/workflows/checks.yml`.\n",
    "docs/b.md": `# B\n\n${words(71)}\n`,
    ".github/workflows/ci.yml": "",
    "files/base/.github/workflows/checks.yml": "",
  };

  test("globs expand under root, bases reach the probe, and its exit code and lines pass through", () => {
    const root = repo(files);
    const clean = runAction(root, { PAGES: "README.md docs/a.md", BASES: "files/base" });
    expect([clean.status, clean.stdout, clean.stderr]).toEqual([
      0,
      "docs-probe: 2 page(s) clean (cap 70 words)\n",
      "",
    ]);
    const findings = runAction(root, { PAGES: "README.md docs/*.md" });
    expect([findings.status, findings.stdout, findings.stderr]).toEqual([
      1,
      "",
      [
        "docs-probe: 2 finding(s)",
        "  docs/a.md:3: `.github/workflows/checks.yml` does not exist",
        "  docs/b.md:3: paragraph of 71 words; the cap is 70. Split it, or turn its facts into bullets, a table, or numbered steps",
        "",
      ].join("\n"),
    ]);
  });

  test("two spellings of one page count once", () => {
    const root = repo(files);
    const result = runAction(root, { PAGES: "README.md ./README.md" });
    expect([result.status, result.stdout, result.stderr]).toEqual([
      0,
      "docs-probe: 1 page(s) clean (cap 70 words)\n",
      "",
    ]);
  });

  test("max-words and shape-only reach the probe", () => {
    const root = repo(files);
    const result = runAction(root, { PAGES: "docs/*.md", MAX_WORDS: "80", SHAPE_ONLY: "true" });
    expect([result.status, result.stdout, result.stderr]).toEqual([
      0,
      "docs-probe: 2 page(s) clean (cap 80 words)\n",
      "",
    ]);
  });

  test("a root the scanner cannot read is a usage error, not a stack trace", () => {
    const root = repo(files);
    chmodSync(root, 0o000);
    try {
      // Spawned from elsewhere: a process cannot start inside a directory it cannot enter.
      const result = runAction(root, { PAGES: "*.md" }, ROOT);
      expect([
        result.status,
        result.stdout,
        result.stderr.startsWith("docs-probe action: "),
      ]).toEqual([2, "", true]);
      expect(result.stderr).not.toContain("    at ");
    } finally {
      chmodSync(root, 0o755);
    }
  });

  test.each([
    [
      "a pattern matching nothing",
      (_root: string) => ({ PAGES: "README.md guides/*.md" }),
      (root: string) => `pages pattern guides/*.md matches nothing under ${root}`,
    ],
    ["no pages", () => ({ PAGES: "" }), () => "the pages input is required"],
    [
      "a root that is not a directory",
      (root: string) => ({ PAGES: "README.md", ROOT: join(root, "README.md") }),
      (root: string) => `root ${join(root, "README.md")} is not a directory`,
    ],
    [
      "a root with a file in the middle of its path",
      (root: string) => ({ PAGES: "README.md", ROOT: join(root, "README.md", "child") }),
      (root: string) => `root ${join(root, "README.md", "child")} is not a directory`,
    ],
  ])("%s exits 2 and says why", (_name, inputs, message) => {
    const root = repo(files);
    const result = runAction(root, inputs(root));
    expect([result.status, result.stdout, result.stderr]).toEqual([
      2,
      "",
      `docs-probe action: ${message(root)}\n`,
    ]);
  });
});
