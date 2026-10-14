#!/usr/bin/env bun
// The GitHub source: PRs and branch tips, read through gh's GraphQL once a minute while something
// moves, backing off to every five while nothing does. The daemon is the session-events skill's,
// installed beside this one; `npx skills add --skill` copies one folder, so a single-skill install
// is told what else to add.
//
//   bun "<skill-dir>/scripts/github-events.mts" daemon          # once per session, as a BACKGROUND task
//   bun "<skill-dir>/scripts/github-events.mts" watch owner/repo#12 --expect-workflow checks
//   bun "<skill-dir>/scripts/github-events.mts" watch owner/repo:main

import type { EventInput, Io } from "../../session-events/scripts/session-events.mts";
import { GhError } from "./github/gh.mts";
import { type RepoRead, type RepoReply, readRepository } from "./github/repository.mts";
import {
  type BranchTarget,
  branchLabel,
  parseBranchTarget,
  processBranch,
} from "./targets/branch.mts";
import { type PrTarget, parsePrTarget, prLabel, processPr } from "./targets/pr.mts";

const INSTALL = "npx skills add Vivswan/skills -g --skill session-events";
// Reads of one target failing this many polls in a row (its detail, its paged suites) are one
// trouble event for that target; the repository read failing is the whole poll's failure.
const READ_FAILURES = 3;

type Target = PrTarget | BranchTarget;

let base: typeof import("../../session-events/scripts/session-events.mts");
try {
  base = await import("../../session-events/scripts/session-events.mts");
} catch {
  console.error(
    `the session-events skill is not installed beside this one; install it beside this skill: ${INSTALL}`,
  );
  process.exit(2);
}
const { runEvents, UsageError } = base;

function parseTarget(args: string[]): Target {
  const [text, ...flags] = args;
  const gates = new Set<string>();
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i + 1];
    if (flags[i] !== "--expect-workflow") throw new UsageError(`unknown option: ${flags[i]}`);
    if (name === undefined || name.trim() === "" || name.startsWith("--")) {
      throw new UsageError("--expect-workflow needs a workflow name");
    }
    gates.add(name);
  }
  const target =
    parsePrTarget(text as string, [...gates].sort()) ??
    parseBranchTarget(text as string, [...gates].sort());
  if (target === null) {
    throw new UsageError(`target must be <owner/repo>#<n> or <owner/repo>:<branch>, got: ${text}`);
  }
  return target;
}

/**
 * One request per repository: the rows and tips of its targets, with the suites of the heads still
 * being judged. A head with named gates is read every poll: a gate re-run can change the verdict
 * while an unrelated workflow holds the aggregate rollup where it was.
 */
function readAll(targets: Record<string, Target>): Map<string, RepoReply> {
  const reads = new Map<string, RepoRead>();
  for (const target of Object.values(targets)) {
    const read = reads.get(target.repo) ?? {
      prs: [],
      branches: [],
      suitesFor: { prs: new Set(), branches: new Set() },
    };
    const pending = target.seen === null || target.seen.ci === "pending" || target.gates.length > 0;
    if (target.form === "pr") {
      read.prs.push(target.number);
      if (pending) read.suitesFor.prs.add(target.number);
    } else {
      read.branches.push(target.branch);
      if (pending) read.suitesFor.branches.add(target.branch);
    }
    reads.set(target.repo, read);
  }
  const replies = new Map<string, RepoReply>();
  for (const [repo, read] of reads) replies.set(repo, readRepository(repo, read));
  return replies;
}

async function poll(targets: Record<string, Target>, io: Io) {
  // Every read first, then every judgment: a failed repository read fails the poll before any
  // cursor has moved. A failed detail read leaves its one target as it was, to retry next poll.
  const replies = readAll(targets);
  const events: EventInput[] = [];
  let busy = false;
  for (const [key, target] of Object.entries(targets)) {
    const reply = replies.get(target.repo) as RepoReply;
    try {
      const outcome =
        target.form === "pr"
          ? processPr(target, reply.rows.get(target.number) ?? null, io)
          : processBranch(target, reply.tips.get(target.branch) ?? null, io);
      events.push(...outcome.events);
      busy ||= outcome.busy;
      if (outcome.done) delete targets[key];
      else delete target.readFailures;
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      io.log(`${key}: ${error.message}`);
      busy = true;
      target.readFailures = (target.readFailures ?? 0) + 1;
      if (target.readFailures === READ_FAILURES) {
        const label = target.form === "pr" ? prLabel(target) : branchLabel(target);
        events.push({
          repo: target.repo,
          ...(target.form === "pr" ? { pr: target.number } : { branch: target.branch }),
          sha: null,
          kind: "trouble",
          text: `${label}: ${READ_FAILURES} reads failed; read the daemon log`,
          url:
            target.form === "pr"
              ? `https://github.com/${target.repo}/pull/${target.number}`
              : `https://github.com/${target.repo}/tree/${target.branch}`,
        });
      }
    }
  }
  return { events, busy };
}

runEvents<Target>({
  name: "github-events",
  interval: 60,
  idleInterval: 300,
  usage: [
    "targets: <owner/repo>#<n> for a pull request, <owner/repo>:<branch> for a branch tip",
    "--expect-workflow <name> names a workflow whose run must appear on the head before CI reads green; repeatable",
    `the session-events skill must be installed beside this one; without it every command exits 2 naming the install: ${INSTALL}`,
  ],
  parseTarget,
  poll,
});
