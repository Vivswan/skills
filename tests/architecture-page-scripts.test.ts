import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";
import { importSpecifiers } from "../skills/architecture-page/scripts/arch-lint.mts";

// Contract tests for the architecture-page scripts against a small fixture
// tree. Every CLI case asserts the whole outcome (exit code, full stdout, full
// stderr), so a message the SKILL.md quotes cannot drift unseen; each way the
// declaration or the page can be wrong is seen failing, and the matching tree
// and page are seen passing.

const SCRIPTS = join(ROOT, "skills", "architecture-page", "scripts");
const ARCH_LINT = join(SCRIPTS, "arch-lint.mts");
const RENDER = join(SCRIPTS, "render-architecture-map.mts");
const CHECK_PAGE = join(SCRIPTS, "check-architecture-page.mts");

const CONFIG = `layers:
  main: [src/main.ts]
  engine: [src/engine/]
  types: [src/types.ts]
exclude:
  - "src/**/*.test.ts"
  - "src/**/mock.ts"
edges:
  main: [engine]
  engine: [types]
`;

const MAP = `graph TD
  main["src/main.ts"]
  engine["src/engine/"]
  types["src/types.ts"]
  main --> engine
  engine --> types`;

const FILES: Record<string, string> = {
  "architecture.yml": CONFIG,
  "src/main.ts": 'import { run } from "./engine/run.ts";\nrun();\n',
  "src/engine/run.ts": [
    'import type { Config } from "../types.ts";',
    "export function run(config?: Config): void {",
    "  void config;",
    "}",
    "function oldName(): void {}",
    "export { oldName as newName };",
    "export const first = 1,",
    "  second = 2;",
    "/* export const hidden = 1; */",
    "export default function main(): void {}",
    "",
  ].join("\n"),
  "src/engine/index.ts": 'export * from "./run.ts";\nexport * as ns from "./mock.ts";\n',
  "src/engine/cycle-a.ts": 'export * from "./cycle-b.ts";\nexport const fromA = 1;\n',
  "src/engine/cycle-b.ts": 'export * from "./cycle-a.ts";\nexport const fromB = 1;\n',
  "src/engine/mock.ts": "export const mock = 1;\n",
  "src/engine/run.test.ts":
    'import { run } from "./run.ts";\nimport { helper } from "../../test/helper.ts";\nrun();\nvoid helper;\n',
  "src/types.ts": "export interface Config {\n  name: string;\n}\n",
  "test/helper.ts": "export const helper = 1;\n",
  "test/engine/run.test.ts": "export const covered = true;\n",
  "docs/.keep": "",
};

let scratch: string;
let fixture: string;

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

