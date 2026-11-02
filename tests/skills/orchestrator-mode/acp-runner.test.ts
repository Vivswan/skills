// What would drift silently without this: the runner's contract with an ACP adapter and with the
// lead's commands, read back from the files the fleet monitor will read: the state's phases and
// stop reasons, the events log, the owner's permission rule (every command runs, a file tool
// inside the worktree runs, one outside is refused), busy and cancel, and the three exits.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import { tempDirs } from "../../helpers/temp-dirs";

const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "acp-runner.mts");
const STUB = join(ROOT, "tests", "helpers", "acp-agent-stub.ts");
const temp = tempDirs();

const binDir = temp.dir("acp-runner-bin-");
writeFileSync(
  join(binDir, "codex-acp"),
  `#!/usr/bin/env bash\n# The adapter runs the stub from its real path, where the SDK resolves.\nexec bun "${STUB}" "$@"\n`,
);
chmodSync(join(binDir, "codex-acp"), 0o755);

const READ_ONLY_MODES = {
  currentModeId: "read-only",
  availableModes: [
    { id: "read-only", name: "Read-only", description: "" },
    { id: "workspace-write", name: "Workspace", description: "" },
  ],
};

interface State {
  phase: string;
  sessionId: string | null;
  lastStop: string | null;
  steering: boolean;
  reason: string | null;
  adapter: string[];
}

interface EventLine {
  kind: string;
  update?: { sessionUpdate: string };
  title?: string;
  allowed?: boolean;
  outside?: string[];
  answer?: string;
  stopReason?: string;
  reason?: string;
  text?: string;
}

let names = 0;
const live: { dir: string; proc: ReturnType<typeof Bun.spawn>; stop: () => void }[] = [];

/** A runner a failed assertion left running would outlive its test: each is stopped here, and one that does not
 * answer is killed with its adapter, whose pid the stub wrote. */
afterEach(async () => {
  for (const runner of live.splice(0)) {
    if (runner.proc.exitCode !== null) continue;
    runner.stop();
    await Promise.race([runner.proc.exited, Bun.sleep(5_000)]);
    if (runner.proc.exitCode === null) runner.proc.kill("SIGKILL");
    try {
      process.kill(Number(readFileSync(join(runner.dir, "pid"), "utf8")), "SIGKILL");
    } catch {
      // no adapter pid, or the adapter already gone
    }
  }
});

/** One runner against the stub: its own runtime dir, worktree, and scenario; the commands run through the same script. */
function startRunner(scenario: object, flags: string[] = [], env: Record<string, string> = {}) {
  names += 1;
  const name = `b${names}`;
  const dir = temp.dir("acp-runner-");
  const runtime = join(dir, "rt");
  const worktree = join(dir, "wt");
  mkdirSync(runtime);
  mkdirSync(worktree);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const environment = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    SESSION_EVENTS_DIR: runtime,
    STUB_SCENARIO: join(dir, "scenario.json"),
    STUB_VIOLATIONS: join(dir, "violations"),
    STUB_PERMISSIONS: join(dir, "permissions"),
    STUB_PROMPT_COPY: join(dir, "prompt"),
    STUB_ARGS_LOG: join(dir, "args"),
    STUB_PID_FILE: join(dir, "pid"),
    ...env,
  };
  const proc = Bun.spawn(
    [
      process.execPath,
      SCRIPT,
      "start",
      "--name",
      name,
      "--cwd",
      worktree,
      ...flags,
      "--adapter",
      "codex-acp",
      "--yes",
    ],
    { env: environment, stdout: "pipe", stderr: "pipe" },
  );
  const files = {
    state: join(runtime, `${name}.acp-runner.state.json`),
    events: join(runtime, `${name}.acp-runner.events.jsonl`),
    socket: join(runtime, `${name}.acp-runner.sock`),
  };
  const command = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, SCRIPT, args[0] as string, "--name", name, ...args.slice(1)],
      {
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: result.exitCode,
      stdout: result.stdout.toString().trimEnd(),
      stderr: result.stderr.toString(),
    };
  };
  live.push({ dir, proc, stop: () => void command("stop") });
  return {
    name,
    dir,
    worktree,
    files,
    proc,
    command,
    state: (): State => JSON.parse(readFileSync(files.state, "utf8")) as State,
    events: (): EventLine[] =>
      readFileSync(files.events, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventLine),
    violations: () =>
      existsSync(join(dir, "violations")) ? readFileSync(join(dir, "violations"), "utf8") : "",
    async exit(): Promise<{ code: number; stdout: string; stderr: string }> {
      const code = await proc.exited;
      return {
        code,
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
      };
    },
  };
}

