#!/usr/bin/env bun
// Bridge Claude Code cross-session messaging to a session on another machine over SSH.
//
//   bun bridge.mts <ssh-destination> [remote-pid] [-- <extra ssh options>]
//
// Run from a shell inside a Claude Code session (it sets CLAUDE_CODE_MESSAGING_SOCKET).
// Nothing is copied between the machines. Each session's inbox socket is forwarded to
// the other machine at the path it has at home, because a reply goes to the absolute
// socket path found in the message's `from` field.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

type SessionRecord = {
  pid: number;
  name: string;
  startedAt: number;
  messagingSocketPath: string;
};

const args = parseArgs(process.argv.slice(2));
const localSocket = requireEnv("CLAUDE_CODE_MESSAGING_SOCKET");
// ControlPath=none: with connection sharing in the user's ssh config the forwards would
// belong to a shared master that outlives this process, so teardown could not remove them.
const ssh = [
  "ssh",
  "-o",
  "ControlPath=none",
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ConnectTimeout=10", // bounds each handshake; ServerAliveInterval only covers an open session
  ...args.sshOptions,
];
// The short commands (lookup, precheck, probe, cleanup) drop any forward the user's ssh
// config adds for this host; a LocalForward there would collide with the tunnel's copy.
const sshCommand = [...ssh, "-o", "ClearAllForwardings=yes"];

const remote = await pickRemoteSession(await listLiveRemoteSessions(), args.remotePid);
const remoteSocket = remote.messagingSocketPath;
if (existsSync(remoteSocket)) {
  fail(
    `${remoteSocket} already exists on this machine (a local session has the same pid as the remote one, or a stale forward is left over); restart one session or remove the socket`,
  );
}
await prepareRemoteSocketPath();
mkdirSync(dirname(remoteSocket), { recursive: true, mode: 0o700 });

// From here on ssh may have bound a socket on either side, so every exit, a signal
// included, goes through shutdown().
let shuttingDown = false;
const tunnel = openTunnel();
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
await waitForForwards();
console.log(
  `bridge up: ${remote.name} (pid ${remote.pid} on ${args.destination}), bridge pid ${process.pid}`,
);
console.log(`SendMessage to: uds:${remoteSocket}`);
console.log(`they reply to:  uds:${localSocket}`);

const sshExit = await tunnel.exited;
await shutdown(`ssh exited (${sshExit})`, sshExit === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const sshOptions = dash === -1 ? [] : argv.slice(dash + 1);
  const [destination, remotePid] = own;
  if (!destination)
    fail("usage: bun bridge.mts <ssh-destination> [remote-pid] [-- <extra ssh options>]");
  return { destination, remotePid, sshOptions };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set; run this from a Claude Code session's shell`);
  return value;
}

