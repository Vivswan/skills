// reaches: bin/install.mjs bin/install-shared.mjs .claude-plugin/marketplace.json .claude-plugin/plugin.json
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../scripts/lib.mts";
import { tempDirs } from "../helpers/temp-dirs";

// Every scratch directory of the file: a run's HOME, PATH stub, and call log, and a catalog case's copy of the bin.
const temp = tempDirs();

// The bin as committed; the malformed-catalog cases run a copy beside scratch catalog files.
const BIN = join(ROOT, "bin", "install.mjs");

// The bin's own runtime under npx; an absolute path, since the no-npx case below empties PATH.
const NODE = Bun.which("node") ?? "node";

// What would drift silently: the skills CLI's grammar, `skills add <owner/repo>[/<path>] [flags]`, is an external
// contract nothing here enforces, and the marketplace file is the roster the bin reads. These are the argv lists a
// user's `npx -y github:Vivswan/skills <flags>` runs for the files as committed, this repository first.
//
// Every call carries `-y` unless the flags say yes (the CLI's overwrite prompt would stop an unattended run) and
// `-a universal` unless the agents cover it (the CLI would otherwise install to every agent it knows).
function commands(flags: string[]): string[][] {
  return [
    ["npx", "-y", "skills", "add", "Vivswan/skills", ...flags],
    ["npx", "-y", "skills", "add", "Leonxlnx/taste-skill/skills/taste-skill", ...flags],
    ["npx", "-y", "skills", "add", "anthropics/skills/skills/frontend-design", ...flags],
    ["npx", "-y", "skills", "add", "pbakaus/impeccable/.agents/skills/impeccable", ...flags],
    ["npx", "-y", "skills", "add", "cursor/plugins/pstack/skills/unslop", ...flags],
  ];
}

/** The calls at these positions of `commands(flags)`: 0 is this repository, 4 the unslop upstream. */
function only(flags: string[], ...which: number[]): string[][] {
  return which.map((index) => commands(flags)[index] as string[]);
}

function printed(argvs: string[][]): string[] {
  return argvs.map((argv) => argv.join(" "));
}

// Two stubs for the bin's launcher: an `npx` on PATH, and npm's own `npx-cli.js` for a bin that npx started.
// Each logs its name and argv (one call per line, a unit separator between arguments) and exits 0, or 3 on the
// call STUB_FAIL_AT names after speaking as the CLI does on a failure: npm's cold-cache line and a colored
// warning on stderr, progress and a closing verdict on stdout (quoting npm's update-notice setting).
//
// The PATH stub also plays the CLI's install for the target's skill (STUB_INSTALL_NAMES maps target to name): a
// listing writes nothing; `--copy -a claude-code` creates or rewrites Claude's own copy under HOME/.claude/skills;
// otherwise the canonical copy under HOME/.agents/skills is touched when it is a real directory, never through a
// symlink.

const SEPARATOR = String.fromCharCode(0x1f);
const FAKE_NPX = `#!/usr/bin/env bash
{ printf '%s' "$(basename "$0")"; printf '\\x1f%s' "$@"; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
if [ -n "\${STUB_FAIL_AT}" ] && [ "$(wc -l < "\${STUB_ARGS_LOG}")" -eq "\${STUB_FAIL_AT}" ]; then
  printf 'npm warn exec stub: the skills package will be installed\\n\\033[33m\u26a0 stub skipped %s\\033[0m\\n' "$4" >&2
  printf 'spinner frames\\n\u2514  stub gave up (update notifier: %s)\\n' "\${npm_config_update_notifier}"
  exit 3
fi
case " $* " in *" -l "*|*" --list "*) exit 0;; esac
name=""
IFS=';' read -ra pairs <<< "\${STUB_INSTALL_NAMES}"
for pair in "\${pairs[@]}"; do [ "\${pair%%=*}" = "$4" ] && name="\${pair#*=}"; done
[ -n "$name" ] || exit 0
copy=""; claude=""
case " $* " in *" --copy "*) copy=1;; esac
case " $* " in *" -a claude-code "*) claude=1;; esac
if [ -n "$copy" ] && [ -n "$claude" ]; then
  dir="$HOME/.claude/skills/$name"; mkdir -p "$dir"
  [ -f "$dir/SKILL.md" ] || printf -- '---\\nname: %s\\n---\\nbody\\n' "$name" > "$dir/SKILL.md"
  touch "$dir/SKILL.md"
else
  dir="$HOME/.agents/skills/$name"
  [ -L "$dir" ] && exit 0
  [ -f "$dir/SKILL.md" ] && touch "$dir/SKILL.md"
fi
exit 0
`;
const INSTALL_NAMES = [
  "Leonxlnx/taste-skill/skills/taste-skill=design-taste-frontend",
  "anthropics/skills/skills/frontend-design=frontend-design",
  "pbakaus/impeccable/.agents/skills/impeccable=impeccable",
  "cursor/plugins/pstack/skills/unslop=unslop",
].join(";");
const FAKE_NPX_CLI = `const { appendFileSync } = require("node:fs");
appendFileSync(process.env.STUB_ARGS_LOG, ["npx-cli.js", ...process.argv.slice(2)].join("\\x1f") + "\\n");
`;

