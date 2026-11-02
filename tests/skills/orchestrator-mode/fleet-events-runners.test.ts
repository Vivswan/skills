// What would drift silently without this: the fleet daemon's reading of the state files acp-runner.mts
// writes for the ACP builders. The phases and the stop reason become the builder rows the lead acts on:
// started and prompted as notes, a turn that ended and an adapter that died as alerts said once, a
// permission or a turn standing too long as alerts repeated as their duration doubles, a stop as a
// note, a vanished file as gone, an unreadable one as trouble, and a target saved before the runners
// map existed reading as no runners.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import {
  digest,
  type Program,
  Scenario,
  sessionEventsHarness,
} from "../../helpers/session-events-scenario";

sessionEventsHarness();
const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "fleet-events.mts");
const PROGRAM: Program = { script: SCRIPT, source: "fleet-events", env: () => ({}) };
const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
// Fixed, so a rewritten fixture is the same runner instance; a restart names a new one.
const STARTED_AT = "2026-01-01T09:00:00.000Z";
const RESTARTED_AT = "2026-01-01T09:30:00.000Z";

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** A session directory as Claude Code lays one out, with no agents: the runners are the whole fleet here. */
function sessionDir(root: string): string {
  const dir = join(root, SESSION);
  mkdirSync(join(dir, "subagents"), { recursive: true });
  writeFileSync(join(root, `${SESSION}.jsonl`), "");
  return dir;
}

/** A runner's state file as acp-runner.mts writes it, in the runtime directory the daemon reads (the scenario's own). */
function runnerState(s: Scenario, name: string, patch: Record<string, unknown>): string {
  const file = join(s.dir, `${name}.acp-runner.state.json`);
  writeFileSync(
    file,
    JSON.stringify({
      name,
      pid: 4242,
      adapter: ["codex-acp"],
      cwd: "/home/user/repo/wt",
      sessionId: "s1",
      phase: "idle",
      startedAt: STARTED_AT,
      lastUpdateAt: null,
      lastStop: null,
      steering: false,
      endedAt: null,
      reason: null,
      ...patch,
    }),
  );
  return file;
}

/** The saved target as JSON holds it, for the rewrites the tests make while the daemon is stopped. */
interface SavedTarget {
  runners: Record<string, { said: { duration: number; repeats: number } } | undefined>;
}

function polled(s: Scenario, inbox: string): number {
  const result = s.run(["poll"], { inbox });
  expect(result.code).toBe(0);
  return Number(/polled; (\d+) event\(s\)/.exec(result.stdout)?.[1]);
}

/** The builder and trouble rows the log holds, newest last, as level and text. */
function rows(s: Scenario): Array<[string, string]> {
  return s
    .events()
    .filter(
      (event) => event.kind === "builder" || event.kind === "trouble" || event.kind === "restored",
    )
    .map((event) => [event.level as string, event.text]);
}

/** The `summary` lines `status` prints under the one target. */
function standing(s: Scenario, inbox: string): string[] {
  const out = s.run(["status"], { inbox }).stdout.split("\n");
  return out.filter((line) => line.startsWith("    ")).map((line) => line.slice(4));
}

