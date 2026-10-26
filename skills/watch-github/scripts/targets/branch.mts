// A branch tip as a target, `owner/repo:branch`: its head moves and its CI verdicts, judged with
// the gates named on it. It stays watched through every push; a merged PR adds nothing, since the
// mainline it merged into is a branch target.

import type { EventInput, Io } from "../../../session-events/scripts/session-events.mts";
import type { Suites } from "../github/check-suites.mts";
import type { Tip } from "../github/repository.mts";
import { type CiHead, type CiState, carriedCi, judgeCi, rollupPending } from "./ci.mts";

const BRANCH_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(.+)$/;

export interface BranchTarget {
  /** The tag the daemon dispatches on; a PrTarget's is "pr". */
  form: "branch";

  /** owner/repo, the key the poll groups its reads by. */
  repo: string;

  /** The branch name, read as refs/heads/<branch>. */
  branch: string;

  /** The --expect-workflow names, sorted; the head is judged by their latest runs, not the rollup alone. */
  gates: string[];

  /** The cursor: the tip at the last poll, where its CI judgment stands, and the verdict last delivered on it. */
  seen: {
    /** The tip's commit; a different one next poll is a head move. */
    oid: string;

    /** The rollup at the last poll; one that moved after a verdict is judged again. */
    rollupState: string | null;

    /** Where the judgment stands; "pending" holds the busy interval and a suites read every poll. */
    ci: CiState;

    /** The last delivered verdict's key (ci.mts verdictKey). */
    verdict: string | null;

    /** Polls on this head with no checks at all (no rollup), for a named gate that never registers. */
    noRuns: number;
  } | null;

  /** Set once the tip answered null and the trouble event went out; cleared when it reads again. */
  unreadable?: boolean;

  /** Reads of this one target (paged suites) that failed in a row; three are one trouble event. */
  readFailures?: number;
}

export function parseBranchTarget(text: string, gates: string[]): BranchTarget | null {
  const match = BRANCH_PATTERN.exec(text);
  if (match === null) return null;
  return {
    form: "branch",
    repo: match[1] as string,
    branch: match[2] as string,
    gates,
    seen: null,
  };
}

export function branchLabel(target: BranchTarget): string {
  return `branch ${target.repo}:${target.branch}`;
}

/** What a target's poll yields: its events, whether it holds the busy interval, and whether it is finished (a merged or closed PR) and leaves the map. */
export interface Outcome {
  events: EventInput[];
  busy: boolean;
  done: boolean;
}

/** The outcome of a target GitHub answered null for: the trouble event once, then silence until it reads again. */
export function unreadableOutcome(target: { unreadable?: boolean }, event: EventInput): Outcome {
  if (target.unreadable) return { events: [], busy: false, done: false };

  target.unreadable = true;
  return { events: [event], busy: true, done: false };
}

export function processBranch(
  target: BranchTarget,
  reply: { tip: Tip; suites: Suites | null } | null,
  io: Io,
): Outcome {
  const label = branchLabel(target);
  const fields = { repo: target.repo, branch: target.branch };
  if (reply === null) {
    return unreadableOutcome(target, {
      ...fields,
      sha: null,
      kind: "trouble",
      text: `${label} is not readable; unwatch it or check access`,
      url: `https://github.com/${target.repo}/tree/${target.branch}`,
    });
  }

  const { tip, suites } = reply;
  const previous = target.seen;
  const events: EventInput[] = [];
  const sha = tip.oid;
  const commitUrl = `https://github.com/${target.repo}/commit/${sha}`;
  const moved = previous !== null && previous.oid !== sha;
  if (moved) {
    events.push({
      ...fields,
      sha,
      kind: "head",
      text: `${label}: head moved to ${sha.slice(0, 12)}; last commit by ${tip.author ?? "an unknown author"}`,
      url: commitUrl,
    });
  }

  const rollupMoved = previous !== null && previous.rollupState !== tip.rollupState;
  const head: CiHead = {
    label,
    repo: target.repo,
    sha,
    rollupState: tip.rollupState,
    suites,
    gates: target.gates,
    checksUrl: `${commitUrl}/checks`,
  };
  const judged = judgeCi(carriedCi(previous, moved, rollupMoved), head, io.log);
  if (judged.event !== null) {
    const { kind, text, url } = judged.event;
    events.push({ ...fields, sha, kind, text, url });
  }

  delete target.unreadable;
  target.seen = { oid: sha, rollupState: tip.rollupState, ...judged.cursor };
  // Pending CI holds the busy interval; a head with no CI does not. The ci term covers the poll a
  // rollup change is first seen on, and a named gate's run still registering or queued.
  return {
    events,
    busy: rollupPending(tip.rollupState) || events.length > 0 || judged.cursor.ci === "pending",
    done: false,
  };
}
