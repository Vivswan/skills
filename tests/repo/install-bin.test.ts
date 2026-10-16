// reaches: bin/install.mjs .claude-plugin/marketplace.json .claude-plugin/plugin.json
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

// A stub npx first on PATH: it logs its argv, one call per line with a unit separator between arguments so the
// boundaries survive, and exits 0, or 3 on the call STUB_FAIL_AT names.
const SEPARATOR = String.fromCharCode(0x1f);
const FAKE_NPX = `#!/usr/bin/env bash
{ printf 'npx'; printf '\\x1f%s' "$@"; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
if [ -n "\${STUB_FAIL_AT}" ] && [ "$(wc -l < "\${STUB_ARGS_LOG}")" -eq "\${STUB_FAIL_AT}" ]; then exit 3; fi
exit 0
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string[];
  readonly stderr: string;
  readonly calls: string[][];
}

function run(args: readonly string[], env: Record<string, string> = {}, withStub = true): Run {
  const dir = temp.dir("install-bin-");
  if (withStub) {
    writeFileSync(join(dir, "npx"), FAKE_NPX);
    chmodSync(join(dir, "npx"), 0o755);
  }
  const log = join(dir, "argv.log");
  // With the stub, PATH keeps the real one behind it so `/usr/bin/env bash` resolves; without, PATH is the empty dir.
  const proc = spawnSync(NODE, [BIN, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: withStub ? `${dir}:${process.env.PATH}` : dir,
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
    const result = run(args, env);
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.stdout).toEqual(stdout);
  });

  test("a missing npx is a failure with its reason, never a silent pass", () => {
    const result = run(["-g"], {}, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^install: .*ENOENT/);
    expect(result.calls).toEqual([]);
  });
});