describe("fleet-events.mts, the ACP builders", () => {
  test("a builder's life: started, prompted, stuck past --quiet-after and repeated as it doubles, the turn's end said once, stopped, gone", async () => {
    const s = new Scenario(PROGRAM, "runner-life");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session, "--quiet-after", "10"], { inbox: box.path }).code).toBe(0);
    expect(polled(s, box.path)).toBe(0);

    const file = runnerState(s, "parser", {});
    expect(polled(s, box.path)).toBe(1);
    runnerState(s, "parser", { phase: "busy", lastUpdateAt: ago(1) });
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([
      ["note", "builder parser: started"],
      ["note", "builder parser: prompted"],
    ]);

    // Past the bound the stall is an alert, silent while it holds, repeated once its duration doubles: the
    // saved alert is rewound to a 6-minute reading while the daemon is stopped, so the next poll sees 12.
    runnerState(s, "parser", { phase: "busy", lastUpdateAt: ago(12) });
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(standing(s, box.path)).toEqual(["builder parser: stuck 12 min, no update mid-turn"]);
    s.stop({ inbox: box.path });
    const saved = s.state();
    for (const target of Object.values(saved.targets) as SavedTarget[]) {
      (target.runners.parser as { said: { duration: number } }).said.duration = 6;
    }
    writeFileSync(s.files().state, JSON.stringify(saved));
    await s.start({ inbox: box.path });
    polled(s, box.path);
    expect(rows(s).slice(2)).toEqual([
      ["alert", "builder parser: stuck 12 min, no update mid-turn"],
      ["alert", "builder parser: stuck 12 min, no update mid-turn"],
    ]);
    expect((Object.values(s.state().targets)[0] as SavedTarget).runners.parser?.said.repeats).toBe(
      1,
    );

    // The turn's end replaces the stall, once; a stop is a note, once; the file gone is a note.
    runnerState(s, "parser", { phase: "idle", lastStop: "end_turn", lastUpdateAt: ago(0) });
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    // A session update the adapter sends while idle moves lastUpdateAt; it is not another turn.
    runnerState(s, "parser", { phase: "idle", lastStop: "end_turn", lastUpdateAt: ago(0) });
    expect(polled(s, box.path)).toBe(0);
    runnerState(s, "parser", {
      phase: "ended",
      reason: "stopped",
      endedAt: ago(0),
      lastStop: "end_turn",
    });
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    // A runner restarted under the same name is a new builder: its start and its own stop are said again.
    runnerState(s, "parser", { pid: 4343, startedAt: RESTARTED_AT });
    expect(polled(s, box.path)).toBe(1);
    runnerState(s, "parser", {
      pid: 4343,
      startedAt: RESTARTED_AT,
      phase: "ended",
      reason: "stopped",
      endedAt: ago(0),
    });
    expect(polled(s, box.path)).toBe(1);
    rmSync(file);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s).slice(4)).toEqual([
      ["alert", "builder parser: idle, turn ended end_turn"],
      ["note", "builder parser: stopped"],
      ["note", "builder parser: started"],
      ["note", "builder parser: stopped"],
      ["note", "builder parser: gone"],
    ]);
    expect(s.events().map((event) => event.url)).toContain(`file://${file}`);
    expect(standing(s, box.path)).toEqual([]);
    s.stop({ inbox: box.path });
  }, 30_000);

  test("a permission standing too long alerts and retracts when the turn runs on, a dead adapter alerts once with no started note, an unreadable file is trouble until it reads, and a target saved before the runners map reads as no runners", async () => {
    const s = new Scenario(PROGRAM, "runner-edges");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session], { inbox: box.path }).code).toBe(0);

    runnerState(s, "docs", { phase: "permission", lastUpdateAt: ago(6) });
    runnerState(s, "tests", { phase: "ended", reason: "adapter exited 1", endedAt: ago(1) });
    runnerState(s, "broken", { phase: "busy", lastUpdateAt: 42 });
    expect(polled(s, box.path)).toBe(4);
    expect(rows(s)).toEqual([
      ["alert", "fleet: builder broken: not a runner state"],
      ["note", "builder docs: started"],
      ["alert", "builder docs: waiting on permission 6 min"],
      ["alert", "builder tests: adapter ended (adapter exited 1)"],
    ]);
    // The message carries the alerts alone; the notes stay in the log.
    const frame = digest((await box.frames(1))[0] as string, "fleet-events");
    expect(frame).toContain("builder docs: waiting on permission 6 min");
    expect(frame).toContain("builder tests: adapter ended (adapter exited 1)");
    expect(frame).not.toContain("builder docs: started");

    runnerState(s, "docs", { phase: "busy", lastUpdateAt: ago(0) });
    runnerState(s, "broken", {});
    expect(polled(s, box.path)).toBe(3);
    expect(rows(s).slice(4)).toEqual([
      ["note", "fleet: reading restored"],
      ["note", "builder broken: started"],
      ["note", "builder docs: fine again"],
    ]);

    // A state this daemon's predecessor saved has no runners map: it reads as none, and the next poll sights them again.
    s.stop({ inbox: box.path });
    const state = s.state();
    for (const target of Object.values(state.targets) as Record<string, unknown>[])
      delete target.runners;
    writeFileSync(s.files().state, JSON.stringify(state));
    await s.start({ inbox: box.path });
    // The daemon polls once as it starts; the explicit poll only makes sure that one has run.
    polled(s, box.path);
    expect(rows(s).slice(7)).toEqual([
      ["note", "builder broken: started"],
      ["note", "builder docs: started"],
      ["alert", "builder tests: adapter ended (adapter exited 1)"],
    ]);
    s.stop({ inbox: box.path });
  }, 30_000);

  test("two watched sessions share one runtime directory: each builder line is said once", async () => {
    const s = new Scenario(PROGRAM, "runner-two-targets");
    const box = await s.inbox("a");
    const first = sessionDir(s.fixtureDir);
    const second = sessionDir(join(s.fixtureDir, "other"));
    await s.start({ inbox: box.path });
    expect(s.run(["watch", first], { inbox: box.path }).code).toBe(0);
    expect(s.run(["watch", second], { inbox: box.path }).code).toBe(0);
    runnerState(s, "parser", { phase: "idle", lastStop: "end_turn", lastUpdateAt: ago(0) });
    expect(polled(s, box.path)).toBe(2);
    expect(rows(s)).toEqual([
      ["note", "builder parser: started"],
      ["alert", "builder parser: idle, turn ended end_turn"],
    ]);
    s.stop({ inbox: box.path });
  }, 30_000);
});
