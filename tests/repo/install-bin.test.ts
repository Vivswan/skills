// reaches: bin/install.mjs .claude-plugin/marketplace.json .claude-plugin/plugin.json
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../scripts/lib.mts";
import { tempDirs } from "../helpers/temp-dirs";

const temp = tempDirs();
const BIN = join(ROOT, "bin", "install.mjs");
// The bin's own runtime under npx; an absolute path, since the no-npx case below empties PATH.
const NODE = Bun.which("node") ?? "node";

// What would drift silently: the skills CLI's grammar, `skills add <owner/repo>[/<path>] [flags]`, is an external
// contract nothing here enforces, and the marketplace file is the roster the bin reads. These are the argv lists a
// user's `npx -y github:Vivswan/skills <flags>` runs for the files as committed, this repository first.
const commands = (flags: string[]) => [
  ["npx", "-y", "skills", "add", "Vivswan/skills", ...flags],
  ["npx", "-y", "skills", "add", "Leonxlnx/taste-skill/skills/taste-skill", ...flags],
  ["npx", "-y", "skills", "add", "anthropics/skills/skills/frontend-design", ...flags],
  ["npx", "-y", "skills", "add", "cursor/plugins/pstack/skills/unslop", ...flags],
];

// A stub npx (or npx.cmd) first on PATH: it logs its own name and argv, one call per line with a unit separator
// between arguments so the boundaries survive, and exits 0, or 3 on the call STUB_FAIL_AT names.
const SEPARATOR = String.fromCharCode(0x1f);
const FAKE_NPX = `#!/usr/bin/env bash
{ printf '%s' "$(basename "$0")"; printf '\\x1f%s' "$@"; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
if [ -n "\${STUB_FAIL_AT}" ] && [ "$(wc -l < "\${STUB_ARGS_LOG}")" -eq "\${STUB_FAIL_AT}" ]; then exit 3; fi
exit 0
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string[];
  readonly stderr: string;
  readonly calls: string[][];
}

interface RunOptions {
  readonly env?: Record<string, string>;
  /** The stub's file name on PATH; null leaves PATH without any npx. */
  readonly stub?: string | null;
  /** The bin to run; a copy beside scratch catalog files for the malformed-data cases. */
  readonly bin?: string;
}

function run(args: readonly string[], { env = {}, stub = "npx", bin = BIN }: RunOptions = {}): Run {
  const dir = temp.dir("install-bin-");
  if (stub !== null) {
    writeFileSync(join(dir, stub), FAKE_NPX);
    chmodSync(join(dir, stub), 0o755);
  }
  const log = join(dir, "argv.log");
  // With the stub, PATH keeps the real one behind it so `/usr/bin/env bash` resolves; without, PATH is the empty dir.
  const proc = spawnSync(NODE, [bin, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: stub === null ? dir : `${dir}:${process.env.PATH}`,
      STUB_ARGS_LOG: log,
      ...env,
    },
  });
  const lines = (text: string) => text.split("\n").filter((line) => line !== "");
  return {
    status: proc.status,
    stdout: lines(proc.stdout),
    stderr: proc.stderr,
    calls: existsSync(log)
      ? lines(readFileSync(log, "utf-8")).map((line) => line.split(SEPARATOR))
      : [],
  };
}

interface Case {
  readonly name: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly status: number;
  readonly calls: string[][];
  readonly stdout: string[];
}

describe("bin/install.mjs", () => {
  test.each<Case>([
    {
      name: "runs this repository, then every upstream folder, with the flags passed through",
      args: ["-g", "-a", "codex"],
      env: {},
      status: 0,
      calls: commands(["-g", "-a", "codex"]),
      stdout: commands(["-g", "-a", "codex"]).map((argv) => argv.join(" ")),
    },
    {
      name: "--help prints the commands and runs none of them",
      args: ["--help", "-g"],
      env: {},
      status: 0,
      calls: [],
      stdout: commands(["-g"]).map((argv) => argv.join(" ")),
    },
    {
      name: "stops at the first failing command and exits with its code",
      args: ["-g"],
      env: { STUB_FAIL_AT: "2" },
      status: 3,
      calls: commands(["-g"]).slice(0, 2),
      stdout: commands(["-g"])
        .slice(0, 2)
        .map((argv) => argv.join(" ")),
    },
  ])("$name", ({ args, env, status, calls, stdout }) => {
    const result = run(args, { env });
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.stdout).toEqual(stdout);
  });

  test("a missing npx is a failure with its reason, never a silent pass", () => {
    const result = run(["-g"], { stub: null });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^install: .*ENOENT/);
    expect(result.calls).toEqual([]);
  });

  // A Linux runner has no cmd.exe, so the platform override runs the win32 branch against a stub npx.cmd through
  // /bin/sh. The stub receiving the quoted argument whole and without its quotes proves a shell parsed the line.
  test("on win32 the command is npx.cmd through a shell, with whitespace arguments quoted", () => {
    const result = run(["-g", "-a", "codex claude-code"], {
      env: { SKILLS_INSTALL_PLATFORM: "win32" },
      stub: "npx.cmd",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(
      commands(["-g", "-a", '"codex claude-code"']).map((argv) =>
        ["npx.cmd", ...argv.slice(1)].join(" "),
      ),
    );
    expect(result.calls).toEqual(
      commands(["-g", "-a", "codex claude-code"]).map((argv) => ["npx.cmd", ...argv.slice(1)]),
    );
  });

  test("on win32 an argument carrying a double quote is refused before anything prints", () => {
    const result = run(["--help", "-a", 'co"dex'], { env: { SKILLS_INSTALL_PLATFORM: "win32" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toBe(
      'install: argument "co\\"dex" carries a double quote, which cmd.exe cannot pass through\n',
    );
  });

  // The bin resolves its catalog files beside itself, so a copy in a scratch tree reads whatever sits there.
  function binBeside(marketplace: string): { bin: string; marketplace: string } {
    const root = temp.dir("install-bin-catalog-");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, ".claude-plugin"));
    copyFileSync(BIN, join(root, "bin", "install.mjs"));
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ repository: "https://github.com/example-org/example" }),
    );
    writeFileSync(join(root, ".claude-plugin", "marketplace.json"), marketplace);
    return {
      bin: join(root, "bin", "install.mjs"),
      marketplace: join(root, ".claude-plugin", "marketplace.json"),
    };
  }

  test.each([
    ["a file that does not parse", "{", /^install: (.+marketplace\.json): .+JSON/],
    // JSON.parse quotes the source around the error, newlines included; the line must stay one line.
    [
      "a multi-line file that does not parse",
      '{\n"plugins": [\n1,\n]\n}',
      /^install: (.+marketplace\.json): .+JSON/,
    ],
    [
      "a file without a plugins array",
      "{}",
      /^install: (.+marketplace\.json): plugins must be an array$/,
    ],
  ])("%s fails with one line naming the file, exit 1, no stack", (_name, content, message) => {
    const { bin, marketplace } = binBeside(content);
    const result = run(["--help"], { bin });
    expect(result.status).toBe(1);
    expect(result.stdout).toEqual([]);
    const line = result.stderr.trimEnd();
    expect(line.split("\n")).toHaveLength(1);
    expect(line.match(message)?.[1]).toBe(marketplace);
  });
});
