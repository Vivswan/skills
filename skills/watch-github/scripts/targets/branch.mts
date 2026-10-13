// A branch tip as a target, `owner/repo:branch`: its head moves and its CI verdicts, judged with
// the gates named on it. It stays watched through every push; a merged PR adds nothing, since the
// mainline it merged into is a branch target.

import type { EventInput, Io } from "../../../session-events/scripts/session-events.mts";
import { discoverRuns, type Suites } from "../github/check-suites.mts";
import type { Tip } from "../github/repository.mts";
import {
  type CiState,
  describeVerdict,
  judgeHead,
  NO_RUN_POLLS,
  rollupPending,
  verdictKey,
} from "./ci.mts";

const BRANCH_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(.+)$/;

export interface BranchTarget {
  form: "branch";
  repo: string;
  branch: string;
  gates: string[];
  /** The cursor: the tip at the last poll, where its CI judgment stands, and the verdict last delivered on it. */
  seen: {
    oid: string;
    rollupState: string | null;
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

export interface Outcome {
  events: EventInput[];
  busy: boolean;
  /** The target is finished (a merged or closed PR) and leaves the map. */
  done: boolean;
}

export function processBranch(
  target: BranchTarget,
  reply: { tip: Tip; suites: Suites | null } | null,
  io: Io,
): Outcome {
  const label = branchLabel(target);
  const fields = { repo: target.repo, branch: target.branch };
  if (reply === null) {
    if (target.unreadable) return { events: [], busy: false, done: false };
    target.unreadable = true;
    return {
      events: [
        {
          ...fields,
          sha: null,
          kind: "trouble",
          text: `${label} is not readable; unwatch it or check access`,
          url: `https://github.com/${target.repo}/tree/${target.branch}`,
        },
      ],
      busy: true,
      done: false,
    };
  }
  const { tip, suites } = reply;
  const previous = target.seen;
  const events: EventInput[] = [];
  const sha = tip.oid;
  const commitUrl = `https://github.com/${target.repo}/commit/${sha}`;
  let ci: CiState = previous?.ci ?? "pending";
  // The verdict last delivered on this head; a new head has none, so its first verdict is news.
  let verdict = previous !== null && previous.oid === sha ? previous.verdict : null;
  let noRuns = previous !== null && previous.oid === sha ? previous.noRuns : 0;
  if (previous && previous.oid !== sha) {
    events.push({
      ...fields,
      sha,
      kind: "head",
      text: `${label}: head moved to ${sha.slice(0, 12)}; last commit by ${tip.author ?? "an unknown author"}`,
      url: commitUrl,
    });
    ci = "pending";
  } else if (previous && previous.rollupState !== tip.rollupState) {
    // A rollup that moves after a verdict is judged again; the same verdict stays silent.
    ci = "pending";
  }
  if (suites !== null) {
    const runs = suites.complete ? suites.runs : discoverRuns(target.repo, sha);
    noRuns = tip.rollupState === null ? noRuns + 1 : 0;
    const judged = judgeHead(tip.rollupState, runs, target.gates, noRuns >= NO_RUN_POLLS);
    const key = verdictKey(judged);
    ci = judged.kind;
    // Described (a red reads its failed jobs) only when it is news.
    if (key !== null && key !== verdict) {
      const said = describeVerdict(label, sha, judged, `${commitUrl}/checks`, io.log);
      if (said !== null) {
        events.push({ ...fields, sha, kind: said.kind, text: said.text, url: said.url });
      }
      verdict = key;
    }
  }
  delete target.unreadable;
  target.seen = { oid: sha, rollupState: tip.rollupState, ci, verdict, noRuns };
  // Pending CI holds the busy interval; a head with no CI does not. The ci term covers the poll a
  // rollup change is first seen on, and a named gate's run still registering or queued.
  return {
    events,
    busy: rollupPending(tip.rollupState) || events.length > 0 || ci === "pending",
    done: false,
  };
}