/** A copy of the fixture tree under `name`, with `files` written over it (a config variant, an extra source file). */
function variant(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  cpSync(fixture, root, { recursive: true });
  writeTree(root, files);
  return root;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[], cwd: string): Outcome {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const USAGE = {
  lint: [
    "usage: arch-lint.mts [--config <architecture.yml>] [--root <dir>] [--mermaid]",
    "  --config   the layering declaration (default: <root>/architecture.yml)",
    "  --root     the repository root the paths are relative to (default: cwd)",
    "  --mermaid  print the module map instead of linting",
    "exit 0: the tree matches the declaration; 1: forbidden or stale edges; 2: usage or an unreadable graph",
  ].join("\n"),
  render: [
    "usage: render-architecture-map.mts --page <path> [--config <architecture.yml>] [--root <dir>] [--region <name>] [--check]",
    "  --page     the markdown page carrying the generated region",
    "  --config   the layering declaration (default: <root>/architecture.yml)",
    "  --root     the repository root (default: cwd)",
    "  --region   the generated region's name (default: architecture-map)",
    "  --check    exit 1 when the committed region differs, instead of rewriting it",
    "exit 0: written or already current; 1: drift under --check; 2: usage, no region, or an unreadable declaration",
  ].join("\n"),
  page: [
    "usage: check-architecture-page.mts --page <path> [--root <dir>] [--repo-url <prefix>] [--expect-diagrams <n>]",
    "  --page             the architecture page to check",
    "  --root             the repository root the label paths are relative to (default: cwd)",
    "  --repo-url         the URL prefix an absolute demonstration link maps onto the root with",
    "                     (e.g. https://github.com/owner/repo/blob/main/); relative links resolve from the page",
    "  --expect-diagrams  the number of concept diagrams the page must carry",
    "exit 0: the page names real code; 1: problems, each printed; 2: usage or an unreadable page",
  ].join("\n"),
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "architecture-page-"));
  fixture = join(scratch, "fixture");
  mkdirSync(fixture);
  writeTree(fixture, FILES);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("arch-lint.mts", () => {
  const green = {
    status: 0,
    stdout: "arch-lint: imports under src match architecture.yml\n",
    stderr: "",
  };

  test("a tree that matches its declaration passes, naming the scanned root", () => {
    expect(run(ARCH_LINT, [], fixture)).toEqual(green);
  });

  test("--config and --root from outside the tree behave the same", () => {
    expect(
      run(ARCH_LINT, ["--config", join(fixture, "architecture.yml"), "--root", fixture], scratch),
    ).toEqual(green);
  });

  test.each<[string, string, string]>([
    [
      "a forbidden import names both files",
      CONFIG.replace("engine: [types]", "engine: []"),
      "forbidden import engine -> types: src/engine/run.ts -> src/types.ts; move it or declare the edge",
    ],
    [
      "a stale allowance names the edge",
      `${CONFIG}  types: [engine]\n`,
      "stale allowance types -> engine: no file draws it; remove it from architecture.yml",
    ],
    [
      "a file outside every layer is reported, not dropped",
      CONFIG.replace("  main: [src/main.ts]\n", "").replace("  main: [engine]\n", ""),
      "src/main.ts belongs to no layer in architecture.yml",
    ],
    [
      "a layer path that does not exist is reported",
      CONFIG.replace("types: [src/types.ts]", "types: [src/types.ts, src/nowhere.ts]"),
      "layer types names src/nowhere.ts, which does not exist",
    ],
  ])("%s (exit 1)", (name, config, problem) => {
    const root = variant(name.replace(/\W+/g, "-"), { "architecture.yml": config });
    expect(run(ARCH_LINT, [], root)).toEqual({
      status: 1,
      stdout: "",
      stderr: `arch-lint: 1 problem(s)\n  ${problem}\n`,
    });
  });

  test("a type-only import is an edge: dropping it from the code makes the allowance stale", () => {
    const root = variant("type-only-edge", {
      "src/engine/run.ts": "export function run(): void {}\n",
    });
    expect(run(ARCH_LINT, [], root)).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "arch-lint: 1 problem(s)\n  stale allowance engine -> types: no file draws it; remove it from architecture.yml\n",
    });
  });

  test("exclude drops a file as a SOURCE only: an import INTO an excluded file is still an edge", () => {
    const root = variant("import-into-excluded", {
      "src/main.ts": 'import { run } from "./engine/run.ts";\nimport "./engine/mock.ts";\nrun();\n',
      "architecture.yml": CONFIG.replace("main: [engine]", "main: []"),
    });
    expect(run(ARCH_LINT, [], root)).toEqual({
      status: 1,
      stdout: "",
      stderr: [
        "arch-lint: 1 problem(s)",
        "  forbidden import main -> engine: src/main.ts -> src/engine/run.ts, src/main.ts -> src/engine/mock.ts; move it or declare the edge",
        "",
      ].join("\n"),
    });
  });

  test("a computed dynamic import exits 2 naming file and line, never a dropped edge", () => {
    const root = variant("computed-import", {
      "src/engine/dyn.ts": 'const name = "./run.ts";\n\nexport const load = () => import(name);\n',
    });
    expect(run(ARCH_LINT, [], root)).toEqual({
      status: 2,
      stdout: "",
      stderr:
        "arch-lint: src/engine/dyn.ts:3 loads a module through a computed specifier, which the import graph cannot follow; use a string literal\n",
    });
  });

  test("an edge naming an undeclared layer is a declaration error (exit 2)", () => {
    const root = variant("typo-layer", {
      "architecture.yml": CONFIG.replace("main: [engine]", "main: [engin]"),
    });
    expect(run(ARCH_LINT, [], root)).toEqual({
      status: 2,
      stdout: "",
      stderr: 'arch-lint: architecture.yml: edges name "engin", which is not a layer\n',
    });
  });

  test("--mermaid prints one node per layer and one arrow per declared edge", () => {
    expect(run(ARCH_LINT, ["--mermaid"], fixture)).toEqual({
      status: 0,
      stdout: `${MAP}\n`,
      stderr: "",
    });
  });

  test("an unknown argument exits 2 with the usage", () => {
    expect(run(ARCH_LINT, ["--bogus"], fixture)).toEqual({
      status: 2,
      stdout: "",
      stderr: `unknown argument: --bogus\n${USAGE.lint}\n`,
    });
  });
});

