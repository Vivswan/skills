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

// The stubs log their own name and argv, one call per line with a unit separator between arguments so the
// boundaries survive, and exit 0, or 3 on the call STUB_FAIL_AT names. One is an `npx` on PATH, the other npm's
// own `npx-cli.js`, which the bin runs through node when npx started it.
const SEPARATOR = String.fromCharCode(0x1f);
const FAKE_NPX = `#!/usr/bin/env bash
{ printf '%s' "$(basename "$0")"; printf '\\x1f%s' "$@"; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
if [ -n "\${STUB_FAIL_AT}" ] && [ "$(wc -l < "\${STUB_ARGS_LOG}")" -eq "\${STUB_FAIL_AT}" ]; then exit 3; fi
exit 0
`;
const FAKE_NPX_CLI = `const { appendFileSync } = require("node:fs");
appendFileSync(process.env.STUB_ARGS_LOG, ["npx-cli.js", ...process.argv.slice(2)].join("\\x1f") + "\\n");
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string[];
  readonly stderr: string;
  readonly calls: string[][];
}

interface RunOptions {
  readonly env?: Record<string, string>;
  /** Put the stub `npx` on PATH; false leaves PATH without any npx. */
  readonly npxOnPath?: boolean;
  /** Point npm_execpath at a scratch npm whose npx-cli.js is the stub, as a bin started by npx sees it. */
  readonly underNpx?: boolean;
  /** The bin to run; a copy beside scratch catalog files for the malformed-data cases. */
  readonly bin?: string;
}

function run(
  args: readonly string[],
  { env = {}, npxOnPath = true, underNpx = false, bin = BIN }: RunOptions = {},
): Run {
  const dir = temp.dir("install-bin-");
  const log = join(dir, "argv.log");
  if (npxOnPath) {
    writeFileSync(join(dir, "npx"), FAKE_NPX);
    chmodSync(join(dir, "npx"), 0o755);
  }
  // bun run sets npm_execpath to bun itself, so the bin's npx detection is driven only by what this test sets.
  const { npm_execpath: _npm, npm_node_execpath: _node, ...inherited } = process.env;
  const npm: Record<string, string> = {};
  if (underNpx) {
    mkdirSync(join(dir, "npm"));
    writeFileSync(join(dir, "npm", "npm-cli.js"), "");
    writeFileSync(join(dir, "npm", "npx-cli.js"), FAKE_NPX_CLI);
    npm.npm_execpath = join(dir, "npm", "npm-cli.js");
    npm.npm_node_execpath = NODE;
  }
  // With the stub on PATH, PATH keeps the real one behind it so `/usr/bin/env bash` resolves; without, PATH is the
  // scratch dir alone.
  const proc = spawnSync(NODE, [bin, ...args], {
    encoding: "utf-8",
    env: {
      ...inherited,
      PATH: npxOnPath ? `${dir}:${process.env.PATH}` : dir,
      STUB_ARGS_LOG: log,
      ...npm,
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
      name: "by hand, runs npx from PATH for this repository, then every upstream folder, flags passed through",
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

  // A bin that npx started inherits npm_execpath (npm-cli.js) and npm_node_execpath, and npx-cli.js sits beside
  // npm-cli.js, so the CLI runs under node with no shell on any platform; a two-word value stays one argument.
  test("under npx, runs npm's own npx-cli.js through node, with a two-word flag value as one argument", () => {
    const result = run(["-g", "-a", "codex claude-code"], { npxOnPath: false, underNpx: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(
      commands(["-g", "-a", "codex claude-code"]).map((argv) => argv.join(" ")),
    );
    expect(result.calls).toEqual(
      commands(["-g", "-a", "codex claude-code"]).map((argv) => ["npx-cli.js", ...argv.slice(1)]),
    );
  });

  test("by hand without npx on PATH: one line pointing at npx, exit 1, no stack", () => {
    const result = run(["-g"], { npxOnPath: false });
    expect(result.status).toBe(1);
    // The first command prints before its launch fails; nothing else does.
    expect(result.stdout).toEqual(
      commands(["-g"])
        .slice(0, 1)
        .map((argv) => argv.join(" ")),
    );
    expect(result.stderr).toBe(
      "install: run this through npx (npx -y github:Vivswan/skills), which gives it npm's path\n",
    );
    expect(result.calls).toEqual([]);
  });

  // The bin resolves its catalog files beside itself, so a copy in a scratch tree reads whatever sits there.
  const GOOD_MANIFEST = JSON.stringify({ repository: "https://github.com/example-org/example" });
  function binBeside(files: { manifest?: string; marketplace: string }): {
    bin: string;
    manifest: string;
    marketplace: string;
  } {
    const root = temp.dir("install-bin-catalog-");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, ".claude-plugin"));
    copyFileSync(BIN, join(root, "bin", "install.mjs"));
    const manifest = join(root, ".claude-plugin", "plugin.json");
    const marketplace = join(root, ".claude-plugin", "marketplace.json");
    writeFileSync(manifest, files.manifest ?? GOOD_MANIFEST);
    writeFileSync(marketplace, files.marketplace);
    return { bin: join(root, "bin", "install.mjs"), manifest, marketplace };
  }

  interface CatalogCase {
    readonly name: string;
    readonly files: { manifest?: string; marketplace: string };
    /** Which file the one line names. */
    readonly file: "manifest" | "marketplace";
    readonly message: RegExp;
  }

  test.each<CatalogCase>([
    {
      name: "a file that does not parse",
      files: { marketplace: "{" },
      file: "marketplace",
      message: /^install: (.+marketplace\.json): .+JSON/,
    },
    // JSON.parse quotes the source around the error, newlines included; the line must stay one line.
    {
      name: "a multi-line file that does not parse",
      files: { marketplace: '{\n"plugins": [\n1,\n]\n}' },
      file: "marketplace",
      message: /^install: (.+marketplace\.json): .+JSON/,
    },
    {
      name: "a file without a plugins array",
      files: { marketplace: "{}" },
      file: "marketplace",
      message: /^install: (.+marketplace\.json): plugins must be an array$/,
    },
    {
      name: "a repository that is a string but not a URL",
      files: {
        manifest: JSON.stringify({ repository: "not a url" }),
        marketplace: '{"plugins": []}',
      },
      file: "manifest",
      message: /^install: (.+plugin\.json): repository is not a URL: not a url$/,
    },
    // A catalog value with a line break inside lands in the diagnostic; the line must still be one line.
    {
      name: "a repository carrying a line break",
      files: {
        manifest: JSON.stringify({ repository: "not\na url" }),
        marketplace: '{"plugins": []}',
      },
      file: "manifest",
      message: /^install: (.+plugin\.json): repository is not a URL: not a url$/,
    },
    {
      name: "a git-subdir entry without a path",
      files: {
        marketplace: JSON.stringify({
          plugins: [{ name: "x", source: { source: "git-subdir", url: "example-org/example" } }],
        }),
      },
      file: "marketplace",
      message:
        /^install: (.+marketplace\.json): plugin 'x' git-subdir source needs url and path strings$/,
    },
  ])("$name fails with one line naming the file, exit 1, no stack", ({ files, file, message }) => {
    const beside = binBeside(files);
    const result = run(["--help"], { bin: beside.bin });
    expect(result.status).toBe(1);
    expect(result.stdout).toEqual([]);
    const line = result.stderr.trimEnd();
    expect(line.split("\n")).toHaveLength(1);
    expect(line.match(message)?.[1]).toBe(beside[file]);
  });
});
