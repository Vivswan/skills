#!/usr/bin/env bun
// A source for the daemon's own tests: its events come from hand-written fixtures, one file per
// poll, so a test drives the daemon's delivery, log, state, and shutdown without a system behind
// it. `FAKE_SOURCE_DIR/poll-<n>.json` serves poll n; when it is missing, the highest-numbered
// fixture below n repeats. A fixture:
//
//   { "events": [{ "target": "t1", "kind": "note", "text": "hello", "url": "https://example.com/t1" }],
//     "busy": true,
//     "sleepMs": 2000,
//     "fail": "boom" }
//
// `fail` makes the poll throw after the sleep; `polls.log` in the same directory gets one line per
// poll, `<n> <when> <the watched keys>`, so a test can ask when polls ran.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runEvents, UsageError } from "../../skills/session-events/scripts/session-events.mts";

type Target = { name: string; polls: number };
type Fixture = {
  events?: Array<{ target: string; kind: string; text: string; url: string }>;
  busy?: boolean;
  sleepMs?: number;
  fail?: string;
};

function fixtureDir(): string {
  const dir = process.env.FAKE_SOURCE_DIR;
  if (dir === undefined) throw new Error("FAKE_SOURCE_DIR is unset");
  return dir;
}

function readFixture(poll: number): Fixture {
  for (let n = poll; n >= 1; n -= 1) {
    const path = join(fixtureDir(), `poll-${n}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as Fixture;
  }
  return {};
}

function pollsSoFar(): number {
  const path = join(fixtureDir(), "polls.log");
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean).length : 0;
}

runEvents<Target>({
  // A test gives the daemon a name it must refuse.
  name: process.env.FAKE_SOURCE_NAME ?? "fake-events",
  interval: 1,
  idleInterval: 4,
  parseTarget([name, ...flags]) {
    if (name === undefined || !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new UsageError(`watch needs a target name of letters, digits, _ or -, got: ${name}`);
    }
    if (flags.length > 0) throw new UsageError(`unknown option: ${flags[0]}`);
    return { name, polls: 0 };
  },
  async poll(targets) {
    const n = pollsSoFar() + 1;
    appendFileSync(
      join(fixtureDir(), "polls.log"),
      `${n} ${Date.now()} ${Object.keys(targets).join(",")}\n`,
    );
    const fixture = readFixture(n);
    if (fixture.sleepMs !== undefined) await Bun.sleep(fixture.sleepMs);
    // The cursor a real source keeps: how many polls have seen each target. Moved before a
    // failure throws, the way a careless source would: the daemon must not save it.
    for (const target of Object.values(targets)) target.polls += 1;
    if (fixture.fail !== undefined) throw new Error(fixture.fail);
    return { events: fixture.events ?? [], busy: fixture.busy ?? false };
  },
});
