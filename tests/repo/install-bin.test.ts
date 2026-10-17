// reaches: bin/install.mjs bin/install-shared.mjs .claude-plugin/marketplace.json .claude-plugin/plugin.json
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
// user's `npx -y github:Vivswan/skills <flags>` runs for the files as committed, this repository first. Every
// call carries `-y` (the CLI's overwrite prompt would otherwise stop an unattended run) unless the user's flags
// already say yes, so each row states the flags it expects after the target.
const commands = (flags: string[]) => [
  ["npx", "-y", "skills", "add", "Vivswan/skills", ...flags],
  ["npx", "-y", "skills", "add", "Leonxlnx/taste-skill/skills/taste-skill", ...flags],
  ["npx", "-y", "skills", "add", "anthropics/skills/skills/frontend-design", ...flags],
  ["npx", "-y", "skills", "add", "pbakaus/impeccable/.agents/skills/impeccable", ...flags],
  ["npx", "-y", "skills", "add", "cursor/plugins/pstack/skills/unslop", ...flags],
];
/** The calls at these positions of `commands(flags)`: 0 is this repository, 4 the unslop upstream. */
const only = (flags: string[], ...which: number[]) =>
  which.map((index) => commands(flags)[index] as string[]);
const printed = (argvs: string[][]) => argvs.map((argv) => argv.join(" "));

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
  /** Extra environment; HOME is always a scratch directory, so a run never reaches the developer's own installs. */
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
  // HOME and the working directory are the case's own too: after its calls the bin marks installed copies under
  // HOME (with -g) or under the working directory (without), never the developer's.
  const { npm_execpath: _npm, npm_node_execpath: _node, HOME: _home, ...inherited } = process.env;
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
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...inherited,
      HOME: join(dir, "home"),
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
      calls: commands(["-g", "-a", "codex", "-y"]),
      stdout: printed(commands(["-g", "-a", "codex", "-y"])),
    },
    {
      name: "--help prints the commands and runs none of them",
      args: ["--help", "-g"],
      env: {},
      status: 0,
      calls: [],
      stdout: printed(commands(["-g", "-y"])),
    },
    {
      name: "stops at the first failing command and exits with its code",
      args: ["-g"],
      env: { STUB_FAIL_AT: "2" },
      status: 3,
      calls: commands(["-g", "-y"]).slice(0, 2),
      stdout: printed(commands(["-g", "-y"]).slice(0, 2)),
    },
    // `--skill` (or `-s`, each followed by one or more names; `--all` and `*` mean every skill) selects by
    // name, and the CLI exits 1 with "No matching skills found" against a source that ships none of the names,
    // which would end the run there. So only the calls that ship a named skill run, the flags still verbatim.
    {
      name: "--skill naming a skill of this catalog runs this repository's call alone, the flag passed through",
      args: ["-g", "--skill", "rubber-duck-review"],
      env: {},
      status: 0,
      calls: only(["-g", "--skill", "rubber-duck-review", "-y"], 0),
      stdout: printed(only(["-g", "--skill", "rubber-duck-review", "-y"], 0)),
    },
    {
      name: "--skill naming an upstream skill runs that upstream's call alone",
      args: ["-g", "--skill", "unslop"],
      env: {},
      status: 0,
      calls: only(["-g", "--skill", "unslop", "-y"], 4),
      stdout: printed(only(["-g", "--skill", "unslop", "-y"], 4)),
    },
    {
      name: "-s with several names runs each call that ships one of them, in catalog order",
      args: ["-s", "unslop", "rubber-duck-review", "-g"],
      env: {},
      status: 0,
      calls: only(["-s", "unslop", "rubber-duck-review", "-g", "-y"], 0, 4),
      stdout: printed(only(["-s", "unslop", "rubber-duck-review", "-g", "-y"], 0, 4)),
    },
    {
      name: "an empty argument ends the CLI's name list, so a name after it selects nothing",
      args: ["-g", "--skill", "rubber-duck-review", "", "unslop"],
      env: {},
      status: 0,
      calls: only(["-g", "--skill", "rubber-duck-review", "", "unslop", "-y"], 0),
      stdout: printed(only(["-g", "--skill", "rubber-duck-review", "", "unslop", "-y"], 0)),
    },
    {
      name: "--skill '*' runs every call, as no --skill does",
      args: ["--skill", "*", "-g"],
      env: {},
      status: 0,
      calls: commands(["--skill", "*", "-g", "-y"]),
      stdout: printed(commands(["--skill", "*", "-g", "-y"])),
    },
    {
      name: "a user's own -y is not doubled",
      args: ["-g", "-y"],
      env: {},
      status: 0,
      calls: commands(["-g", "-y"]),
      stdout: printed(commands(["-g", "-y"])),
    },
    {
      name: "--all runs every call",
      args: ["--all"],
      env: {},
      status: 0,
      calls: commands(["--all"]),
      stdout: printed(commands(["--all"])),
    },
    {
      name: "--help with --skill prints the one command that would run",
      args: ["--help", "--skill", "unslop", "-g"],
      env: {},
      status: 0,
      calls: [],
      stdout: printed(only(["--skill", "unslop", "-g", "-y"], 4)),
    },
  ])("$name", ({ args, env, status, calls, stdout }) => {
    const result = run(args, { env });
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.stdout).toEqual(stdout);
  });

  // After the calls, the copies of the upstreams the marketplace flags are marked explicit-invocation-only where
  // the CLI keeps them for these flags (`-g`: under HOME), the unflagged upstream's copy is left alone, and a
  // flagged copy that is not there is one stderr line, not a failure.
  test("-g marks the flagged upstream copies under HOME and reports a flagged copy that is missing", () => {
    const home = temp.dir("install-bin-home-");
    const skills = join(home, ".agents", "skills");
    for (const name of ["frontend-design", "unslop"]) {
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
    }

    const result = run(["-g"], { env: { HOME: home } });

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual([
      ...printed(commands(["-g", "-y"])),
      `marked explicit-invocation-only: ${join(skills, "frontend-design")}`,
    ]);
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      `install: no installed copy at ${join(skills, "design-taste-frontend")} to mark explicit-invocation-only`,
      `install: no installed copy at ${join(skills, "impeccable")} to mark explicit-invocation-only`,
    ]);
    expect(readFileSync(join(skills, "frontend-design", "SKILL.md"), "utf8")).toBe(
      "---\nname: frontend-design\ndisable-model-invocation: true\n---\nbody\n",
    );
    expect(readFileSync(join(skills, "frontend-design", "agents", "openai.yaml"), "utf8")).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
    expect(readFileSync(join(skills, "unslop", "SKILL.md"), "utf8")).toBe(
      "---\nname: unslop\n---\nbody\n",
    );
  });

  // A bin that npx started inherits npm_execpath (npm-cli.js) and npm_node_execpath, and npx-cli.js sits beside
  // npm-cli.js, so the CLI runs under node with no shell on any platform; a two-word value stays one argument.
  test("under npx, runs npm's own npx-cli.js through node, with a two-word flag value as one argument", () => {
    const result = run(["-g", "-a", "codex claude-code"], { npxOnPath: false, underNpx: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(printed(commands(["-g", "-a", "codex claude-code", "-y"])));
    expect(result.calls).toEqual(
      commands(["-g", "-a", "codex claude-code", "-y"]).map((argv) => [
        "npx-cli.js",
        ...argv.slice(1),
      ]),
    );
  });

  test("by hand without npx on PATH: one line pointing at npx, exit 1, no stack", () => {
    const result = run(["-g"], { npxOnPath: false });
    expect(result.status).toBe(1);
    // The first command prints before its launch fails; nothing else does.
    expect(result.stdout).toEqual(printed(commands(["-g", "-y"]).slice(0, 1)));
    expect(result.stderr).toBe(
      "install: run this through npx (npx -y github:Vivswan/skills), which gives it npm's path\n",
    );
    expect(result.calls).toEqual([]);
  });

  // The bin resolves its catalog files beside itself through bin/install-shared.mjs, so a copy of the pair in a
  // scratch tree reads whatever sits there.
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
    copyFileSync(join(ROOT, "bin", "install-shared.mjs"), join(root, "bin", "install-shared.mjs"));
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
