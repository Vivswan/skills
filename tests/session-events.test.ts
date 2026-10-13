import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";
import {
  closingLine,
  deadSocketFile,
  digest,
  digestHeadlines,
  type Program,
  parseFrame,
  Scenario,
  sessionEventsHarness,
} from "./helpers/session-events-scenario";

// Contract tests for the session-events daemon on the fake source (./fixtures/fake-source.mts):
// the frame and its envelope, the CLI and its exit codes, the owner whose life the daemon
// follows, the control socket, the events log and the saved state, `wait`, the failure counting,
// and the two intervals. What a poll reads and says is a source's business and is tested with
// the source.

const FAKE_SOURCE = join(ROOT, "tests", "fixtures", "fake-source.mts");
const LOG_SOURCE = join(ROOT, "skills", "session-events", "scripts", "examples", "log-source.mts");
const NAME = "fake-events";
const CLOSING = closingLine(NAME);
const START = `bun "${FAKE_SOURCE}" daemon`;

type FixtureEvent = { target: string; kind: string; text: string; url: string };
type Fixture = { events?: FixtureEvent[]; busy?: boolean; sleepMs?: number; fail?: string };

const note = (target: string, text: string): FixtureEvent => ({
  target,
  kind: "note",
  text,
  url: `https://example.com/${target}`,
});

const FAKE: Program = {
  script: FAKE_SOURCE,
  source: NAME,
  env: (scenario) => ({ FAKE_SOURCE_DIR: scenario.fixtureDir }),
};

class Fake extends Scenario {
  constructor(name: string) {
    super(FAKE, name);
  }

  /** The fixtures polls 1..n read, in order. */
  polls(...fixtures: Fixture[]): void {
    const files: Record<string, string> = {};
    fixtures.forEach((fixture, i) => {
      files[`poll-${i + 1}`] = JSON.stringify(fixture);
    });
    this.fixtures(files);
  }

  /** `[poll number, when it ran, the watched keys]` per poll, as the fake records them. */
  pollLog(): Array<[number, number, string]> {
    const path = join(this.fixtureDir, "polls.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .map((line) => {
        const [n, at, keys] = line.split(" ");
        return [Number(n), Number(at), keys ?? ""];
      });
  }
}

const text = (raw: string) => digest(raw, NAME);
const headlines = (frames: string[]) => digestHeadlines(frames, NAME);

const { temp, started } = sessionEventsHarness();