/** What one run of the bin produced, and the scratch HOME it installed under. */
interface Run {
  readonly status: number | null;
  readonly stdout: string[];
  readonly stderr: string;
  readonly calls: string[][];
  readonly home: string;
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
  mkdirSync(join(dir, "home"));
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
      STUB_INSTALL_NAMES: INSTALL_NAMES,
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
    home: env.HOME ?? join(dir, "home"),
  };
}

// What the stub says on a failing call, as the bin streams it: the raw stderr lines, the two stdout lines.

const STUB_WARNING = (target: string) =>
  `npm warn exec stub: the skills package will be installed\n\u001b[33m\u26a0 stub skipped ${target}\u001b[0m\n`;
const STUB_PROGRESS = "spinner frames";
const STUB_VERDICT = "\u2514  stub gave up (update notifier: false)";

/** The summary the bin ends with: npm's line dropped, the warning quoted without its color, the verdict last. */
function summary(total: number, ...failed: [target: string, status: number][]): string {
  return [
    `install: ${failed.length} of ${total} skills add calls failed`,
    ...failed.flatMap(([target, status]) => [
      `  ${target}: exit ${status}`,
      `    \u26a0 stub skipped ${target}`,
      `    ${STUB_VERDICT}`,
    ]),
    "",
  ].join("\n");
}

/** The stderr line for a flagged upstream whose call wrote no copy under the run's HOME. */
function noCopy(home: string, name: string): string {
  return `install: no fresh copy at ${join(home, ".agents", "skills", name)} to mark explicit-invocation-only\n`;
}

/** One run of the bin and what it must produce; `stderr` is the whole of it given the run's scratch HOME, and a case without it leaves stderr unasserted. */
interface Case {
  readonly name: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly status: number;
  readonly calls: string[][];
  readonly stdout: string[];
  readonly stderr?: (home: string) => string;
}