describe("importSpecifiers", () => {
  test.each<[string, string, string[]]>([
    ["a runtime import", 'import { a } from "./a.js";', ["./a.js"]],
    ["a type-only import", 'import type { A } from "./a.js";', ["./a.js"]],
    ["an inline type import", 'import { type A, b } from "./a.js";', ["./a.js"]],
    ["a side-effect import", 'import "./a.js";', ["./a.js"]],
    ["a re-export", 'export { a } from "./a.js";', ["./a.js"]],
    ["a type re-export", 'export type { A } from "./a.js";', ["./a.js"]],
    ["a star re-export", 'export * from "./a.js";', ["./a.js"]],
    ["a namespace re-export", 'export * as ns from "./a.js";', ["./a.js"]],
    ["a require call", 'const a = require("./a.js");', ["./a.js"]],
    ["a parenthesized require", 'const a = (require)("./a.js");', ["./a.js"]],
    ["a non-null-asserted require", 'const a = require!("./a.js");', ["./a.js"]],
    ["a literal dynamic import", 'const a = await import("./a.js");', ["./a.js"]],
    ["a template-literal dynamic import", "const a = await import(`./a.js`);", ["./a.js"]],
    ["an import in a type position", 'export type A = import("./a.js").A;', ["./a.js"]],
    ["a typeof import in a type position", 'type A = typeof import("./a.js");', ["./a.js"]],
    ["a type-only import-equals", 'import type A = require("./a.js");', ["./a.js"]],
    ["an import-equals", 'import A = require("./a.js");', ["./a.js"]],
    ["an import with attributes", 'import d from "./d.json" with { type: "json" };', ["./d.json"]],
    ["a package import, which is not an edge", 'import { z } from "zod";', []],
    ["import.meta, which loads nothing", "const dir = import.meta.dir;", []],
    ["a member named import or require", 'o.import("./a.js"); require.resolve("./a.js");', []],
    ["an import inside a comment", '// import("./a.js")\n/* import x from "./b.js" */', []],
    [
      "an import inside a string or template",
      `const s = "import(\\"./a.js\\")"; const t = \`from "./b.js" \${s}\`;`,
      [],
    ],
    [
      "one file named several ways, once",
      'import type { A } from "./a.js"; export { b } from "./a.js"; import "../up.js";',
      ["./a.js", "../up.js"],
    ],
  ])("reads %s", (_case, text, specifiers) => {
    expect(importSpecifiers(text, "x.ts")).toEqual(specifiers);
  });

  test("reads a .tsx file, where JSX text is not code", () => {
    const text = 'import type { A } from "./a.js";\nexport const v = <p>import("./b.js")</p>;\n';
    expect(importSpecifiers(text, "x.tsx")).toEqual(["./a.js"]);
  });

  test.each<[string, string]>([
    ["a computed dynamic import", 'const m = "./a.js";\nawait import(m);'],
    ["a computed require", "const m = name();\nrequire(m);"],
    ["a substituted template specifier", `const x = 1;\nimport(\`./\${x}.js\`);`],
  ])("throws on %s rather than dropping the edge", (_case, text) => {
    expect(() => importSpecifiers(text, "x.ts")).toThrow(
      new Error(
        "x.ts:2 loads a module through a computed specifier, which the import graph cannot follow; use a string literal",
      ),
    );
  });

  test("a file that does not parse throws naming the line", () => {
    expect(() => importSpecifiers("const = ;", "x.ts")).toThrow(/^x\.ts:1 does not parse: /);
  });
});