describe("session-events.mts", () => {
  test("the frame on the wire: one connection, one line, the events in the peer envelope naming the control socket and the source; the text goes out as the source wrote it, with no fence, boundary, or escaping; the log line carries the source's fields", async () => {
    // A child of the session is delivered without a hold, but a bare frame renders as the owner's
    // own typing; the envelope is what names the sender. The text is the source's own words,
    // never quoted from the polled system, so the daemon has nothing to fence or escape.
    const s = new Fake("frame");
    const box = await s.inbox("a");
    s.polls(
      { events: [note("t1", "t1: hello"), note("t2", "t2: 3 new rows")] },
      // A source field named id or at does not renumber the log: the daemon's own win.
      { events: [{ ...note("t1", "t1: plain"), id: 0, at: "source-time" } as FixtureEvent] },
    );
    await s.start({ inbox: box.path });
    const r = s.run(["watch", "t1"], { inbox: box.path });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`watching t1 for session ${process.pid}; 1 target(s)\n`);
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const frame = parseFrame(frames[0] as string);
    expect(frame.type).toBe("user");
    expect(frame.message.role).toBe("user");
    expect(frame.message.content.split("\n")).toEqual([
      `<cross-session-message from="uds:${s.socketPath()}" from-name="${NAME}">`,
      "t1: hello",
      "https://example.com/t1",
      "",
      "t2: 3 new rows",
      "https://example.com/t2",
      CLOSING,
      "</cross-session-message>",
    ]);
    expect(frame.from).toBe(`uds:${s.socketPath()}`);
    expect(frame.from_name).toBe(NAME);
    expect(Object.keys(frame).sort()).toEqual(["from", "from_name", "message", "msg_id", "type"]);
    expect(frame.msg_id).toMatch(new RegExp(`^${NAME}-1-`));
    const [event] = s.events();
    expect(Object.keys(event as object)).toEqual(["id", "at", "target", "kind", "text", "url"]);
    expect(event).toMatchObject({ id: 1, target: "t1", kind: "note", text: "t1: hello" });
    expect(s.run(["poll"], { inbox: box.path }).stdout).toBe("polled; 1 event(s)\n");
    expect(text((await box.frames(2))[1] as string)).toBe(
      ["t1: plain", "https://example.com/t1", CLOSING].join("\n"),
    );
    expect(s.events()[2]).toMatchObject({ id: 3, kind: "note", text: "t1: plain" });
    expect(s.events()[2]?.at).not.toBe("source-time");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a quote, an angle bracket, or an ampersand in the runtime directory is escaped in the envelope's from attribute; the frame's own from carries the path as it is", async () => {
    const s = new Fake("quoted-dir");
    const box = await s.inbox("a");
    const dir = join(s.dir, 'a"b<c>&d');
    const env = { SESSION_EVENTS_DIR: dir };
    s.polls({ events: [note("t1", "hello")] });
    const daemon = s.spawn(["daemon"], { inbox: box.path, env });
    started.push(daemon);
    const socket = join(dir, `${process.pid}.${NAME}.sock`);
    const deadline = Date.now() + 5000;
    while (!existsSync(socket) && Date.now() < deadline) await Bun.sleep(20);
    expect(s.run(["watch", "t1"], { inbox: box.path, env }).code).toBe(0);
    const frame = parseFrame((await box.frames(1))[0] as string);
    expect(frame.from).toBe(`uds:${socket}`);
    expect(frame.message.content.split("\n")[0]).toBe(
      `<cross-session-message from="uds:${join(s.dir, "a&quot;b&lt;c&gt;&amp;d", `${process.pid}.${NAME}.sock`)}" from-name="${NAME}">`,
    );
    expect(s.run(["stop"], { inbox: box.path, env }).code).toBe(0);
    expect(await daemon.exited).toBe(0);
  }, 30000);

  test("outside a session without --id, with a bad --id, with --pid on a session, with an unknown command or option, with an interval off the scale, or with a target the source refuses, the command exits 2 before any socket or frame, and the usage block follows the reason", async () => {
    const s = new Fake("usage");
    const box = await s.inbox("a");
    const cases: Array<[string[], { inbox?: string }, string]> = [
      [["status"], {}, "CLAUDE_CODE_MESSAGING_SOCKET is unset"],
      [["daemon"], {}, "CLAUDE_CODE_MESSAGING_SOCKET is unset"],
      [["status", "--id", "bad/name"], {}, "--id must be a name"],
      [["status", "--id", "4242"], {}, "--id must not be all digits"],
      [["daemon", "--pid", "1"], { inbox: box.path }, "--pid applies to --id"],
      [["daemon", "--id", "x", "--pid", "abc"], {}, "--pid must be a positive whole number"],
      [
        ["daemon", "--interval", "0", "--id", "x"],
        {},
        "--interval must be a positive whole number",
      ],
      [["daemon", "--interval", "86401", "--id", "x"], {}, "--interval must be 1 to 86400 seconds"],
      [["frobnicate"], { inbox: box.path }, "unknown command: frobnicate"],
      [["status", "--verbose"], { inbox: box.path }, "unknown option: --verbose"],
      [["status", "extra"], { inbox: box.path }, "unexpected extra argument: extra"],
      [["watch"], { inbox: box.path }, "watch needs a target"],
      [["watch", "no spaces"], { inbox: box.path }, "watch needs a target name of letters"],
      [["watch", "t1", "--head", "x"], { inbox: box.path }, "unknown option: --head"],
      [["unwatch"], { inbox: box.path }, "missing <target> or --all"],
      [["unwatch", "t1", "--all"], { inbox: box.path }, "--all takes no target"],
      [["wait", "--since", "x"], { inbox: box.path }, "--since must be a whole number"],
      [["status"], { inbox: join(s.dir, "inbox.sock") }, "cannot tell the session's pid"],
    ];
    for (const [args, options, reason] of cases) {
      const r = s.run(args, options);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 2]);
      expect(r.stderr).toContain(reason);
      expect(r.stderr.trim().split("\n").at(-1)).toBe("--interval is 1 s by default, 1 to 86400");
      expect(r.stderr).toContain(`usage: ${FAKE_SOURCE} <command> [options]`);
    }
    expect(existsSync(s.socketPath())).toBe(false);
    expect(await box.frames(0)).toEqual([]);
    expect(s.pollLog()).toEqual([]);
  }, 30000);

  test("with no daemon answering, watch, unwatch, status, and wait exit 3 naming the exact background command; stop is a no-op", async () => {
    // The CLI never starts the daemon: a child of the CLI would be a detached, cross-session
    // sender whose frames the session holds. The agent starts it, so the agent needs the command.
    const s = new Fake("nodaemon");
    const box = await s.inbox("a");
    for (const args of [
      ["watch", "t1"],
      ["unwatch", "--all"],
      ["status"],
      ["wait", "--timeout", "1"],
    ]) {
      const r = s.run(args, { inbox: box.path });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(`no ${NAME} daemon answers for session ${process.pid}`);
      expect(r.stderr).toContain(`\n  ${START}\n`);
    }
    const named = s.run(["status", "--id", "codex-12"]);
    expect(named.code).toBe(3);
    expect(named.stderr).toContain(`\n  ${START} --id codex-12\n`);
    const stopped = s.run(["stop"], { inbox: box.path });
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("no daemon running");
    expect(s.pollLog()).toEqual([]);
  }, 30000);

  test("CLAUDE_CODE_TMPDIR is a runtime directory ahead of the OS temp dir, which does not read it", async () => {
    const s = new Fake("ladder");
    const box = await s.inbox("a");
    const env = s.env({ inbox: box.path });
    delete env.SESSION_EVENTS_DIR;
    delete env.XDG_RUNTIME_DIR;
    // A short directory: the scenario's own would push the socket path past 104 bytes.
    const ccTmp = temp.dir("cc-");
    const result = Bun.spawnSync(s.command(["status"]), {
      env: { ...env, CLAUDE_CODE_TMPDIR: ccTmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const uid = process.getuid?.() ?? 0;
    expect([result.exitCode, result.stderr.toString()]).toEqual([
      3,
      expect.stringContaining(
        ` on ${join(ccTmp, `session-events-${uid}`, `${process.pid}.${NAME}.sock`)};`,
      ),
    ]);
  }, 30000);

  test("the file stems carry the session's pid and start token, the socket its pid alone, and a file sink's its id: a recycled pid opens other files and starts empty", async () => {
    const s = new Fake("stems");
    const box = await s.inbox("a");
    s.polls({ events: [note("t1", "one")] });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    const start = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
    const token = start.slice(start.lastIndexOf(")") + 2).split(" ")[19];
    expect(token).toMatch(/^\d+$/);
    const stem = join(s.dir, `${process.pid}-${token}.${NAME}`);
    expect(s.files()).toEqual({
      socket: join(s.dir, `${process.pid}.${NAME}.sock`),
      events: `${stem}.events.jsonl`,
      state: `${stem}.state.json`,
      log: `${stem}.log`,
    });
    for (const path of Object.values(s.files())) expect(existsSync(path)).toBe(true);
    s.stop({ inbox: box.path });
    expect(s.state().targets).toHaveProperty("t1");

    await s.start({ id: "probe" });
    expect(s.run(["watch", "t2", "--id", "probe"]).code).toBe(0);
    const sink = join(s.dir, `probe.${NAME}`);
    expect(s.files({ id: "probe" })).toEqual({
      socket: `${sink}.sock`,
      events: `${sink}.events.jsonl`,
      state: `${sink}.state.json`,
      log: `${sink}.log`,
    });
    expect(existsSync(`${sink}.state.json`)).toBe(true);
    s.stop({ id: "probe" });
  }, 30000);

  test("the daemon exits on its own, socket removed, once the session whose inbox named it is gone", async () => {
    // Started as a background task, nothing else ends it when the session exits; left running it
    // would poll for a session that can no longer read the events.
    const s = new Fake("owner-gone");
    const session = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const inboxPath = join(s.dir, `${session.pid}.inbox`, `${session.pid}.sock`);
    mkdirSync(join(s.dir, `${session.pid}.inbox`));
    const owner = { pid: session.pid, inbox: inboxPath };
    const daemon = await s.start({ inbox: inboxPath });
    // The stem's start token is read from /proc while the session lives.
    const { socket, log } = s.files(owner);
    expect(existsSync(socket)).toBe(true);
    expect(s.run(["status"], { inbox: inboxPath }).stdout).toContain(`for session ${session.pid}`);
    session.kill();
    await session.exited;
    const exit = await Promise.race([
      daemon.exited,
      Bun.sleep(5000).then(() => "timeout" as const),
    ]);
    expect(exit).toBe(0);
    expect(existsSync(socket)).toBe(false);
    expect(readFileSync(log, "utf-8")).toContain(`session ${session.pid} exited`);
    // A file sink with --pid ends with that process the same way, and without it runs until stop.
    const agent = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const sink = await s.start({ id: "agent", args: ["--pid", String(agent.pid)] });
    agent.kill();
    await agent.exited;
    expect(await Promise.race([sink.exited, Bun.sleep(5000).then(() => "timeout" as const)])).toBe(
      0,
    );
    expect(s.log({ id: "agent" })).toContain(`file sink agent exited`);
  }, 30000);

  test("a second daemon for the same session exits 0 saying so and leaves the first serving; a stale socket file is replaced once; the second touches neither the log nor the state", async () => {
    const s = new Fake("second");
    const box = await s.inbox("a");
    deadSocketFile(s.socketPath());
    const first = await s.start({ inbox: box.path });
    expect(s.log()).toContain("replacing the stale control socket");
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    const second = await s.start({ inbox: box.path });
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stdout as ReadableStream).text()).toContain(
      `another ${NAME} daemon already serves`,
    );
    expect(first.exitCode).toBeNull();
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
      `daemon: running (pid ${first.pid})`,
    );
    const stateBefore = readFileSync(s.files().state, "utf-8");
    const logLines = s.log().split("\n").length;
    const third = await s.start({ inbox: box.path });
    expect(await third.exited).toBe(0);
    expect(readFileSync(s.files().state, "utf-8")).toBe(stateBefore);
    // Two lines: the third daemon's own, and the first's note of the probe that connected and left.
    expect(s.log().split("\n").length).toBe(logLines + 2);
    expect(s.log()).toContain(`another daemon answers on ${s.socketPath()}; exiting`);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a watch on a connection accepted before the stop is refused, and a stop drains the poll in flight before the socket goes", async () => {
    // Released at once, the socket would let a replacement daemon start while this one still
    // delivers and saves over its state; answered ok, the watch would add work no poll runs.
    const s = new Fake("stop-drain");
    const box = await s.inbox("a");
    s.polls({ events: [note("t1", "one")] }, { events: [note("t2", "two")], sleepMs: 1500 });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    const held = connect(s.socketPath());
    await new Promise<void>((resolve) => held.once("connect", () => resolve()));
    const slow = s.spawn(["watch", "t2"], { inbox: box.path });
    await Bun.sleep(300);
    const stopped = Date.now();
    s.stop({ inbox: box.path });
    expect(Date.now() - stopped).toBeGreaterThanOrEqual(1000);
    expect(await slow.exited).toBe(0);
    expect(headlines(await box.frames(2))).toEqual(["one", "two"]);
    held.setEncoding("utf-8");
    const replied = new Promise<string>((resolve) => {
      let bytes = "";
      held.on("data", (chunk: string) => {
        bytes += chunk;
      });
      held.on("close", () => resolve(bytes));
    });
    held.write(
      `${JSON.stringify({ cmd: "watch", key: "t3", target: { name: "t3", polls: 0 } })}\n`,
    );
    expect(await replied).toBe('{"ok":false,"error":"daemon stopping; retry"}\n');
    expect(Object.keys(s.state().targets)).toEqual(["t1", "t2"]);
  }, 30000);

  test("two polls seconds apart deliver two messages at least a second apart, so the receiver keeps both", async () => {
    // The receiver drops a second frame from one sender within the same second; two `watch`
    // calls in a row each poll at once.
    const s = new Fake("gap");
    const box = await s.inbox("a");
    s.polls({ events: [note("t1", "one")] }, { events: [note("t2", "two")] });
    await s.start({ inbox: box.path });
    for (const target of ["t1", "t2"]) {
      // Spawned asynchronously, so the fake inbox stamps each arrival as it happens.
      const watch = s.spawn(["watch", target], { inbox: box.path });
      expect(await watch.exited).toBe(0);
    }
    expect(headlines(await box.frames(2))).toEqual(["one", "two"]);
    const [first, second] = box.arrivedAt as [number, number];
    expect(second - first).toBeGreaterThanOrEqual(1000);
    s.stop({ inbox: box.path });
  }, 30000);

  test("the log line and the state that counts it are on disk when the delivery arrives, the log written first; a refusing inbox leaves the line logged and the daemon up", async () => {
    // Delivered first, a daemon killed before writing would have sent an event no log carries;
    // the state first, and a daemon killed before the append would never send it at all. The log
    // first means a crash re-sends at most one poll.
    const live = new Fake("log-first");
    const box = await live.inbox("a");
    live.polls({ events: [note("t1", "one")] });
    await live.start({ inbox: box.path });
    // Spawned asynchronously: the fake inbox samples the files at the moment the daemon connects,
    // which a spawnSync would postpone until the CLI had exited.
    const watch = live.spawn(["watch", "t1"], { inbox: box.path });
    expect(await watch.exited).toBe(0);
    expect(await box.frames(1)).toHaveLength(1);
    expect(box.logAtConnect).toEqual([[1]]);
    expect(box.savedAtConnect).toEqual([1]);
    const { events, state } = live.files();
    expect(
      statSync(events, { bigint: true }).mtimeNs <= statSync(state, { bigint: true }).mtimeNs,
    ).toBe(true);
    live.stop({ inbox: box.path });

    const refused = new Fake("log-refused");
    const dead = join(refused.dir, "dead", `${process.pid}.sock`);
    mkdirSync(join(refused.dir, "dead"));
    deadSocketFile(dead);
    refused.polls({ events: [note("t1", "one")] });
    await refused.start({ inbox: dead });
    expect(refused.run(["watch", "t1"], { inbox: dead }).code).toBe(0);
    const owner = { pid: process.pid, inbox: dead };
    expect(refused.events(owner).map((e) => [e.id, e.kind])).toEqual([[1, "note"]]);
    expect(refused.log(owner)).toContain(`delivery of #1 to ${dead} failed: ECONNREFUSED`);
    expect(refused.run(["status"], { inbox: dead }).stdout).toContain("daemon: running");
    refused.stop({ inbox: dead });
  }, 30000);

  test("stop, fixtures advance, start again: the restarted daemon polls at once with the saved targets, the counter carries on, and a repeated watch starts its target over", async () => {
    const s = new Fake("restart");
    const box = await s.inbox("a");
    s.polls({ events: [note("t1", "one")] }, { events: [note("t1", "two")] }, { events: [] });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    s.stop({ inbox: box.path });
    expect(s.state()).toEqual({ targets: { t1: { name: "t1", polls: 1 } }, lastEventId: 1 });
    await s.start({ inbox: box.path });
    expect(headlines(await box.frames(2))).toEqual(["one", "two"]);
    expect(s.events().map((e) => e.id)).toEqual([1, 2]);
    expect(s.state().targets).toEqual({ t1: { name: "t1", polls: 2 } });
    // The key is the text the user typed; a second watch of it replaces the target, cursor and all.
    expect(s.run(["watch", "t1"], { inbox: box.path }).stdout).toContain("1 target(s)");
    expect(s.state().targets).toEqual({ t1: { name: "t1", polls: 1 } });
    s.stop({ inbox: box.path });
  }, 30000);

  test("wait --since returns only newer lines and the cursor, blocks until a poll appends, exits 4 at timeout, and exits 3 once the daemon is gone", async () => {
    const s = new Fake("wait");
    const id = ["--id", "probe"];
    s.polls(
      { events: [note("t1", "one")] },
      { events: [note("t1", "two")] },
      { events: [note("t1", "three")] },
      // The restarted daemon's own poll sees nothing new; the poll after it brings one event.
      { events: [] },
      { events: [note("t1", "four")] },
    );
    await s.start({ id: "probe" });
    expect(s.run(["watch", "t1", ...id]).code).toBe(0);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    const since1 = s.run(["wait", "--since", "1", "--timeout", "1", ...id]);
    expect(since1.code).toBe(0);
    const lines = since1.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 2, text: "two" });
    expect(lines[1]).toBe("cursor: 2");
    const timedOut = s.run(["wait", "--since", "2", "--timeout", "1", ...id]);
    expect(timedOut.code).toBe(4);
    expect(timedOut.stdout).toContain("cursor: 2");
    const blocking = s.spawn(["wait", "--since", "2", "--timeout", "20", ...id]);
    await Bun.sleep(300);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    expect(await blocking.exited).toBe(0);
    const unblocked = (await new Response(blocking.stdout as ReadableStream).text())
      .trim()
      .split("\n");
    expect(JSON.parse(unblocked[0] as string)).toMatchObject({ id: 3, text: "three" });
    expect(unblocked[1]).toBe("cursor: 3");
    // Without --since, the cursor is the daemon's counter: only what comes after the call.
    const fromNow = s.spawn(["wait", "--timeout", "1", ...id]);
    expect(await fromNow.exited).toBe(4);
    expect(await new Response(fromNow.stdout as ReadableStream).text()).toContain("cursor: 3");
    // A wait already running notices the stop: it used to reread the unchanged log until its
    // timeout and exit 4, half an hour later, where the reader expected the no-daemon exit.
    const orphaned = s.spawn(["wait", "--since", "3", "--timeout", "20", ...id]);
    await Bun.sleep(300);
    const stoppedAt = Date.now();
    s.stop({ id: "probe" });
    expect(await orphaned.exited).toBe(3);
    expect(Date.now() - stoppedAt).toBeLessThan(5000);
    expect(await new Response(orphaned.stdout as ReadableStream).text()).toContain("cursor: 3");
    expect(s.run(["wait", "--since", "3", "--timeout", "1", ...id]).code).toBe(3);
    // An event appended in the same second the daemon stops is read before the stop is declared:
    // the reader gets the line and the cursor past it, not exit 3 with the old cursor.
    await s.start({ id: "probe" });
    const lastWords = s.spawn(["wait", "--since", "3", "--timeout", "20", ...id]);
    await Bun.sleep(300);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    s.stop({ id: "probe" });
    expect(await lastWords.exited).toBe(0);
    const last = (await new Response(lastWords.stdout as ReadableStream).text()).trim().split("\n");
    expect(JSON.parse(last[0] as string)).toMatchObject({ id: 4, text: "four" });
    expect(last[1]).toBe("cursor: 4");
  }, 60000);

  test("three failed polls in a row are one trouble event pointing at the log, a fourth failure adds nothing, a success says nothing, and three more failures are one more; the daemon stays up", async () => {
    const s = new Fake("trouble");
    const box = await s.inbox("a");
    const boom = { fail: "boom" };
    const bang = { fail: "bang" };
    s.polls({ events: [] }, boom, boom, boom, boom, { events: [] }, bang, bang, bang);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    const counts: string[] = [];
    for (let i = 0; i < 8; i += 1) counts.push(s.run(["poll"], { inbox: box.path }).stdout.trim());
    expect(counts).toEqual([
      "polled; 0 event(s)",
      "polled; 0 event(s)",
      "polled; 1 event(s)",
      "polled; 0 event(s)",
      "polled; 0 event(s)",
      "polled; 0 event(s)",
      "polled; 0 event(s)",
      "polled; 1 event(s)",
    ]);
    const frames = await box.frames(2);
    expect(frames.map(text)).toEqual([
      [
        `${NAME}: the last 3 polls failed; read the daemon log for the reason`,
        s.files().log,
        CLOSING,
      ].join("\n"),
      [
        `${NAME}: the last 3 polls failed; read the daemon log for the reason`,
        s.files().log,
        CLOSING,
      ].join("\n"),
    ]);
    const [trouble] = s.events();
    expect(Object.keys(trouble as object)).toEqual(["id", "at", "kind", "text", "url"]);
    expect(trouble).toMatchObject({ id: 1, kind: "trouble" });
    const failed = s
      .log()
      .split("\n")
      .filter((line) => line.includes("poll failed"));
    expect(failed.map((line) => line.slice(line.indexOf("poll failed")))).toEqual([
      "poll failed (1 in a row): boom",
      "poll failed (2 in a row): boom",
      "poll failed (3 in a row): boom",
      "poll failed (4 in a row): boom",
      "poll failed (1 in a row): bang",
      "poll failed (2 in a row): bang",
      "poll failed (3 in a row): bang",
    ]);
    // A failed poll saves nothing: the cursor still counts the polls that returned.
    expect(s.state().targets).toEqual({ t1: { name: "t1", polls: 2 } });
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("daemon: running");
    s.stop({ inbox: box.path });
  }, 40000);

  test("a busy poll is followed after the busy interval, an idle one after the idle interval; --interval moves the busy one", async () => {
    const s = new Fake("intervals");
    const box = await s.inbox("a");
    s.polls({ busy: true }, { busy: false }, { busy: true });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    const deadline = Date.now() + 12000;
    while (s.pollLog().length < 4 && Date.now() < deadline) await Bun.sleep(50);
    const [one, two, three, four] = s.pollLog().map(([, at]) => at) as [
      number,
      number,
      number,
      number,
    ];
    expect(two - one).toBeGreaterThanOrEqual(900);
    expect(two - one).toBeLessThan(2500);
    expect(three - two).toBeGreaterThanOrEqual(2900);
    expect(four - three).toBeGreaterThanOrEqual(900);
    expect(four - three).toBeLessThan(2500);
    s.stop({ inbox: box.path });

    const slow = new Fake("intervals-flag");
    const slowBox = await slow.inbox("a");
    slow.polls({ busy: true });
    await slow.start({ inbox: slowBox.path, args: ["--interval", "2"] });
    expect(slow.log()).toContain("poll every 2 s busy, 3 s idle");
    slow.stop({ inbox: slowBox.path });
  }, 30000);

  test("status prints the daemon, its files, the targets by key, and the last event; unwatch drops one target by its key, or all of them, and refuses one not watched", async () => {
    const s = new Fake("status-unwatch");
    const box = await s.inbox("a");
    s.polls({ events: [note("t1", "first line\nsecond line")] }, { events: [] });
    const daemon = await s.start({ inbox: box.path });
    expect(s.run(["watch", "t1"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["watch", "t2"], { inbox: box.path }).stdout).toContain("2 target(s)");
    // A key is any text the user typed, the one that names an object's prototype included.
    expect(s.run(["watch", "__proto__"], { inbox: box.path }).stdout).toContain("3 target(s)");
    expect(Object.keys(s.state().targets)).toEqual(["t1", "t2", "__proto__"]);
    expect(s.run(["unwatch", "__proto__"], { inbox: box.path }).code).toBe(0);
    const { socket, log, events } = s.files();
    const status = s.run(["status"], { inbox: box.path }).stdout.split("\n");
    expect(status.slice(0, 7)).toEqual([
      `daemon: running (pid ${daemon.pid}) for session ${process.pid}`,
      `socket: ${socket}`,
      `log: ${log}`,
      `events: ${events}`,
      "targets: 2",
      "  t1",
      "  t2",
    ]);
    expect(status[7]).toMatch(/^last event: #1 at \S+ note: first line$/);
    const one = s.run(["unwatch", "t1"], { inbox: box.path });
    expect(one.code).toBe(0);
    expect(one.stdout).toBe(`unwatched t1 for session ${process.pid}\n`);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("targets: 1\n  t2\n");
    const unknown = s.run(["unwatch", "t9"], { inbox: box.path });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("daemon: t9 is not watched");
    const all = s.run(["unwatch", "--all"], { inbox: box.path });
    expect(all.code).toBe(0);
    expect(all.stdout).toBe(`unwatched everything for session ${process.pid}\n`);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("targets: 0");
    s.stop({ inbox: box.path });
  }, 30000);
});

describe("the example source", () => {
  test("the file watcher says when a file grows, shrinks, or goes, in bytes, and quotes none of it", async () => {
    const s = new Scenario(
      { script: LOG_SOURCE, source: "log-events", env: () => ({}) },
      "example",
    );
    const file = join(s.dir, "build.log");
    writeFileSync(file, "");
    const id = ["--id", "example"];
    await s.start({ id: "example" });
    expect(s.run(["watch", "relative.log", ...id]).stderr).toContain(
      "watch needs an absolute path",
    );
    expect(s.run(["watch", file, ...id]).stdout).toContain(
      `watching ${file} for file sink example`,
    );
    const line = "error[E0425]: cannot find value `conf`\n";
    appendFileSync(file, line);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    rmSync(file);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    expect(s.events({ id: "example" }).map((e) => [e.kind, e.text, e.url])).toEqual([
      ["changed", `${file}: 0 to ${Buffer.byteLength(line)} bytes`, `file://${file}`],
      ["gone", `${file}: gone`, `file://${file}`],
    ]);
    s.stop({ id: "example" });
  }, 30000);
});