describe("bin/install.mjs", () => {
  test.each<Case>([
    {
      name: "by hand, runs npx from PATH for this repository, then every upstream folder, flags passed through",
      args: ["-g", "-a", "codex"],
      env: {},
      status: 0,
      calls: commands(["-g", "-a", "codex", "-y", "-a", "universal"]),
      stdout: printed(commands(["-g", "-a", "codex", "-y", "-a", "universal"])),
    },
    {
      name: "--help prints the commands and runs none of them",
      args: ["--help", "-g"],
      env: {},
      status: 0,
      calls: [],
      stdout: printed(commands(["-g", "-y", "-a", "universal"])),
    },
    // A failing call streams its output where it happens and the run goes on (the two flagged upstreams after
    // it run and say they found no copy to mark); the summary at the end names it with what it said, and the
    // run exits 1 whatever the call's own code was.
    {
      name: "a failing call does not stop the run; the summary at the end names it and the run exits 1",
      args: ["-g"],
      env: { STUB_FAIL_AT: "2" },
      status: 1,
      calls: commands(["-g", "-y", "-a", "universal"]),
      stdout: (() => {
        const [first, second, ...rest] = printed(commands(["-g", "-y", "-a", "universal"]));
        return [first, second, STUB_PROGRESS, STUB_VERDICT, ...rest] as string[];
      })(),
      stderr: (home) =>
        STUB_WARNING("Leonxlnx/taste-skill/skills/taste-skill") +
        noCopy(home, "frontend-design") +
        noCopy(home, "impeccable") +
        summary(5, ["Leonxlnx/taste-skill/skills/taste-skill", 3]),
    },
    // `--skill` (or `-s`, each followed by one or more names; `--all` and `*` mean every skill) selects by
    // name, and the CLI exits 1 with "No matching skills found" against a source that ships none of the names,
    // which would end the run there. So only the calls that ship a named skill run, the flags still verbatim.
    {
      name: "--skill naming a skill of this catalog runs this repository's call alone, the flag passed through",
      args: ["-g", "--skill", "rubber-duck-review"],
      env: {},
      status: 0,
      calls: only(["-g", "--skill", "rubber-duck-review", "-y", "-a", "universal"], 0),
      stdout: printed(only(["-g", "--skill", "rubber-duck-review", "-y", "-a", "universal"], 0)),
    },
    {
      name: "--skill naming an upstream skill runs that upstream's call alone",
      args: ["-g", "--skill", "unslop"],
      env: {},
      status: 0,
      calls: only(["-g", "--skill", "unslop", "-y", "-a", "universal"], 4),
      stdout: printed(only(["-g", "--skill", "unslop", "-y", "-a", "universal"], 4)),
    },
    {
      name: "-s with several names runs each call that ships one of them, in catalog order",
      args: ["-s", "unslop", "rubber-duck-review", "-g"],
      env: {},
      status: 0,
      calls: only(["-s", "unslop", "rubber-duck-review", "-g", "-y", "-a", "universal"], 0, 4),
      stdout: printed(
        only(["-s", "unslop", "rubber-duck-review", "-g", "-y", "-a", "universal"], 0, 4),
      ),
    },
    {
      name: "an empty argument ends the CLI's name list, so a name after it selects nothing",
      args: ["-g", "--skill", "rubber-duck-review", "", "unslop"],
      env: {},
      status: 0,
      calls: only(
        ["-g", "--skill", "rubber-duck-review", "", "unslop", "-y", "-a", "universal"],
        0,
      ),
      stdout: printed(
        only(["-g", "--skill", "rubber-duck-review", "", "unslop", "-y", "-a", "universal"], 0),
      ),
    },
    {
      name: "--skill '*' runs every call, as no --skill does",
      args: ["--skill", "*", "-g"],
      env: {},
      status: 0,
      calls: commands(["--skill", "*", "-g", "-y", "-a", "universal"]),
      stdout: printed(commands(["--skill", "*", "-g", "-y", "-a", "universal"])),
    },
    {
      name: "a user's own -y is not doubled",
      args: ["-g", "-y"],
      env: {},
      status: 0,
      calls: commands(["-g", "-y", "-a", "universal"]),
      stdout: printed(commands(["-g", "-y", "-a", "universal"])),
    },
    {
      name: "--all runs every call, and means every agent to the CLI, so no universal is added",
      args: ["--all"],
      env: {},
      status: 0,
      calls: commands(["--all"]),
      stdout: printed(commands(["--all"])),
    },
    // Agents named in either spelling of the flag stay, universal joins them once; `*` already covers it.
    {
      name: "--agent naming agents keeps them, with universal beside them",
      args: ["--agent", "codex", "claude-code", "-g"],
      env: {},
      status: 0,
      calls: commands(["--agent", "codex", "claude-code", "-g", "-y", "-a", "universal"]),
      stdout: printed(commands(["--agent", "codex", "claude-code", "-g", "-y", "-a", "universal"])),
    },
    {
      name: "-a '*' asks for every agent, so no universal is added",
      args: ["-a", "*", "-g"],
      env: {},
      status: 0,
      calls: commands(["-a", "*", "-g", "-y"]),
      stdout: printed(commands(["-a", "*", "-g", "-y"])),
    },
    {
      name: "--help with --skill prints the one command that would run",
      args: ["--help", "--skill", "unslop", "-g"],
      env: {},
      status: 0,
      calls: [],
      stdout: printed(only(["--skill", "unslop", "-g", "-y", "-a", "universal"], 4)),
    },
  ])("$name", ({ args, env, status, calls, stdout, stderr }) => {
    const result = run(args, { env });
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.stdout).toEqual(stdout);
    if (stderr !== undefined) expect(result.stderr).toBe(stderr(result.home));
  });

  // An installed copy from an earlier run: its SKILL.md is a minute old, so the stub's rewrite shows as a newer
  // mtime, as the CLI's does.
  const PAST = new Date(Date.now() - 60_000);
  function installedCopy(dir: string, name: string): string {
    const copy = join(dir, name);
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
    utimesSync(join(copy, "SKILL.md"), PAST, PAST);
    return copy;
  }
  const UNMARKED = (name: string) => `---\nname: ${name}\n---\nbody\n`;
  const MARKED = (name: string) =>
    `---\nname: ${name}\ndisable-model-invocation: true\n---\nbody\n`;

  // Right after a flagged upstream's call rewrote its canonical copy under HOME (with `-g`), that copy is
  // marked, once, though an agent's symlink also reaches it; the unflagged upstream's copy is left alone, and a
  // flagged upstream whose call wrote no copy is one stderr line, not a failure.
  test("-g marks the copy each flagged call wrote, right after that call", () => {
    const home = temp.dir("install-bin-home-");
    const skills = join(home, ".agents", "skills");
    installedCopy(skills, "frontend-design");
    installedCopy(skills, "unslop");
    const linked = join(home, ".claude", "skills");
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(skills, "frontend-design"), join(linked, "frontend-design"), "dir");

    const result = run(["-g"], { env: { HOME: home } });

    expect(result.status).toBe(0);
    const [catalog, taste, frontend, impeccable, unslop] = printed(
      commands(["-g", "-y", "-a", "universal"]),
    ) as [string, string, string, string, string];
    expect(result.stdout).toEqual([
      catalog,
      taste,
      frontend,
      `marked explicit-invocation-only: ${join(skills, "frontend-design")}`,
      impeccable,
      unslop,
    ]);
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      `install: no fresh copy at ${join(skills, "design-taste-frontend")} to mark explicit-invocation-only`,
      `install: no fresh copy at ${join(skills, "impeccable")} to mark explicit-invocation-only`,
    ]);
    expect(readFileSync(join(skills, "frontend-design", "SKILL.md"), "utf8")).toBe(
      MARKED("frontend-design"),
    );
    expect(readFileSync(join(skills, "frontend-design", "agents", "openai.yaml"), "utf8")).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
    expect(readFileSync(join(linked, "frontend-design", "SKILL.md"), "utf8")).toBe(
      MARKED("frontend-design"),
    );
    expect(readFileSync(join(skills, "unslop", "SKILL.md"), "utf8")).toBe(UNMARKED("unslop"));
  });

  // The mark follows each call, so a failing call in the middle leaves the earlier copy marked, its own copy
  // unmarked and without a notice (it wrote nothing), and the later calls still run and mark as usual.
  test("a failing call in the middle leaves the earlier copy marked, its own untouched, and the later calls run", () => {
    const home = temp.dir("install-bin-home-");
    const skills = join(home, ".agents", "skills");
    installedCopy(skills, "design-taste-frontend");
    installedCopy(skills, "frontend-design");
    installedCopy(skills, "impeccable");

    const result = run(["-g"], { env: { HOME: home, STUB_FAIL_AT: "3" } });

    expect(result.status).toBe(1);
    const [catalog, taste, frontend, impeccable, unslop] = printed(
      commands(["-g", "-y", "-a", "universal"]),
    ) as [string, string, string, string, string];
    expect(result.stdout).toEqual([
      catalog,
      taste,
      `marked explicit-invocation-only: ${join(skills, "design-taste-frontend")}`,
      frontend,
      STUB_PROGRESS,
      STUB_VERDICT,
      impeccable,
      `marked explicit-invocation-only: ${join(skills, "impeccable")}`,
      unslop,
    ]);
    expect(result.stderr).toBe(
      STUB_WARNING("anthropics/skills/skills/frontend-design") +
        summary(5, ["anthropics/skills/skills/frontend-design", 3]),
    );
    expect(readFileSync(join(skills, "frontend-design", "SKILL.md"), "utf8")).toBe(
      UNMARKED("frontend-design"),
    );
    expect(readFileSync(join(skills, "impeccable", "SKILL.md"), "utf8")).toBe(MARKED("impeccable"));
  });

  // `--list` makes every call list and install nothing, so an installed copy is left byte-identical.
  test("--list marks nothing", () => {
    const home = temp.dir("install-bin-home-");
    const skills = join(home, ".agents", "skills");
    installedCopy(skills, "frontend-design");

    const result = run(["-g", "--list"], { env: { HOME: home } });

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(printed(commands(["-g", "--list", "-y", "-a", "universal"])));
    expect(result.stderr).toBe("");
    expect(readFileSync(join(skills, "frontend-design", "SKILL.md"), "utf8")).toBe(
      UNMARKED("frontend-design"),
    );
    expect(existsSync(join(skills, "frontend-design", "agents"))).toBe(false);
  });

  // A symlinked canonical entry is someone else's wiring (the repository's own `bun run link` makes such links):
  // a `--copy` install for one agent leaves it alone and writes that agent's copy, creating the agent's skills
  // directory when it is missing, and that copy is what gets marked.
  test("never writes through a symlinked canonical entry; marks a --copy install's real per-agent copy", () => {
    const home = temp.dir("install-bin-home-");
    const skills = join(home, ".agents", "skills");
    mkdirSync(skills, { recursive: true });
    const foreign = installedCopy(join(home, "foreign"), "frontend-design");
    symlinkSync(foreign, join(skills, "frontend-design"), "dir");
    const copied = join(home, ".claude", "skills", "frontend-design");

    const result = run(["-g", "--skill", "frontend-design", "--copy", "-a", "claude-code"], {
      env: { HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual([
      ...printed(
        only(
          [
            "-g",
            "--skill",
            "frontend-design",
            "--copy",
            "-a",
            "claude-code",
            "-y",
            "-a",
            "universal",
          ],
          2,
        ),
      ),
      `marked explicit-invocation-only: ${copied}`,
    ]);
    expect(result.stderr.trimEnd()).toBe(
      `install: ${join(skills, "frontend-design")} is a symlink, left alone`,
    );
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe(UNMARKED("frontend-design"));
    expect(readFileSync(join(copied, "SKILL.md"), "utf8")).toBe(MARKED("frontend-design"));
  });

  // A bin that npx started inherits npm_execpath (npm-cli.js) and npm_node_execpath, and npx-cli.js sits beside
  // npm-cli.js, so the CLI runs under node with no shell on any platform; a two-word value stays one argument.
  test("under npx, runs npm's own npx-cli.js through node, with a two-word flag value as one argument", () => {
    const result = run(["-g", "-a", "codex claude-code"], { npxOnPath: false, underNpx: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(
      printed(commands(["-g", "-a", "codex claude-code", "-y", "-a", "universal"])),
    );
    expect(result.calls).toEqual(
      commands(["-g", "-a", "codex claude-code", "-y", "-a", "universal"]).map((argv) => [
        "npx-cli.js",
        ...argv.slice(1),
      ]),
    );
  });

  test("by hand without npx on PATH: one line pointing at npx, exit 1, no stack", () => {
    const result = run(["-g"], { npxOnPath: false });
    expect(result.status).toBe(1);
    // The first command prints before its launch fails; nothing else does.
    expect(result.stdout).toEqual(printed(commands(["-g", "-y", "-a", "universal"]).slice(0, 1)));
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

  /** A malformed catalog file and the one line the bin prints for it, which names `file`. */
  interface CatalogCase {
    readonly name: string;
    readonly files: { manifest?: string; marketplace: string };
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