describe("without oxc-parser", () => {
  test("every script exits 2 with the one-line install hint", () => {
    // A repository that copied the scripts but did not add the dependency:
    // its own node_modules stops bun's auto-install.
    const root = join(scratch, "no-parser");
    writeTree(root, {
      "package.json": '{ "name": "x", "type": "module" }\n',
      "node_modules/.keep": "",
      "architecture.yml": "layers:\n  a: [src/a.ts]\n",
      "src/a.ts": "export const a = 1;\n",
    });
    for (const script of [
      "arch-lint.mts",
      "render-architecture-map.mts",
      "check-architecture-page.mts",
    ]) {
      cpSync(join(SCRIPTS, script), join(root, "scripts", script));
    }
    const hint = "architecture-page scripts need oxc-parser: bun add -d oxc-parser\n";
    expect(run(join(root, "scripts", "arch-lint.mts"), [], root)).toEqual({
      status: 2,
      stdout: "",
      stderr: hint,
    });
    expect(
      run(join(root, "scripts", "render-architecture-map.mts"), ["--page", "x.md"], root),
    ).toEqual({ status: 2, stdout: "", stderr: hint });
    expect(
      run(join(root, "scripts", "check-architecture-page.mts"), ["--page", "x.md"], root),
    ).toEqual({ status: 2, stdout: "", stderr: hint });
  });
});

const PAGE_HEAD = `# Architecture

## One concept

\`\`\`mermaid
flowchart LR
  a["src/engine/run.ts<br>run()"]
\`\`\`

- What the diagram cannot show.

Demonstrated by: [the run test](../test/engine/run.test.ts).

## The module map

`;

const REGION = `<!-- BEGIN GENERATED: architecture-map (bun render-architecture-map.mts; derived from architecture.yml) -->
<!-- END GENERATED: architecture-map -->
`;

const RENDERED_REGION = `<!-- BEGIN GENERATED: architecture-map (bun render-architecture-map.mts; derived from architecture.yml) -->
\`\`\`mermaid
${MAP}
\`\`\`
<!-- END GENERATED: architecture-map -->
`;

