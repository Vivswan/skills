import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inboxToken } from "../skills/watch-prs-and-ci/scripts/inbox.mts";
import {
  deadSocketFile,
  fakeProc,
  HEAD_A,
  PR7,
  prEventsHarness,
  REPO,
  SCRIPT,
  Scenario,
  T1,
} from "./helpers/pr-events-scenario";

// The PR-events daemon's start: the control socket, gh's place in the preflight, and the owner
// whose life the daemon follows. The harness (./helpers/pr-events-scenario.ts)
// owns the stub gh, the fake inbox, and every daemon a test starts; tests/pr-events.test.ts holds
// the rest of the daemon's contract.

const { emptyBinDir, temp } = prEventsHarness();

describe("pr-events.mts daemon start", () => {
  test("gh missing from PATH: the daemon exits 2 naming the tool", async () => {
    const s = new Scenario("nogh");
    const box = await s.inbox("a");
    const daemon = await s.start({ inbox: box.path, env: { PATH: emptyBinDir } });
    expect(await daemon.exited).toBe(2);
    expect(await new Response(daemon.stderr as ReadableStream).text()).toContain(
      "gh not found on PATH",
    );
    expect(existsSync(s.socketPath())).toBe(false);
  }, 30000);

  test("a second start without gh finds the running daemon and exits 0: gh is required only by the daemon that will poll", async () => {
    const s = new Scenario("nogh-running");
    const box = await s.inbox("a");
    const daemon = await s.start({ inbox: box.path });
    const second = s.run(["daemon"], { inbox: box.path, env: { PATH: emptyBinDir } });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("already serves");
    expect(second.stderr).not.toContain("gh not found");
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
      `daemon: running (pid ${daemon.pid})`,
    );
    s.stop({ inbox: box.path });
  }, 30000);

  test("CLAUDE_CODE_TMPDIR is a runtime directory ahead of the OS temp dir, which does not read it", async () => {
    const s = new Scenario("ladder");
    const box = await s.inbox("a");
    const env = s.env({ inbox: box.path });
    delete env.PR_EVENTS_DIR;
    delete env.XDG_RUNTIME_DIR;
    const result = Bun.spawnSync([process.execPath, SCRIPT, "status"], {
      env: { ...env, CLAUDE_CODE_TMPDIR: join(s.dir, "cc-tmp") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(3);
    const uid = process.getuid?.() ?? 0;
    expect(result.stderr.toString()).toContain(
      ` on ${join(s.dir, "cc-tmp", `pr-events-${uid}`, `${process.pid}.sock`)};`,
    );
  }, 30000);

  test("the daemon exits on its own, socket removed, once the session whose inbox named it is gone", async () => {
    // Started as a background task, nothing else ends it when the session exits; left running it
    // would poll GitHub for a session that can no longer read the events.
    const s = new Scenario("owner-gone");
    const session = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const inboxPath = join(s.dir, `${session.pid}.inbox`, `${session.pid}.sock`);
    mkdirSync(join(s.dir, `${session.pid}.inbox`));
    const daemon = await s.start({ inbox: inboxPath });
    const socket = s.socketPath(String(session.pid));
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
    expect(s.log(String(session.pid))).toContain(`session ${session.pid} exited`);
  }, 30000);

  test("a second daemon for the same session exits 0 saying so and leaves the first serving; a stale socket file is replaced", async () => {
    const s = new Scenario("second");
    const box = await s.inbox("a");
    deadSocketFile(s.socketPath());
    const first = await s.start({ inbox: box.path });
    expect(s.log()).toContain("replacing the stale control socket");
    const second = await s.start({ inbox: box.path });
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stdout as ReadableStream).text()).toContain(
      "another pr-events daemon already serves",
    );
    expect(first.exitCode).toBeNull();
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
      `daemon: running (pid ${first.pid})`,
    );
    // The second daemon touched neither the log nor the state: a running daemon that has saved
    // a poll it has not yet appended must stay the only writer. The state names an event the log
    // lacks; a daemon that read it before finding the socket taken would have appended it.
    const seventeen = {
      id: 17,
      at: T1,
      repo: REPO,
      pr: 7,
      sha: null,
      kind: "comment",
      text: "late",
      url: "",
    };
    writeFileSync(s.file("state.json"), JSON.stringify({ lastEventId: 17, lastPoll: [seventeen] }));
    const logBefore = existsSync(s.file("events.jsonl"))
      ? readFileSync(s.file("events.jsonl"), "utf-8")
      : "";
    const third = await s.start({ inbox: box.path });
    expect(await third.exited).toBe(0);
    const logAfter = existsSync(s.file("events.jsonl"))
      ? readFileSync(s.file("events.jsonl"), "utf-8")
      : "";
    expect(logAfter).toBe(logBefore);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a live pid whose start token changed is another process: the daemon ends as if the owner exited", async () => {
    // The owner check compared the pid alone; a session that died and a stranger that took its
    // pid kept the daemon polling, and a new session with that pid would have received its events.
    const s = new Scenario("owner-replaced");
    const box = await s.inbox("a");
    const proc = fakeProc("111");
    const daemon = await s.start({ inbox: box.path, env: { PR_EVENTS_PROC: proc.dir } });
    proc.set("222");
    const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => "still alive")]);
    expect(exited).toBe(0);
    expect(s.log()).toContain(`pid ${process.pid} now belongs to another process`);
  }, 30000);

  test("an owner start token that cannot be read is unknown, logged once, and never a mismatch", async () => {
    // A /proc that turns unreadable mid-session must not read as a replaced owner.
    const s = new Scenario("token-unreadable");
    const box = await s.inbox("a");
    const proc = fakeProc("111");
    const daemon = await s.start({ inbox: box.path, env: { PR_EVENTS_PROC: proc.dir } });
    chmodSync(proc.entry, 0);
    try {
      await Bun.sleep(2500);
      expect(daemon.exitCode).toBeNull();
      expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
        `daemon: running (pid ${daemon.pid})`,
      );
      expect(
        s
          .log()
          .split("\n")
          .filter((l) => l.includes("start token cannot be read")),
      ).toHaveLength(1);
    } finally {
      chmodSync(proc.entry, 0o700);
    }
    s.stop({ inbox: box.path });
  }, 30000);

  test("a control socket path that is not a socket (a dangling symlink) is refused with its path, not retried forever", async () => {
    const s = new Scenario("not-a-socket");
    const box = await s.inbox("a");
    symlinkSync(join(s.dir, "nowhere"), s.socketPath());
    const daemon = await s.start({ inbox: box.path });
    expect(await Promise.race([daemon.exited, Bun.sleep(5000).then(() => "still running")])).toBe(
      2,
    );
    expect(await new Response(daemon.stderr as ReadableStream).text()).toContain(
      `${s.socketPath()} is not a socket; remove it`,
    );
  }, 30000);

  test("the inbox socket is an owner's start token where /proc has none: one file, one token; two files, two", () => {
    // A session creates its inbox socket afresh, so a recycled pid comes with another inode or
    // creation time; a token that changed between two reads of one live file would set a live
    // session's own targets aside.
    const dir = temp.dir("inbox-token-");
    const first = join(dir, "1.sock");
    const second = join(dir, "2.sock");
    writeFileSync(first, "");
    writeFileSync(second, "");
    expect(inboxToken(first)).not.toBeNull();
    expect(inboxToken(first)).toBe(inboxToken(first));
    expect(inboxToken(first)).not.toBe(inboxToken(second));
    expect(inboxToken(join(dir, "gone.sock"))).toBeNull();
  });

  test("a recycled session pid does not inherit the earlier session's targets: a saved state with another start token is set aside", async () => {
    // State files are keyed by pid, and pids come back around; a new session given an exited
    // session's pid would otherwise poll its PRs and receive its events. The token is the
    // process start from /proc, else the inbox socket file's identity, so every platform checks.
    const s = new Scenario("recycled-pid");
    const box = await s.inbox("a");
    writeFileSync(
      s.file("state.json"),
      JSON.stringify({
        owner: { pid: process.pid, start: "an-earlier-incarnation" },
        prs: { [PR7]: { head: null, expected: ["ci"] } },
        lastEventId: 3,
      }),
    );
    // The earlier session's events are its own too: `wait --since 0` and `status` in the new
    // session must not read them, so the log is moved aside and the new counter starts at zero.
    const oldLine = JSON.stringify({
      id: 3,
      at: T1,
      repo: REPO,
      pr: 7,
      sha: HEAD_A,
      kind: "comment",
      text: "1 new comment by bob\n  bob  the earlier session's business",
      url: `https://github.com/${REPO}/pull/7`,
    });
    writeFileSync(s.file("events.jsonl"), `${oldLine}\n`);
    await s.start({ inbox: box.path });
    const moved = s.file("events.an-earlier-incarnation.jsonl");
    expect(s.log()).toContain(
      `the saved state belonged to an earlier session with pid ${process.pid}; this session starts with no targets; its events were moved to ${moved}`,
    );
    expect(readFileSync(moved, "utf-8")).toBe(`${oldLine}\n`);
    expect(existsSync(s.file("state.an-earlier-incarnation.json"))).toBe(true);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("prs: 0");
    const nothing = s.run(["wait", "--since", "0", "--timeout", "1"], { inbox: box.path });
    expect(nothing.code).toBe(4);
    expect(nothing.stdout).not.toContain("earlier session's business");
    s.stop({ inbox: box.path });
    const saved = JSON.parse(readFileSync(s.file("state.json"), "utf-8"));
    expect(saved.owner.pid).toBe(process.pid);
    expect(saved.owner.start).not.toBe("an-earlier-incarnation");
    expect(saved.lastEventId).toBe(0);
  }, 30000);
});