/** Polls until the predicate holds; the first start also bundles the script, so the bound is generous. */
function waitFor(what: string, predicate: () => boolean, ms = 60_000): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // a file not written yet
    }
    Bun.sleepSync(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function waitForSocket(runner: ReturnType<typeof startRunner>): void {
  waitFor(
    `${runner.name} to serve`,
    () => existsSync(runner.files.socket) && runner.state().phase === "idle",
  );
}

function waitForPhase(runner: ReturnType<typeof startRunner>, phase: string): void {
  waitFor(`${runner.name} to be ${phase}`, () => runner.state().phase === phase, 20_000);
}

describe("acp-runner.mts", () => {
  test("start opens the session in the requested mode, a prompt runs a turn to end_turn, and each permission is answered by the owner's rule and recorded", async () => {
    const runner = startRunner(
      {
        modes: READ_ONLY_MODES,
        expectMode: "workspace-write",
        turns: [
          [
            {
              type: "tool",
              title: "git status",
              kind: "execute",
              permission: true,
              output: "clean",
            },
            {
              type: "tool",
              title: "write a.ts",
              kind: "edit",
              permission: true,
              locations: [{ path: "a.ts" }],
              onReject: "continue",
            },
            {
              type: "tool",
              title: "write /etc/x",
              kind: "edit",
              permission: true,
              locations: [{ path: "/etc/x" }],
              onReject: "continue",
            },
            { type: "message", text: "done" },
            { type: "stop", reason: "end_turn" },
          ],
        ],
      },
      ["--mode", "workspace-write"],
    );
    waitForSocket(runner);
    expect(runner.state()).toMatchObject({
      phase: "idle",
      sessionId: "stub-session-1",
      steering: false,
      adapter: ["codex-acp", "--yes"],
    });
    const status = runner.command("status");
    expect(status.code).toBe(0);
    expect((JSON.parse(status.stdout) as State).phase).toBe("idle");

    const prompt = runner.command("prompt", "review the diff");
    expect(prompt).toMatchObject({ code: 0, stdout: "prompted" });
    waitFor("the stop", () => runner.events().some((event) => event.kind === "stop"), 20_000);
    expect(readFileSync(join(runner.dir, "prompt"), "utf8")).toBe("review the diff");
    expect(
      runner
        .events()
        .map((event) =>
          `${event.kind} ${event.update?.sessionUpdate ?? event.title ?? event.stopReason ?? ""}`.trimEnd(),
        ),
    ).toEqual([
      "started",
      "prompt",
      "update tool_call",
      "permission git status",
      "update tool_call_update",
      "update tool_call",
      "permission write a.ts",
      "update tool_call_update",
      "update tool_call",
      "permission write /etc/x",
      "update tool_call_update",
      "update agent_message_chunk",
      "stop end_turn",
    ]);
    expect(
      runner
        .events()
        .filter((event) => event.kind === "permission")
        .map((event) => [event.allowed, event.outside, event.answer]),
    ).toEqual([
      [true, [], "allow_once"],
      [true, [], "allow_once"],
      [false, ["/etc/x"], "cancel"],
    ]);
    expect(
      readFileSync(join(runner.dir, "permissions"), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { chosen: string }).chosen),
    ).toEqual(["allow_once", "allow_once", "cancel"]);
    waitForPhase(runner, "idle");
    expect(runner.state().lastStop).toBe("end_turn");
    expect(runner.violations()).toBe("");

    expect(runner.command("stop")).toMatchObject({ code: 0, stdout: "stopped" });
    const exit = await runner.exit();
    expect(exit.code).toBe(0);
    expect(exit.stdout).toMatch(
      /^acp-runner b\d+ pid \d+: codex-acp --yes in .*; session stub-session-1; socket .*; state .*\n$/,
    );
    expect(runner.state()).toMatchObject({ phase: "ended", reason: "stopped" });
    expect(existsSync(runner.files.socket)).toBe(false);
    expect(runner.command("status").code).toBe(3);
    // The adapter's own flag rode through --adapter, and the adapter is gone once stop returned.
    expect(readFileSync(join(runner.dir, "args"), "utf8")).toBe("--yes\n");
    const adapterPid = Number(readFileSync(join(runner.dir, "pid"), "utf8"));
    expect(adapterPid).toBeGreaterThan(0);
    expect(() => process.kill(adapterPid, 0)).toThrow();
  }, 90_000);

  test("the permission rule follows a symlink to where it lands, judges a path not there yet by its deepest existing ancestor, and refuses what it cannot judge", async () => {
    const runner = startRunner({
      modes: READ_ONLY_MODES,
      turns: [
        [
          {
            type: "tool",
            title: "write new/deep/a.ts",
            kind: "edit",
            permission: true,
            locations: [{ path: "new/deep/a.ts" }],
            onReject: "continue",
          },
          {
            type: "tool",
            title: "write link",
            kind: "edit",
            permission: true,
            locations: [{ path: "link" }],
            onReject: "continue",
          },
          {
            type: "tool",
            title: "write via/inner.ts",
            kind: "edit",
            permission: true,
            locations: [{ path: "via/inner.ts" }],
            onReject: "continue",
          },
          {
            type: "tool",
            title: "write link/../x.ts",
            kind: "edit",
            permission: true,
            locations: [{ path: "link/../x.ts" }],
            onReject: "continue",
          },
          {
            type: "tool",
            title: "write ..cache/a.ts",
            kind: "edit",
            permission: true,
            locations: [{ path: "..cache/a.ts" }],
            onReject: "continue",
          },
          { type: "stop", reason: "end_turn" },
        ],
      ],
    });
    waitForSocket(runner);
    // link -> a missing file outside the tree; via -> a directory outside the tree.
    symlinkSync(join(runner.dir, "outside", "new.ts"), join(runner.worktree, "link"));
    mkdirSync(join(runner.dir, "elsewhere"));
    symlinkSync(join(runner.dir, "elsewhere"), join(runner.worktree, "via"));
    expect(runner.command("prompt", "go")).toMatchObject({ code: 0, stdout: "prompted" });
    waitFor("the stop", () => runner.events().some((event) => event.kind === "stop"), 20_000);
    expect(
      runner
        .events()
        .filter((event) => event.kind === "permission")
        .map((event) => [event.title, event.allowed, event.outside]),
    ).toEqual([
      ["write new/deep/a.ts", true, []],
      ["write link", false, ["link"]],
      ["write via/inner.ts", false, ["via/inner.ts"]],
      ["write link/../x.ts", false, ["link/../x.ts"]],
      ["write ..cache/a.ts", true, []],
    ]);
    runner.command("stop");
    expect((await runner.exit()).code).toBe(0);
  }, 90_000);

  test("a prompt during a turn is refused as busy with exit 1, and cancel ends the turn cancelled", async () => {
    const runner = startRunner({
      modes: READ_ONLY_MODES,
      turns: [
        [
          { type: "sleep", ms: 5000 },
          { type: "message", text: "late" },
        ],
      ],
    });
    waitForSocket(runner);
    expect(runner.command("prompt", "take your time")).toMatchObject({
      code: 0,
      stdout: "prompted",
    });
    waitForPhase(runner, "busy");
    expect(runner.command("prompt", "and this")).toMatchObject({ code: 1, stdout: "busy" });
    expect(runner.command("cancel")).toMatchObject({ code: 0, stdout: "cancelled" });
    waitForPhase(runner, "idle");
    expect(runner.state().lastStop).toBe("cancelled");
    expect(runner.events().filter((event) => event.kind === "cancel")).toHaveLength(1);
    runner.command("stop");
    expect((await runner.exit()).code).toBe(0);
  }, 90_000);

  test("an adapter that dies mid-turn ends the runner: the state names the exit and start leaves with 1", async () => {
    const runner = startRunner({ modes: READ_ONLY_MODES, turns: [[{ type: "exit", code: 7 }]] });
    waitForSocket(runner);
    expect(runner.command("prompt", "go")).toMatchObject({ code: 0, stdout: "prompted" });
    waitForPhase(runner, "ended");
    expect(runner.state().reason).toBe("adapter exited 7");
    const exit = await runner.exit();
    expect(exit.code).toBe(1);
    expect(runner.events().at(-1)).toMatchObject({ kind: "ended", reason: "adapter exited 7" });
  }, 90_000);

  test("a mode the adapter does not advertise is a usage error naming the offered modes, exit 2, and the adapter is gone", async () => {
    const runner = startRunner(
      {
        modes: {
          currentModeId: "plan",
          availableModes: [{ id: "plan", name: "Plan", description: "" }],
        },
        turns: [],
      },
      ["--mode", "read-only"],
    );
    const exit = await runner.exit();
    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain('the adapter offers no mode "read-only"; it offers: plan');
    expect(existsSync(runner.files.socket)).toBe(false);
  }, 90_000);

  test("a second start under a name that is serving is refused with exit 2; --allow-outside lets an outside location through", async () => {
    const runner = startRunner(
      {
        modes: READ_ONLY_MODES,
        turns: [
          [
            {
              type: "tool",
              title: "write /etc/x",
              kind: "edit",
              permission: true,
              locations: [{ path: "/etc/x" }],
            },
            { type: "stop", reason: "end_turn" },
          ],
        ],
      },
      ["--allow-outside"],
    );
    waitForSocket(runner);
    const second = Bun.spawnSync(
      [
        process.execPath,
        SCRIPT,
        "start",
        "--name",
        runner.name,
        "--cwd",
        runner.worktree,
        "--adapter",
        "codex-acp",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SESSION_EVENTS_DIR: join(runner.dir, "rt"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(second.exitCode).toBe(2);
    expect(second.stderr.toString()).toContain("already serves");
    expect(runner.command("prompt", "--file", join(runner.dir, "scenario.json"))).toMatchObject({
      code: 0,
      stdout: "prompted",
    });
    waitFor("the stop", () => runner.events().some((event) => event.kind === "stop"), 20_000);
    expect(runner.events().find((event) => event.kind === "permission")).toMatchObject({
      allowed: true,
      outside: [],
      answer: "allow_once",
    });
    expect(readFileSync(join(runner.dir, "prompt"), "utf8")).toBe(
      readFileSync(join(runner.dir, "scenario.json"), "utf8"),
    );
    runner.command("stop");
    expect((await runner.exit()).code).toBe(0);
  }, 90_000);

  test("usage errors exit 2 without starting anything: no name, no adapter, a relative cwd, an unknown command", () => {
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SESSION_EVENTS_DIR: temp.dir("acp-runner-usage-"),
    };
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
    for (const [args, reason] of [
      [["start", "--cwd", "/tmp", "--adapter", "codex-acp"], "start requires --name"],
      [["start", "--name", "b", "--cwd", "/tmp"], "start requires --adapter"],
      [
        ["start", "--name", "b", "--cwd", "relative", "--adapter", "codex-acp"],
        "--cwd must be an existing absolute directory",
      ],
      [
        ["start", "--name", "Bad Name", "--cwd", "/tmp", "--adapter", "codex-acp"],
        "--name must match",
      ],
      [
        ["start", "--name", "b", "--adapter", "codex-acp", "--cwd", "/tmp"],
        "--cwd must be an existing absolute directory",
      ],
      [["frobnicate", "--name", "b"], "unknown command: frobnicate"],
      [["stop", "--name", "b", "--bogus"], "Unknown option '--bogus'"],
      [["stop", "--name", "b", "extra"], "stop takes no argument: extra"],
      [["prompt", "--name", "b"], "prompt needs <text> or --file <path>"],
    ] as [string[], string][]) {
      const result = run(...args);
      expect(result.exitCode, args.join(" ")).toBe(2);
      expect(result.stderr.toString(), args.join(" ")).toContain(reason);
    }
    expect(run("status", "--name", "nobody").exitCode).toBe(3);
  });
});
