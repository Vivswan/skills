// reaches: **/*.md skills/*/scripts/**/*.mts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Code } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";
import { ROOT } from "../../scripts/lib.mts";

/**
 * A command's usage text is quoted on one page, and the page would drift silently when a flag,
 * an exit code, or an output field moved in the script: nothing else reads the two together.
 * So each command (a skill script with a shebang) prints its usage block on `--help`, one page
 * quotes it in a fence the test can find, and the fence is held byte-equal to the block.
 *
 *   ```text usage=skills/<skill>/scripts/<name>.mts
 *   usage: <name>.mts ...
 *   ```
 *
 * A command with no fence, or two, fails here too, so a new script cannot ship without its page.
 * The fix is never a hand edit: paste `bun <script> --help`, run from the repository root.
 */

/** Not pages of this repository: dependencies. Dot directories (.git, .build, .claude) are outside a glob by default. */
const SKIPPED_DIRS = new Set(["node_modules"]);

/** A dependency install plus a bundle on the first run; the next runs take the built bundle. */
const BUILD_TIMEOUT_MS = 180_000;

export interface UsageFence {
  /** Where the fence sits, as `<page>:<line>` for a message. */
  readonly at: string;

  /** The script the info string names, relative to the repository root. */
  readonly script: string;

  /** The fence's body as the page holds it, trailing whitespace and all. */
  readonly text: string;
}

/** The usage fences of one page: a code fence whose info string carries `usage=<script>`. */
export function usageFences(markdown: string, page: string): UsageFence[] {
  const fences: UsageFence[] = [];
  visit(fromMarkdown(markdown), "code", (node: Code) => {
    const info = [node.lang, node.meta].filter((part) => part !== null).join(" ");
    const script = /(?:^|\s)usage=(\S+)/.exec(info)?.[1];
    if (script === undefined) return;
    fences.push({ at: `${page}:${node.position?.start.line ?? 0}`, script, text: node.value });
  });
  return fences;
}

/** Trailing whitespace carries no contract: an editor strips it from a page, a script prints it. */
function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

/** Null when the fence quotes the block; else the diff and the command that regenerates the fence. */
export function fenceDrift(fence: UsageFence, help: string): string | null {
  const expected = normalize(help);
  const actual = normalize(fence.text);
  if (expected === actual) return null;
  const patch = createTwoFilesPatch(fence.at, `bun ${fence.script} --help`, actual, expected);
  return `${fence.at}: the usage fence differs from \`bun ${fence.script} --help\`; paste the command's output into the fence\n${patch}`;
}

function scan(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })]
    .filter((path) => !path.split("/").some((segment) => SKIPPED_DIRS.has(segment)))
    .sort();
}

/** Every command: a script under a skill's scripts/ that starts with a shebang. */
function commands(): string[] {
  return scan("skills/*/scripts/**/*.mts").filter((path) =>
    readFileSync(join(ROOT, path), "utf8").startsWith("#!"),
  );
}

function fences(): UsageFence[] {
  return scan("**/*.md").flatMap((path) =>
    usageFences(readFileSync(join(ROOT, path), "utf8"), path),
  );
}

function help(script: string, flag: "--help" | "-h") {
  const run = Bun.spawnSync(["bun", join(ROOT, script), flag], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const COMMANDS = commands();
const FENCES = fences();

test("every usage fence names a command: a script under skills/*/scripts/ with a shebang", () => {
  const strays = FENCES.filter((fence) => !COMMANDS.includes(fence.script)).map(
    (fence) => `${fence.at}: usage=${fence.script}`,
  );
  expect(strays, "a fence names a path that is not a command").toEqual([]);
});

describe("each command prints its usage block on --help, and one page quotes it", () => {
  for (const script of COMMANDS) {
    test(
      script,
      () => {
        const quoted = FENCES.filter((fence) => fence.script === script);
        expect(
          quoted.map((fence) => fence.at),
          quoted.length === 0
            ? `no page quotes ${script}; add a fence opened by \`\`\`text usage=${script} holding \`bun ${script} --help\``
            : `${script} is quoted on more than one page; keep one fence and link to it from the others`,
        ).toHaveLength(1);
        const fence = quoted[0] as UsageFence;
        const long = help(script, "--help");
        expect({ code: long.code, stderr: long.stderr }, `bun ${script} --help`).toEqual({
          code: 0,
          stderr: "",
        });
        expect(
          long.stdout.startsWith("usage:"),
          `bun ${script} --help prints its usage block`,
        ).toBe(true);
        const drift = fenceDrift(fence, long.stdout);
        expect(drift, drift ?? "").toBeNull();
        const short = help(script, "-h");
        expect({ code: short.code, stdout: short.stdout }, `bun ${script} -h`).toEqual({
          code: 0,
          stdout: long.stdout,
        });
      },
      BUILD_TIMEOUT_MS,
    );
  }
});

// Negative controls: the fence reader and the comparison can fail, each on the shape it guards.
describe("the fence reader", () => {
  const PAGE = [
    "# Page",
    "",
    "1. A step with the fence indented inside it:",
    "",
    "   ```text usage=skills/a/scripts/one.mts",
    "   usage: one.mts <x>",
    "     --x  a flag",
    "   ```",
    "",
    "```text",
    "usage: not-a-usage-fence.mts",
    "```",
    "",
    "```usage=skills/a/scripts/two.mts",
    "usage: two.mts",
    "```",
  ].join("\n");

  test("reads a fence by its usage= key, indentation stripped, and ignores a fence without one", () => {
    expect(usageFences(PAGE, "docs/page.md")).toEqual([
      {
        at: "docs/page.md:5",
        script: "skills/a/scripts/one.mts",
        text: "usage: one.mts <x>\n  --x  a flag",
      },
      { at: "docs/page.md:14", script: "skills/a/scripts/two.mts", text: "usage: two.mts" },
    ]);
  });
});

describe("the comparison", () => {
  const fence: UsageFence = {
    at: "docs/page.md:5",
    script: "skills/a/scripts/one.mts",
    text: "usage: one.mts <x>  \n  --x  a flag\n",
  };

  test("trailing whitespace on either side is not drift", () => {
    expect(fenceDrift(fence, "usage: one.mts <x>\n  --x  a flag   \n\n")).toBeNull();
  });

  test("a changed line is drift, reported as a patch naming the page and the command", () => {
    const drift = fenceDrift(fence, "usage: one.mts <x> [--y]\n  --x  a flag\n  --y  another");
    expect(drift).toContain(
      "docs/page.md:5: the usage fence differs from `bun skills/a/scripts/one.mts --help`",
    );
    expect(drift).toContain("-usage: one.mts <x>\n");
    expect(drift).toContain("+usage: one.mts <x> [--y]\n");
    expect(drift).toContain("+  --y  another");
  });
});
