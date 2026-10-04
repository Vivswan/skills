import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../scripts/lib";
import {
  pathCandidate,
  probePage,
  scanPage,
  wordCount,
} from "../skills/working-text/scripts/docs-probe.mts";
import { tempDirs } from "./helpers/temp-dirs";

const PROBE = join(ROOT, "skills", "working-text", "scripts", "docs-probe.mts");
const temp = tempDirs();

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

function repo(files: Record<string, string>): string {
  const root = temp.dir("docs-probe-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function runProbe(cwd: string, ...args: string[]) {
  const proc = spawnSync("bun", [PROBE, ...args], { cwd, encoding: "utf8" });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

const units = (page: string) => scanPage(page).units.map((u) => [u.kind, u.line, u.text] as const);

describe("what Markdown renders as prose", () => {
  // Bun's renderer decides block structure; each row is a shape a line-based
  // reading got wrong in review, with the units the renderer yields for it.
  test.each([
    ["indented code", `# T\n\n    ${words(71)}\n\nafter\n`, [["paragraph", 5, "after"]]],
    ["a setext heading", `${words(71)}\n======\n\nafter\n`, [["paragraph", 4, "after"]]],
    [
      "a table without leading pipes",
      `a | b\n--- | ---\n${words(71)} | 2\n\nafter\n`,
      [["paragraph", 5, "after"]],
    ],
    [
      "a multi-line HTML comment",
      `<!--\n${words(71)}\n-->\n\nafter\n`,
      [["paragraph", 5, "after"]],
    ],
    ["a pre block", `<pre>\n${words(71)}\n</pre>\n\nafter\n`, [["paragraph", 5, "after"]]],
    [
      "a fence inside a list item does not swallow the next paragraph (a loose item's text is a paragraph)",
      "- item\n\n  ```text\n  code\n  ```\n\nafter\n",
      [
        ["paragraph", 1, "item"],
        ["paragraph", 7, "after"],
      ],
    ],
    ["LF front matter", "---\ntitle: x\n---\n\nafter\n", [["paragraph", 5, "after"]]],
    ["CRLF front matter", "---\r\ntitle: x\r\n---\r\n\r\nafter\r\n", [["paragraph", 5, "after"]]],
    [
      "a generated region",
      "before\n\n<!-- BEGIN GENERATED: m -->\ngenerated words\n<!-- END GENERATED: m -->\n\nafter\n",
      [
        ["paragraph", 1, "before"],
        ["paragraph", 7, "after"],
      ],
    ],
    [
      "a generated-region marker quoted in a fence is code and hides nothing",
      "```markdown\n<!-- BEGIN GENERATED: example -->\n```\n\nafter\n",
      [["paragraph", 5, "after"]],
    ],
    [
      "a lone leading --- is a thematic break, not front matter",
      "---\n\n# Guide\n\nafter\n",
      [["paragraph", 5, "after"]],
    ],
    [
      "raw HTML that merely contains the words BEGIN GENERATED opens no region",
      "<div>BEGIN GENERATED</div>\n\nafter\n",
      [["paragraph", 3, "after"]],
    ],
    [
      "a BEGIN whose END carries another name, or none, hides nothing",
      "<!-- BEGIN GENERATED: a -->\n\nkept\n\n<!-- END GENERATED: b -->\n\nafter\n",
      [
        ["paragraph", 3, "kept"],
        ["paragraph", 7, "after"],
      ],
    ],
    [
      "a paragraph inside a blockquote, once",
      "> quoted words\n",
      [["paragraph", 1, "quoted words"]],
    ],
    [
      "nested list items, each once",
      "- outer\n  - inner one\n  - inner two\n",
      [
        ["item", 1, "outer"],
        ["item", 2, "inner one"],
        ["item", 3, "inner two"],
      ],
    ],
    [
      "a heading with the same words does not take the line of the paragraph after it",
      "# Same words\n\nSame words again here.\n",
      [["paragraph", 3, "Same words again here."]],
    ],
    [
      "a paragraph led by bold or a link is found on its own line",
      "# T\n\n**Important** words here.\n\n[read](x.md) this too.\n",
      [
        ["paragraph", 3, "Important words here."],
        ["paragraph", 5, "read this too."],
      ],
    ],
    [
      "a two-line paragraph keeps its first line",
      "# T\n\nA paragraph\non two lines.\n",
      [["paragraph", 3, "A paragraph\non two lines."]],
    ],
  ])("%s", (_name, page, expected) => {
    expect(units(page)).toEqual(expected as never);
  });

  test("inline HTML is invisible: a comment adds no words and a br joins two halves as one paragraph", () => {
    expect(
      wordCount(scanPage(`${words(70)} <!-- hidden words here -->\n`).units[0]?.text ?? ""),
    ).toBe(70);
    expect(wordCount(scanPage(`${words(35)}<br>${words(36)}\n`).units[0]?.text ?? "")).toBe(71);
    expect(wordCount(scanPage(`${words(70)} <!-<!-- x -->- y -->\n`).units[0]?.text ?? "")).toBe(
      70,
    );
  });

  test("markup is not prose: a link counts its label, a code span its text, an image nothing", () => {
    const page = `${words(69)} [read](README.md "the title") \`x/y.ts\` ![alt text here](p.png)\n`;
    const [unit] = scanPage(page).units;
    expect(wordCount(unit?.text ?? "")).toBe(71);
    expect(scanPage(page).codespans).toEqual([{ text: "x/y.ts", line: 1 }]);
    expect(scanPage(page).links).toEqual([{ href: "README.md", line: 1 }]);
  });
});

describe("the word cap", () => {
  const options = { root: "/nowhere", maxWords: 70, paths: false };

  test("71 words is a finding at its line and 70 is not, for a paragraph and for a list item", () => {
    const page = `# T\n\n${words(70)}\n\n${words(71)}\n\n- ${words(70)}\n- ${words(71)}\n`;
    expect(probePage(page, "p.md", options).map((f) => [f.line, f.message.split(";")[0]])).toEqual([
      [5, "paragraph of 71 words"],
      [8, "list item of 71 words"],
    ]);
  });
});

describe("pathCandidate", () => {
  test.each([
    ["a slash path with an extension", "src/a.ts", "src/a.ts"],
    ["a long extension", "skills/gone.svelte", "skills/gone.svelte"],
    ["a line reference", "src/a.ts:12", "src/a.ts"],
    ["a line range followed by a comma", "src/a.ts:12-30,", "src/a.ts"],
    ["a page-relative path", "./x.md", "./x.md"],
    ["a directory with a trailing slash", "docs/", "docs"],
    ["a placeholder", "<skill-dir>/scripts/x.mts", null],
    ["a star glob", "src/**/*.ts", null],
    ["a character-class glob", "skills/[ab].ts", null],
    ["an owner/repo slug", "Vivswan/skills", null],
    ["a bare file name", "package.json", null],
    ["an absolute path", "/tmp/x.txt", null],
    ["a home path", "~/.codex/config.toml", null],
    ["a flag with a path argument", "--page docs/x.md", null],
    ["a URL", "https://example.com/a.md", null],
  ])("%s", (_name, token, expected) => {
    expect(pathCandidate(token)).toBe(expected);
  });
});

describe("the path check", () => {
  const options = (root: string) => ({ root, maxWords: 70, paths: true });

  test("a missing path under a real top-level directory is a finding; an existing one and a foreign layout are not", () => {
    const root = repo({ "docs/page.md": "", "src/here.ts": "" });
    const page = "See `src/gone.ts`, `src/here.ts`, and `agents/openai.yaml` (another layout).\n";
    expect(probePage(page, "docs/page.md", options(root))).toEqual([
      { file: "docs/page.md", line: 1, message: "`src/gone.ts` does not exist" },
    ]);
  });

  test("a path resolves against the page's directory and every directory up to the root", () => {
    const root = repo({
      "skills/x/references/r.md": "",
      "skills/x/scripts/run.mts": "",
      "scripts/other.mts": "",
    });
    const page = "Run `scripts/run.mts`; `scripts/gone.mts` is not there.\n";
    expect(
      probePage(page, "skills/x/references/r.md", options(root)).map((f) => f.message),
    ).toEqual(["`scripts/gone.mts` does not exist"]);
  });

  test("--base adds a tree a page's paths also resolve against; a path missing there is still a finding", () => {
    // A platform repository ships `.github/workflows/checks.yml` under files/base/ for OTHER
    // repositories, while its own `.github/` exists too, so the foreign-layout exemption cannot fire.
    const root = repo({
      "docs/page.md": "",
      ".github/workflows/ci.yml": "",
      "files/base/.github/workflows/checks.yml": "",
    });
    const page =
      "The sync writes `.github/workflows/checks.yml` and `.github/workflows/gone.yml`.\n";
    expect(probePage(page, "docs/page.md", options(root)).map((f) => f.message)).toEqual([
      "`.github/workflows/checks.yml` does not exist",
      "`.github/workflows/gone.yml` does not exist",
    ]);
    const base = join(root, "files", "base");
    expect(
      probePage(page, "docs/page.md", { ...options(root), bases: [base] }).map((f) => f.message),
    ).toEqual(["`.github/workflows/gone.yml` does not exist"]);
    writeFileSync(join(root, "docs", "page.md"), page);
    const cli = runProbe(root, "--base", "files/base", "docs/page.md");
    expect([cli.status, cli.stdout, cli.stderr]).toEqual([
      1,
      "",
      "docs-probe: 1 finding(s)\n  docs/page.md:1: `.github/workflows/gone.yml` does not exist\n",
    ]);
  });

  test("link destinations in every Markdown form are checked from the page; a link quoted in a code span is not", () => {
    const root = repo({ "docs/a.md": "", "docs/b.md": "" });
    const page = [
      "[b](b.md#top), [angle](<b.md>), [titled](gone-1.md 'title'), [site](https://example.com/x.md), [here](#anchor), [ref][r], `[q](./gone-2.md)`.",
      "",
      "[r]: ../gone-3.md",
    ].join("\n");
    expect(probePage(page, "docs/a.md", options(root)).map((f) => f.message)).toEqual([
      "link target gone-1.md does not exist",
      "link target ../gone-3.md does not exist",
    ]);
  });

  test("a query string and percent escapes still address the file", () => {
    const root = repo({ "docs/a.md": "", "docs/b.md": "" });
    const page = "[q](b.md?plain=1) [e](b%2Emd) [g](gone%2Emd)\n";
    expect(probePage(page, "docs/a.md", options(root)).map((f) => f.message)).toEqual([
      "link target gone.md does not exist",
    ]);
  });
});

describe("repository containment", () => {
  test("a path or link that resolves to an existing file outside the repository escapes, it does not pass", () => {
    const root = repo({ "docs/a.md": "" });
    const page =
      "See `../../../../../../../../etc/passwd` and [p](../../../../../../../../etc/passwd).\n";
    expect(
      probePage(page, "docs/a.md", { root, maxWords: 70, paths: true }).map((f) => f.message),
    ).toEqual([
      "`../../../../../../../../etc/passwd` escapes the repository",
      "link target ../../../../../../../../etc/passwd escapes the repository",
    ]);
  });

  test("a directory whose name starts with two dots is inside the repository, not a parent escape", () => {
    const root = repo({ "docs/a.md": "", "..vendor/a.ts": "" });
    expect(
      probePage("See `..vendor/a.ts`.\n", "docs/a.md", { root, maxWords: 70, paths: true }),
    ).toEqual([]);
  });

  test("a link to the repository root itself is inside the repository", () => {
    const root = repo({ "docs/a.md": "" });
    expect(probePage("[root](..)\n", "docs/a.md", { root, maxWords: 70, paths: true })).toEqual([]);
  });
});

describe("paths outside prose", () => {
  test("a path in a table cell or a link in a heading is checked, and neither counts as words", () => {
    const root = repo({ "docs/a.md": "", "src/here.ts": "" });
    const page =
      "# See [gone](gone.md)\n\n| File |\n| --- |\n| `src/gone.ts` |\n| `src/here.ts` |\n";
    const findings = probePage(page, "docs/a.md", { root, maxWords: 70, paths: true });
    expect(findings.map((f) => [f.line, f.message])).toEqual([
      [1, "link target gone.md does not exist"],
      [5, "`src/gone.ts` does not exist"],
    ]);
    expect(scanPage(page).units).toEqual([]);
  });
});

describe("the CLI", () => {
  test("clean pages exit 0 with the count line; findings exit 1 as page:line: message relative to --root", () => {
    const root = repo({
      "README.md": "# R\n\nShort.\n",
      "docs/g.md": `# G\n\n${words(71)}\n\nSee \`docs/gone.md\`.\n`,
    });
    const clean = runProbe(root, "README.md");
    expect([clean.status, clean.stdout]).toEqual([
      0,
      "docs-probe: 1 page(s) clean (cap 70 words)\n",
    ]);
    const found = runProbe(root, "--root", root, "docs/g.md");
    expect(found.status).toBe(1);
    expect(found.stderr.split("\n")).toEqual([
      "docs-probe: 2 finding(s)",
      "  docs/g.md:3: paragraph of 71 words; the cap is 70. Split it, or turn its facts into bullets, a table, or numbered steps",
      "  docs/g.md:5: `docs/gone.md` does not exist",
      "",
    ]);
  });

  test("the usage line names the probe's own file: a vendored copy prints its name, an importer does not print its own", () => {
    // A platform repository vendored the script as docs_probe.ts and its usage line still said docs-probe.mts.
    const usage = (name: string) =>
      [
        `usage: ${name} [--root <dir>] [--base <dir>]... [--max-words <n>] [--shape-only] <page.md>...`,
        "  --root        the repository root paths resolve against (default: cwd)",
        "  --base        a directory under the root that paths also resolve against (repeatable)",
        "  --max-words   the cap on a paragraph or list item (default: 70)",
        "  --shape-only  word counts only; skip the check that named paths exist",
        "exit 0: every page is clean; 1: findings, one per line as page:line: message; 2: usage or an unreadable page",
      ].join("\n");
    const root = repo({ "a.md": "" });
    const copy = join(root, "docs_probe.ts");
    copyFileSync(PROBE, copy);
    const renamed = spawnSync("bun", [copy], { cwd: root, encoding: "utf8" });
    expect([renamed.status, renamed.stdout, renamed.stderr]).toEqual([
      2,
      "",
      `docs-probe: ${usage("docs_probe.ts")}\n`,
    ]);
    const importer = spawnSync(
      "bun",
      ["-e", `import { parseArgs } from ${JSON.stringify(PROBE)}; parseArgs([]);`],
      { cwd: root, encoding: "utf8" },
    );
    // Bun prints its own stack frames around the thrown message; the usage block between them is the contract.
    const lines = importer.stderr.split("\n");
    const from = lines.findIndex((l) => l.startsWith("error: usage:"));
    const block = lines.slice(from, from + 6).join("\n");
    expect([importer.status, importer.stdout, block]).toEqual([
      1,
      "",
      `error: ${usage("docs-probe.mts")}`,
    ]);
  });

  test.each([
    ["a --root that is not a directory", ["--root", "package.json", "a.md"], /is not a directory/],
    ["a --base that is not a directory", ["--base", "package.json", "a.md"], /is not a directory/],
    ["a --base outside the root", ["--base", "..", "a.md"], /is outside the root/],
    ["a page that is a directory", ["docs"], /is not a readable file/],
    ["no pages", [], /usage: docs-probe\.mts/],
  ])("%s exits 2 and says why", (_name, args, message) => {
    const root = repo({ "a.md": "", "package.json": "{}", "docs/x.md": "" });
    const result = runProbe(root, ...args);
    expect([result.status, message.test(result.stderr)]).toEqual([2, true]);
  });
});