// The lookup runs as a python program fed on stdin, so the remote account's login shell
// (bash, zsh, fish) plays no part in parsing. A registry record can outlive its session,
// so a session counts as live only when its pid answers a signal-0 and its inbox socket
// still exists. A record that cannot be parsed or inspected is reported, never silently dropped.
async function listLiveRemoteSessions(): Promise<SessionRecord[]> {
  const program = `
import json, os, stat, sys
sessions = os.path.expanduser("~/.claude/sessions")
try:
    names = sorted(n for n in os.listdir(sessions) if n.endswith(".json"))
except FileNotFoundError:
    names = []  # Claude Code never ran here: an empty registry, not a failed read
except OSError as e:
    print(f"cannot read {sessions}: {e}", file=sys.stderr)
    sys.exit(2)
for path in (os.path.join(sessions, n) for n in names):
    try:
        with open(path) as f:
            record = json.load(f)
        pid, sock = record["pid"], record["messagingSocketPath"]
    except Exception as e:
        print(f"unreadable registry record {path}: {e}", file=sys.stderr)
        continue
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        continue
    except PermissionError:
        pass  # another account's process: alive, which is all the probe asks
    try:
        if not stat.S_ISSOCK(os.stat(sock).st_mode):
            continue
    except FileNotFoundError:
        continue
    except OSError as e:
        print(f"cannot inspect {sock} named by {path}: {e}", file=sys.stderr)
        continue
    print(json.dumps(record))
`;
  const result = await $`${sshCommand} ${args.destination} python3 - < ${new Response(program)}`
    .quiet()
    .nothrow();
  const warnings = result.stderr.toString().trim();
  if (warnings) console.error(warnings);
  if (result.exitCode !== 0) {
    fail(
      `could not read the session registry on ${args.destination} (exit ${result.exitCode}; is python3 installed there?)`,
    );
  }
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function pickRemoteSession(
  live: SessionRecord[],
  wantedPid?: string,
): Promise<SessionRecord> {
  if (wantedPid === undefined) {
    const newest = live.sort((a, b) => b.startedAt - a.startedAt)[0];
    if (newest === undefined)
      fail(`no live Claude Code session with a messaging socket on ${args.destination}`);
    return newest;
  }
  const match = live.find((r) => String(r.pid) === wantedPid);
  if (!match) {
    const names = live.map((r) => `${r.pid} (${r.name})`).join(", ");
    fail(`pid ${wantedPid} is not a live session on ${args.destination}; live: ${names}`);
  }
  return match;
}

// Our inbox is forwarded to the remote at its home path. With different uids the socket
// directories differ (/tmp/cc-socks-<uid>), so the directory is created there; and the
// path must be free, or teardown would later delete a socket that belongs to a remote session.
async function prepareRemoteSocketPath() {
  // One string, so the remote shell sees the whole conditional; interpolated as separate
  // words, Bun's shell would run the `&&` and the `test` on this machine. Distinct exit
  // codes keep "occupied" apart from "no writable directory" and ssh failures. `mkdir -p`
  // accepts a directory that already exists, so writability is checked as well: a leftover
  // owned by another account would otherwise surface later as a failed reverse forward.
  const dir = shellQuote(dirname(localSocket));
  const remoteCommand = `mkdir -p -m 700 ${dir} && test -w ${dir} || exit 3; test ! -e ${shellQuote(localSocket)} || exit 4`;
  const result = await $`${sshCommand} ${args.destination} ${remoteCommand}`.quiet().nothrow();
  if (result.exitCode === 0) return;
  if (result.exitCode === 4) {
    fail(
      `${localSocket} already exists on ${args.destination} (a session there has this pid, or a stale forward is left over); refusing to forward over it`,
    );
  }
  const detail = result.stderr.toString().trim();
  if (result.exitCode === 3)
    fail(
      `could not create a writable ${dirname(localSocket)} on ${args.destination}${detail ? `: ${detail}` : " (it exists but is not writable by that account)"}`,
    );
  fail(`ssh to ${args.destination} failed (exit ${result.exitCode}): ${detail}`);
}

function openTunnel() {
  const forwardTheirInboxHere = ["-L", `${remoteSocket}:${remoteSocket}`];
  const forwardOurInboxThere = ["-R", `${localSocket}:${localSocket}`];
  return Bun.spawn(
    [...ssh, "-N", ...forwardTheirInboxHere, ...forwardOurInboxThere, args.destination],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

// ssh creates the -L socket before it learns whether the server accepted the -R, so the
// local socket alone is not proof. Ready means all three at once: ssh still running, the
// -L socket here, the -R socket on the remote. Until the deadline a missing one is "not yet".
async function waitForForwards() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (shuttingDown) await new Promise(() => {}); // a signal began teardown; it ends the process
    if (tunnel.exitCode !== null)
      await shutdown(`ssh exited (${tunnel.exitCode}) before the forwards came up`, 1);
    if (existsSync(remoteSocket)) {
      const reverse =
        await $`${sshCommand} ${args.destination} ${`test -S ${shellQuote(localSocket)}`}`
          .quiet()
          .nothrow();
      if (reverse.exitCode === 0 && tunnel.exitCode === null) return;
      // Exit 1 is `test` saying the socket is not there yet; anything else is the probe's own ssh failing.
      if (reverse.exitCode !== 0 && reverse.exitCode !== 1)
        await shutdown(
          `could not verify the reverse forward on ${args.destination} (ssh exit ${reverse.exitCode}): ${reverse.stderr.toString().trim()}`,
          1,
        );
    }
    if (Date.now() > deadline)
      await shutdown(
        existsSync(remoteSocket)
          ? `reverse forward did not bind ${localSocket} on ${args.destination} within 60 s (ssh is up, so the socket is not visible at that path there: a different /tmp view, or a bind still pending)`
          : `forwarded socket ${remoteSocket} never appeared within 60 s`,
        1,
      );
    await Bun.sleep(500);
  }
}

async function shutdown(reason: string, exitCode: number): Promise<never> {
  if (shuttingDown) return new Promise(() => {}); // the first caller's teardown ends the process
  shuttingDown = true;
  console.log(`\n${reason}: tearing down bridge`);
  tunnel.kill();
  rmSync(remoteSocket, { force: true });
  const remoteCleanup =
    await $`${sshCommand} ${args.destination} ${`rm -f ${shellQuote(localSocket)}`}`
      .quiet()
      .nothrow();
  if (remoteCleanup.exitCode !== 0) {
    console.error(
      `remote cleanup failed (ssh exit ${remoteCleanup.exitCode}); remove ${localSocket} on ${args.destination} by hand`,
    );
    process.exit(1);
  }
  console.log("cleanup done");
  process.exit(exitCode);
}

// Paths inside a command string are parsed again by the remote login shell, so they are
// single-quoted there (a space in CLAUDE_CODE_TMPDIR is otherwise split into two words).
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