describe("render-architecture-map.mts", () => {
  test("writes the map into the region, then reports it current, then flags drift under --check", () => {
    const root = variant("render", { "docs/architecture.md": PAGE_HEAD + REGION });
    const page = join(root, "docs", "architecture.md");
    expect(run(RENDER, ["--page", page], root)).toEqual({
      status: 0,
      stdout: "render-architecture-map: wrote docs/architecture.md region architecture-map\n",
      stderr: "",
    });
    expect(readFileSync(page, "utf8")).toBe(PAGE_HEAD + RENDERED_REGION);

    expect(run(RENDER, ["--page", page, "--check"], root)).toEqual({
      status: 0,
      stdout: "render-architecture-map: docs/architecture.md region architecture-map is current\n",
      stderr: "",
    });

    writeFileSync(join(root, "architecture.yml"), `${CONFIG}  types: [engine]\n`);
    expect(run(RENDER, ["--page", page, "--check"], root)).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "render-architecture-map: docs/architecture.md region architecture-map differs from architecture.yml; run without --check to rewrite it\n",
    });
    expect(readFileSync(page, "utf8")).toBe(PAGE_HEAD + RENDERED_REGION);
  });

  test("a hand edit inside the region is drift, and the rewrite restores the map", () => {
    const root = variant("render-hand-edit", {
      "docs/architecture.md": (PAGE_HEAD + RENDERED_REGION).replace(
        "  engine --> types",
        "  engine --> types\n  types --> main",
      ),
    });
    const page = join(root, "docs", "architecture.md");
    expect(run(RENDER, ["--page", page, "--check"], root)).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "render-architecture-map: docs/architecture.md region architecture-map differs from architecture.yml; run without --check to rewrite it\n",
    });
    expect(run(RENDER, ["--page", page], root)).toEqual({
      status: 0,
      stdout: "render-architecture-map: wrote docs/architecture.md region architecture-map\n",
      stderr: "",
    });
    expect(readFileSync(page, "utf8")).toBe(PAGE_HEAD + RENDERED_REGION);
  });

  test("a page without the region exits 2 naming the marker count", () => {
    const root = variant("render-no-region", { "docs/architecture.md": PAGE_HEAD });
    expect(run(RENDER, ["--page", join(root, "docs", "architecture.md")], root)).toEqual({
      status: 2,
      stdout: "",
      stderr:
        'render-architecture-map: region "architecture-map" needs exactly one BEGIN and one END marker, found 0 and 0\n',
    });
  });

  test("a page that does not exist exits 2", () => {
    expect(run(RENDER, ["--page", "docs/missing.md"], fixture)).toEqual({
      status: 2,
      stdout: "",
      stderr: "render-architecture-map: docs/missing.md does not exist\n",
    });
  });

  test("--page is required", () => {
    expect(run(RENDER, [], fixture)).toEqual({
      status: 2,
      stdout: "",
      stderr: `--page is required\n${USAGE.render}\n`,
    });
  });
});

