import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import { checkFiles, pythonFiles } from "../../../skills/code-standards/scripts/python-order.mts";
import { tempDirs } from "../../helpers/temp-dirs";

const CHECK = join(ROOT, "skills", "code-standards", "scripts", "python-order.mts");
const temp = tempDirs();

function tree(files: Record<string, string | Buffer>): string {
  const root = temp.dir("python-order-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function runCheck(cwd: string, ...args: string[]) {
  const proc = spawnSync("bun", [CHECK, ...args], { cwd, encoding: "utf8" });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

const messages = (root: string, ...files: string[]) =>
  checkFiles(files.map((f) => join(root, f))).findings.map((f) => `${f.line}: ${f.message}`);

const LATE = "is assigned below the first def; module constants sit in one block after the imports";
const FORWARD = "defined below it; a function sits above its callers";

// The module in the shape the standard's specimen approves: constants first, helpers above the one caller.
const IN_ORDER = `"""Transcribe a video."""
import json
from pathlib import Path

__all__ = ["transcribe"]

SEGMENTS: dict[tuple[str, str], list[str]] = {}
DEFAULT_MODEL = "base"

Window = tuple[float, float]


def read_cache(cache: Path) -> list[str] | None:
    if not cache.exists():
        return None

    return json.loads(cache.read_text())


def transcribe(video: Path, model: str = DEFAULT_MODEL) -> list[str]:
    key = (str(video), model)

    if key not in SEGMENTS:
        SEGMENTS[key] = read_cache(video) or []

    return SEGMENTS[key]


if __name__ == "__main__":
    transcribe(Path("a.mp4"))
`;

describe("the two orderings Python reads for the reviewer", () => {
  // One axis varies: the module. Each row is a shape the analysis once read wrongly, or a scope rule Python owns.
  test.each<[string, string, string | Buffer, string[]]>([
    [
      "an assignment below the first def is named wherever it sits at module level, a walrus and the main guard's else branch included, the exact main guard's body excepted; a type alias or class above the defs is not",
      "late.py",
      [
        "import os",
        "",
        "Row = dict[str, int]",
        "",
        "class Point:",
        "    x: int",
        "",
        "def read() -> None:",
        "    local = 1",
        "    return None",
        "",
        'CACHE_DIR = os.environ.get("CACHE")',
        "SEEN: set[str] = set()",
        "",
        "try:",
        "    import tomllib",
        "except ImportError:",
        "    tomllib = None",
        "",
        "def main() -> None:",
        "    read()",
        "",
        "if (FLAG := os.getenv('FLAG')):",
        "    print(FLAG)",
        "",
        'if __name__ != "__main__":',
        "    IMPORTED = True",
        "",
        'if __name__ == "__main__":',
        "    args = main()",
        "else:",
        "    LOADED = True",
        "",
      ].join("\n"),
      [
        `12: CACHE_DIR ${LATE}`,
        `13: SEEN ${LATE}`,
        `18: tomllib ${LATE}`,
        `23: FLAG ${LATE}`,
        `27: IMPORTED ${LATE}`,
        `32: LOADED ${LATE}`,
      ],
    ],
    [
      "a function naming a later def is reported once per name, at the function's def line; a name the function binds itself is not",
      "forward.py",
      [
        "def main(items: list[str], flag: bool) -> None:",
        "    if flag:",
        "        parse(items)",
        "    parse(items)",
        "    handlers = [render]",
        "    import json as items",
        "    squares = [parse for parse in items]",
        "    return None",
        "",
        "def parse(items: list[str]) -> None:",
        "    return None",
        "",
        "def render(parse: str) -> str:",
        "    return parse",
        "",
        "def items() -> None:",
        "    return None",
        "",
      ].join("\n"),
      [`1: main uses parse, ${FORWARD}`, `1: main uses render, ${FORWARD}`],
    ],
    [
      "a read is the module's name only where Python says so: a comprehension variable, a lambda parameter, or an inner local of that name is passed over; an inner global declaration and a comprehension's iterable count",
      "scopes.py",
      [
        "def main(items: list[str]) -> None:",
        "    values = [helper for helper in items]",
        "    helper()",
        "    squares = [later for later in items]",
        "    f = lambda helper: helper + 1",
        "    g = (lambda: later(x) for x in items)",
        "    h = [fourth for fourth in fourth()]",
        "",
        "    def inner() -> None:",
        "        global third",
        "        third()",
        "",
        "    def shadow(third: int) -> int:",
        "        return third",
        "",
        "def helper() -> None:",
        "    return None",
        "",
        "def later(x: int) -> int:",
        "    return x",
        "",
        "def third() -> None:",
        "    return None",
        "",
        "def fourth() -> list[int]:",
        "    return []",
        "",
      ].join("\n"),
      [
        `1: main uses fourth, ${FORWARD}`,
        `1: main uses helper, ${FORWARD}`,
        `1: main uses later, ${FORWARD}`,
        `1: main uses third, ${FORWARD}`,
      ],
    ],
    [
      "a def inside a module-level if or try is a module function: it is ordered, and it starts the constants' deadline",
      "compound.py",
      [
        "import os",
        "",
        "if os.name == 'nt':",
        "    def first() -> None:",
        "        helper()",
        "",
        "LIMIT = 3",
        "",
        "def helper() -> None:",
        "    return None",
        "",
      ].join("\n"),
      [`4: first uses helper, ${FORWARD}`, `7: LIMIT ${LATE}`],
    ],
    [
      "the main guard closes the module: a def or any statement after it is named",
      "tail.py",
      [
        "def main() -> None:",
        "    return None",
        "",
        'if __name__ == "__main__":',
        "    main()",
        "",
        "def straggler() -> None:",
        "    return None",
        "",
      ].join("\n"),
      ['7: a statement follows the if __name__ == "__main__": block; the guard closes the module'],
    ],
    [
      "a generic def (PEP 695) is ordered like any other",
      "generic.py",
      [
        "def first[T](item: T) -> T:",
        "    return helper(item)",
        "",
        "def helper[T](item: T) -> T:",
        "    return item",
        "",
      ].join("\n"),
      [`1: first uses helper, ${FORWARD}`],
    ],
    [
      "a top-level function is read whole, its nested def included; a method is not ordered",
      "nested.py",
      [
        "class Runner:",
        "    def run(self) -> None:",
        "        helper()",
        "",
        "def outer() -> None:",
        "    def inner() -> None:",
        "        helper()",
        "    inner()",
        "",
        "def helper() -> None:",
        "    return None",
        "",
      ].join("\n"),
      [`5: outer uses helper, ${FORWARD}`],
    ],
    [
      "a coding cookie is honored: Latin-1 source parses as Python itself would parse it",
      "latin.py",
      Buffer.concat([
        Buffer.from("# coding: latin-1\n", "ascii"),
        Buffer.from('LABEL = "Z\xfcrich"\n', "latin1"),
        Buffer.from(
          "def main() -> None:\n    later()\n\ndef later() -> None:\n    return None\n",
          "ascii",
        ),
      ]),
      [`3: main uses later, ${FORWARD}`],
    ],
  ])("%s", (_name, file, content, expected) => {
    const root = tree({ [file]: content });
    expect(messages(root, file)).toEqual(expected);
  });
});

describe("the command", () => {
  test("walks directories for .py files, skipping the environments, and prints file:line: message with exit 1", () => {
    const root = tree({
      "pkg/a.py": "def f() -> None:\n    g()\n\ndef g() -> None:\n    return None\n",
      "pkg/sub/b.py": "X = 1\n",
      ".venv/lib/c.py": "def f() -> None:\n    g()\n\ndef g() -> None:\n    return None\n",
      "node_modules/d.py": "def f() -> None:\n    g()\n",
      "pkg/__pycache__/e.py": "def f() -> None:\n    g()\n",
      "pkg/notes.txt": "def f(): g()",
    });
    expect(pythonFiles([root]).map((f) => f.slice(root.length + 1))).toEqual([
      "pkg/a.py",
      "pkg/sub/b.py",
    ]);

    const run = runCheck(root, "pkg");
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(`pkg/a.py:1: f uses g, ${FORWARD}\n`);
    expect(run.stderr).toBe(
      "python-order: a finding is a place to look; readability and beauty come first, and the order yields where it would read worse\n",
    );
  });

  test("a clean tree exits 0 with no output; a file Python cannot parse exits 2 and names the line", () => {
    const root = tree({ "ok.py": IN_ORDER, "bad/broken.py": "def (:\n" });

    const clean = runCheck(root, "ok.py");
    expect([clean.status, clean.stdout, clean.stderr]).toEqual([0, "", ""]);

    const broken = runCheck(root, ".");
    expect(broken.status).toBe(2);
    expect(broken.stderr).toBe("unreadable: bad/broken.py:1: invalid syntax\n");
  });

  test("usage errors and a missing interpreter exit 2 with the usage block", () => {
    const root = tree({ "ok.py": IN_ORDER });
    const noPath = runCheck(root);
    expect(noPath.status).toBe(2);
    expect(noPath.stderr).toContain("no path given\n\nusage:");

    const badFlag = runCheck(root, "--bogus", "ok.py");
    expect(badFlag.status).toBe(2);
    expect(badFlag.stderr).toContain("--bogus");

    const noPython = runCheck(root, "--python", "no-such-python-xyz", "ok.py");
    expect(noPython.status).toBe(2);
    expect(noPython.stderr).toContain("no-such-python-xyz failed:");
  });
});