describe("check-architecture-page.mts", () => {
  const REPO_URL = "https://github.com/octo/example/blob/main/";
  const demo = "Demonstrated by: [the run test](../test/engine/run.test.ts).";
  const page = (label: string, tail = demo): string =>
    `# T\n\n\`\`\`mermaid\nflowchart LR\n  a["${label}"]\n\`\`\`\n\n${tail}\n\n## Next\n`;

  let caseIndex = 0;
  let current = "";
  function check(markdown: string, args: string[] = [], root = fixture): Outcome {
    caseIndex += 1;
    current = `docs/case-${caseIndex}.md`;
    writeFileSync(join(root, current), markdown);
    return run(CHECK_PAGE, ["--page", current, ...args], root);
  }

  function passing(diagrams: number): Outcome {
    return {
      status: 0,
      stdout: `check-architecture-page: ${current} names real code (concept diagrams: ${diagrams})\n`,
      stderr: "",
    };
  }

  function failing(problems: string[]): Outcome {
    return {
      status: 1,
      stdout: "",
      stderr: `check-architecture-page: ${current}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}\n`,
    };
  }

  test("a real path with an exported symbol and a resolving relative link passes", () => {
    expect(check(page("src/engine/run.ts<br>run()"), ["--expect-diagrams", "1"])).toEqual(
      passing(1),
    );
  });

  test("a caption before the path, symbols across segments and commas, a re-exported type", () => {
    const label = "the runner<br>src/engine/run.ts run()<br>newName(), Config";
    const root = variant("page-types", {
      "src/engine/run.ts": `${FILES["src/engine/run.ts"]}export type { Config } from "../types.ts";\n`,
    });
    expect(check(page(label), [], root)).toEqual(passing(1));
  });

  test("exports are read from the module record: aliases, multi-declarator consts, not comments", () => {
    expect(check(page("src/engine/run.ts<br>newName() second"))).toEqual(passing(1));
    expect(check(page("src/engine/run.ts<br>oldName() hidden"))).toEqual(
      failing([
        '"src/engine/run.ts<br>oldName() hidden": src/engine/run.ts exports no oldName',
        '"src/engine/run.ts<br>oldName() hidden": src/engine/run.ts exports no hidden',
      ]),
    );
  });

  test("a default export is the name default, not the function's own name", () => {
    expect(check(page("src/engine/run.ts<br>default()"))).toEqual(passing(1));
    expect(check(page("src/engine/run.ts<br>main()"))).toEqual(
      failing(['"src/engine/run.ts<br>main()": src/engine/run.ts exports no main']),
    );
  });

  test("export * carries the target's names without its default; export * as ns is ns", () => {
    expect(check(page("src/engine/index.ts<br>run() newName second ns"))).toEqual(passing(1));
    expect(check(page("src/engine/index.ts<br>default() mock"))).toEqual(
      failing([
        '"src/engine/index.ts<br>default() mock": src/engine/index.ts exports no default',
        '"src/engine/index.ts<br>default() mock": src/engine/index.ts exports no mock',
      ]),
    );
  });

  test("a star re-export cycle resolves both files' names and terminates", () => {
    expect(check(page("src/engine/cycle-a.ts<br>fromA fromB"))).toEqual(passing(1));
    expect(check(page("src/engine/cycle-b.ts<br>fromA fromB"))).toEqual(passing(1));
  });

  test("a CRLF page is read line for line", () => {
    const crlf = page("src/engine/run.ts<br>run()").replace(/\n/g, "\r\n");
    expect(check(crlf, ["--expect-diagrams", "1"])).toEqual(passing(1));
  });

  test("a fence with a space before its info string is a diagram", () => {
    const spaced = `# T\n\n\`\`\` mermaid\nflowchart LR\n  a["src/engine/nowhere.ts"]\n\`\`\`\n\n${demo}\n`;
    expect(check(spaced, ["--expect-diagrams", "1"])).toEqual(
      failing(['"src/engine/nowhere.ts": src/engine/nowhere.ts does not exist']),
    );
  });

  test("a mermaid example nested inside a longer fence is that block's text, not a diagram", () => {
    const nested = [
      page("src/engine/run.ts<br>run()"),
      "Authoring example:",
      "",
      "````markdown",
      "```mermaid",
      'flowchart LR\n  a["src/engine/nowhere.ts<br>gone()"]',
      "```",
      "",
      "Demonstrated by: [x](../test/engine/nowhere.test.ts).",
      "````",
      "",
    ].join("\n");
    expect(check(nested, ["--expect-diagrams", "1"])).toEqual(passing(1));
  });

  test("a heading quoted inside a fence does not end the diagram's section", () => {
    const quotedHeading = [
      "# T",
      "",
      "```mermaid",
      "flowchart LR",
      '  a["src/engine/run.ts<br>run()"]',
      "```",
      "",
      "````markdown",
      "## Example",
      "````",
      "",
      demo,
      "",
      "## Next",
      "",
    ].join("\n");
    expect(check(quotedHeading, ["--expect-diagrams", "1"])).toEqual(passing(1));
  });

  test("a GENERATED marker quoted inside a fence opens no region: the diagram after it is a concept", () => {
    const quotedMarker = [
      "# T",
      "",
      "```markdown",
      "<!-- BEGIN GENERATED: architecture-map -->",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      '  a["src/engine/run.ts<br>run()"]',
      "```",
      "",
      "Some prose.",
      "",
    ].join("\n");
    expect(check(quotedMarker, ["--expect-diagrams", "1"])).toEqual(
      failing([
        'line 7: the diagram has no "Demonstrated by:" line before the next heading',
        '1 concept diagrams but 0 "Demonstrated by:" lines; one line per diagram',
      ]),
    );
  });

  test("the real region markers, outside any fence, still exempt and uncount their diagram", () => {
    const real = `${page("src/engine/run.ts<br>run()")}\n${RENDERED_REGION}`;
    expect(check(real, ["--expect-diagrams", "1"])).toEqual(passing(1));
    expect(check(`# T\n\n${RENDERED_REGION}`, ["--expect-diagrams", "0"])).toEqual(passing(0));
  });

  test.each<[string, string]>([
    ["a rectangle", 'a["L"]'],
    ["a round node", 'a("L")'],
    ["a circle", 'a(("L"))'],
    ["a rhombus", 'a{"L"}'],
    ["a hexagon", 'a{{"L"}}'],
    ["a parallelogram", 'a[/"L"/]'],
    ["a reverse parallelogram", 'a[\\"L"\\]'],
    ["a subroutine", 'a[["L"]]'],
    ["a flag", 'a>"L"]'],
    ["a stadium", 'a(["L"])'],
  ])("reads the label of %s", (_case, node) => {
    const shaped = node.replace("L", "src/engine/run.ts nothing()");
    const markdown = `# T\n\n\`\`\`mermaid\nflowchart LR\n  ${shaped}\n\`\`\`\n\n${demo}\n`;
    expect(check(markdown)).toEqual(
      failing(['"src/engine/run.ts nothing()": src/engine/run.ts exports no nothing']),
    );
  });

  test("a node on a %% comment line is not drawn, so it is not checked", () => {
    const markdown = `# T\n\n\`\`\`mermaid\nflowchart LR\n  a["src/engine/run.ts run()"]\n  %% b["src/engine/nowhere.ts"]\n\`\`\`\n\n${demo}\n`;
    expect(check(markdown)).toEqual(passing(1));
  });

  test("an absolute demonstration link resolves through --repo-url", () => {
    const tail = `Demonstrated by: [x](${REPO_URL}test/engine/run.test.ts).`;
    expect(check(page("src/engine/run.ts", tail), ["--repo-url", REPO_URL])).toEqual(passing(1));
  });

  test("a diagram inside a generated region needs no demonstration line and is not counted", () => {
    const markdown = `${page("src/engine/run.ts<br>run()")}\n${RENDERED_REGION}`;
    expect(check(markdown, ["--expect-diagrams", "1"])).toEqual(passing(1));
  });

  test("a fence with trailing spaces or four backticks is a diagram to every reader", () => {
    const four = `# T\n\n\`\`\`\`mermaid\nflowchart LR\n  a["src/engine/run.ts<br>run()"]\n\`\`\`\`\n\n${demo}\n`;
    const spaced = `# T\n\n\`\`\`mermaid  \nflowchart LR\n  a["src/engine/nowhere.ts"]\n\`\`\`\n\nSome prose.\n`;
    expect(check(four, ["--expect-diagrams", "1"])).toEqual(passing(1));
    expect(check(spaced, ["--expect-diagrams", "1"])).toEqual(
      failing([
        '"src/engine/nowhere.ts": src/engine/nowhere.ts does not exist',
        'line 3: the diagram has no "Demonstrated by:" line before the next heading',
        '1 concept diagrams but 0 "Demonstrated by:" lines; one line per diagram',
      ]),
    );
  });

  test("a node on the header line is read: only the flowchart direction is dropped", () => {
    const markdown = `# T\n\n\`\`\`mermaid\nflowchart LR; a["src/engine/nowhere.ts"]\n\`\`\`\n\n${demo}\n`;
    expect(check(markdown)).toEqual(
      failing(['"src/engine/nowhere.ts": src/engine/nowhere.ts does not exist']),
    );
  });

  test.each<[string, string, string[]]>([
    [
      "a missing file",
      "src/engine/nowhere.ts<br>run()",
      ['"src/engine/nowhere.ts<br>run()": src/engine/nowhere.ts does not exist'],
    ],
    [
      "an unexported symbol",
      "src/engine/run.ts<br>fly()",
      ['"src/engine/run.ts<br>fly()": src/engine/run.ts exports no fly'],
    ],
    [
      "a symbol on a directory",
      "src/engine/<br>run()",
      ['"src/engine/<br>run()": src/engine/ is a directory, so it exports no run'],
    ],
    [
      "a caption after the path, which reads as symbols",
      "src/engine/run.ts<br>the runner",
      [
        '"src/engine/run.ts<br>the runner": src/engine/run.ts exports no the',
        '"src/engine/run.ts<br>the runner": src/engine/run.ts exports no runner',
      ],
    ],
    [
      "a token that is neither symbol nor path",
      "src/engine/run.ts run(); newName()",
      [
        '"src/engine/run.ts run(); newName()": "run();" is neither a symbol nor a path; after a path, a label lists only exported symbols',
      ],
    ],
    [
      "a mistyped directory hiding as a caption",
      "srcc/engine/run.ts<br>run()",
      [
        '"srcc/engine/run.ts<br>run()": "srcc/engine/run.ts" looks like code but reads as a caption; a code segment starts with a path under docs, src, test',
        '"srcc/engine/run.ts<br>run()": "run()" looks like code but reads as a caption; a code segment starts with a path under docs, src, test',
      ],
    ],
  ])("rejects %s", (_case, label, problems) => {
    expect(check(page(label))).toEqual(failing(problems));
  });

  test("rejects an unquoted node label", () => {
    const markdown = `# T\n\n\`\`\`mermaid\nflowchart LR\n  a[src/engine/run.ts run()]\n\`\`\`\n\n${demo}\n`;
    expect(check(markdown)).toEqual(
      failing([
        'node "a[src/engine/run.ts run()]" has an unquoted label; quote it so the pins can read it',
      ]),
    );
  });

  test("rejects a concept diagram without a demonstration line, and counts the missing line", () => {
    expect(check(page("src/engine/run.ts", "Some prose."))).toEqual(
      failing([
        'line 3: the diagram has no "Demonstrated by:" line before the next heading',
        '1 concept diagrams but 0 "Demonstrated by:" lines; one line per diagram',
      ]),
    );
  });

  test.each<[string, string, string[], string[]]>([
    [
      "a relative link to a missing file",
      "Demonstrated by: [x](../test/engine/nowhere.test.ts).",
      [],
      ['line 3: "../test/engine/nowhere.test.ts" names a file that does not exist'],
    ],
    [
      "a relative link to a directory",
      "Demonstrated by: [x](../test/engine/).",
      [],
      ['line 3: "../test/engine/" names a directory, not a test or scenario file'],
    ],
    [
      "no link at all",
      "Demonstrated by: the run test.",
      [],
      ['line 3: the "Demonstrated by:" line links nothing'],
    ],
    [
      "an absolute link with no --repo-url",
      `Demonstrated by: [x](${REPO_URL}test/engine/run.test.ts).`,
      [],
      [
        `line 3: "${REPO_URL}test/engine/run.test.ts" is an absolute link; pass --repo-url <prefix> so it can be resolved`,
      ],
    ],
    [
      "an absolute link outside the repository",
      "Demonstrated by: [x](https://example.com/test/engine/run.test.ts).",
      ["--repo-url", REPO_URL],
      [`line 3: "https://example.com/test/engine/run.test.ts" is not a ${REPO_URL} link`],
    ],
    [
      "an absolute link to a missing file",
      `Demonstrated by: [x](${REPO_URL}test/engine/nowhere.test.ts).`,
      ["--repo-url", REPO_URL],
      [`line 3: "${REPO_URL}test/engine/nowhere.test.ts" names a file that does not exist`],
    ],
  ])("rejects a demonstration with %s", (_case, tail, args, problems) => {
    expect(check(page("src/engine/run.ts", tail), args)).toEqual(failing(problems));
  });

  test("a wrong --expect-diagrams count fails naming both numbers", () => {
    expect(check(page("src/engine/run.ts"), ["--expect-diagrams", "2"])).toEqual(
      failing([
        "expected 2 concept diagrams, found 1; change --expect-diagrams only when a diagram was added or removed on purpose",
      ]),
    );
  });

  test("a page that does not exist exits 2", () => {
    expect(run(CHECK_PAGE, ["--page", "docs/missing.md"], fixture)).toEqual({
      status: 2,
      stdout: "",
      stderr: "check-architecture-page: docs/missing.md does not exist\n",
    });
  });

  test("--page is required", () => {
    expect(run(CHECK_PAGE, [], fixture)).toEqual({
      status: 2,
      stdout: "",
      stderr: `--page is required\n${USAGE.page}\n`,
    });
  });
});
