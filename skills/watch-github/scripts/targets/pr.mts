// A pull request as a target, `owner/repo#n`: new comments and reviews (who, where, how many,
// never the words), head moves, label moves, conflicts with the base, CI verdicts judged with the
// gates named on it, and the merge or close that ends the watch.

import type { EventInput, Io } from "../../../session-events/scripts/session-events.mts";
import type { Suites } from "../github/check-suites.mts";
import { type Activity, newActivity, readPrDetail } from "../github/pr-activity.mts";
import { type Row, rowChanged } from "../github/repository.mts";
import { type Outcome, unreadableOutcome } from "./branch.mts";
import { type CiHead, type CiState, carriedCi, judgeCi, plural, rollupPending } from "./ci.mts";

const PR_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;
const MAX_PR_NUMBER = 2_147_483_647;

type ConflictLine = "told" | "told-before-move" | null;

export interface PrTarget {
  /** The tag the daemon dispatches on; a BranchTarget's is "branch". */
  form: "pr";

  /** owner/repo, the key the poll groups its reads by. */
  repo: string;

  /** The PR number, at most GraphQL's Int; the alias its row is read back by. */
  number: number;

  /** The --expect-workflow names, sorted; the head is judged by their latest runs, not the rollup alone. */
  gates: string[];

  /** The cursor; null before the first poll, which takes the baseline instead of reporting what it finds. */
  seen: {
    /** The row as the previous poll read it. */
    row: Row;

    /** Where the judgment stands; "pending" holds the busy interval and a suites read every poll. */
    ci: CiState;

    /** The last delivered verdict's key (ci.mts verdictKey). */
    verdict: string | null;

    /** Polls on this head with no checks at all (no rollup), for a named gate that never registers. */
    noRuns: number;

    /** A conflict line stands unresolved; after a head or base move the test has not settled since, a conflict that survived is said again. */
    conflict: ConflictLine;

    /** Every id fetched so far, so a comment that leaves the read window and comes back is never news again. */
    activity: string[];
  } | null;

  /** Set once the row answered null and the trouble event went out; cleared when it reads again. */
  unreadable?: boolean;

  /** Reads of this one target (detail, paged suites) that failed in a row; three are one trouble event. */
  readFailures?: number;
}

export function parsePrTarget(text: string, gates: string[]): PrTarget | null {
  const match = PR_PATTERN.exec(text);
  if (match === null) return null;
  const number = Number(match[2]);
  // GraphQL's Int: a number past it makes the whole repository query invalid, every target with it.
  if (number > MAX_PR_NUMBER) return null;
  return { form: "pr", repo: match[1] as string, number, gates, seen: null };
}

export function prLabel(target: PrTarget): string {
  return `PR ${target.repo}#${target.number}`;
}

function place(activity: Activity): string | null {
  if (activity.path === undefined) return null;
  return typeof activity.line === "number" ? `${activity.path}:${activity.line}` : activity.path;
}

/**
 * The new activity as events: one per review, counting the inline comments it published, then
 * one for the loose comments with where they sit. The empty COMMENTED review GitHub wraps a batch
 * of inline comments in is dropped when none of its comments is new. Who wrote where, never what.
 */
export function describeActivities(label: string, activities: Activity[]): EventInput[] {
  const comments = activities.filter((activity) => activity.kind !== "review");
  const events: EventInput[] = [];
  const headlined = new Set<string>();
  for (const review of activities.filter((activity) => activity.kind === "review")) {
    const inline = comments.filter((comment) => comment.reviewId === review.id);
    if (!review.hasBody && review.reviewState === "COMMENTED" && inline.length === 0) continue;
    for (const comment of inline) headlined.add(comment.id);
    const count = inline.length === 0 ? "" : `, ${plural(inline.length, "comment")}`;
    events.push({
      kind: "review",
      text: `${label}: review by ${review.author} (${review.reviewState})${count}`,
      url: review.url,
    });
  }
  const loose = comments.filter((comment) => !headlined.has(comment.id));
  if (loose.length > 0) {
    const authors = [...new Set(loose.map((comment) => comment.author))].join(", ");
    const places = [...new Set(loose.map(place).filter((at): at is string => at !== null))];
    const at = places.length > 0 ? ` at ${places.join(", ")}` : "";
    events.push({
      kind: "comment",
      text: `${label}: ${plural(loose.length, "new comment")} by ${authors}${at}`,
      url: (loose.at(-1) as Activity).url,
    });
  }
  return events;
}

/** The label set's moves since the last poll on one line, `labels added: a, b; label removed: x`; null when it stands. */
export function describeLabels(previous: string[], current: string[]): string | null {
  const before = new Set(previous);
  const after = new Set(current);
  const moves: [string[], string][] = [
    [current.filter((name) => !before.has(name)), "added"],
    [[...before].filter((name) => !after.has(name)), "removed"],
  ];
  const parts = moves
    .filter(([names]) => names.length > 0)
    .map(
      ([names, verb]) => `${names.length === 1 ? "label" : "labels"} ${verb}: ${names.join(", ")}`,
    );
  return parts.length === 0 ? null : parts.join("; ");
}

// A merged or closed row ends the watch before any other read: a detail read that keeps failing
// (a PR past the paging cap) must not keep a finished PR watched for good.
function watchEnd(
  label: string,
  row: Row,
  fields: { repo: string; pr: number; sha: string },
): Outcome | null {
  if (row.state === "MERGED") {
    // A stacked PR's base is the PR below it, while the stack merge lands on the stack's base.
    const text = `${label}: merged into ${row.stackBaseRefName ?? row.baseRefName}`;
    return { events: [{ ...fields, kind: "merged", text, url: row.url }], busy: true, done: true };
  }

  if (row.state === "CLOSED") {
    const text = `${label}: closed without merging`;
    return { events: [{ ...fields, kind: "closed", text, url: row.url }], busy: true, done: true };
  }

  return null;
}

function pollActivity(
  target: PrTarget,
  row: Row,
  activityMoved: boolean,
  io: Io,
): { activity: string[]; events: EventInput[] } {
  const previous = target.seen;
  // A cursor an older daemon saved as two lists of ids is not migrated: it carried draft ids as
  // seen and had forgotten older ones, so the activity is a baseline again, read now.
  const legacy = previous !== null && !previous.activity.every((id) => typeof id === "string");
  const activity = legacy ? [] : (previous?.activity ?? []);
  // A first sighting reads the detail too: what is on the PR now is the baseline, by id.
  if (previous !== null && !legacy && !activityMoved) return { activity, events: [] };

  const label = prLabel(target);
  const seen = previous === null || legacy ? null : new Set(activity);
  const detail = readPrDetail({ repo: target.repo, number: target.number }, seen);
  const fetched = [...new Set([...activity, ...detail.fetchedIds])];
  if (seen === null) return { activity: fetched, events: [] };

  const events = describeActivities(label, newActivity(detail, seen));
  for (const gap of detail.gaps) {
    io.log(`${label}: ${gap}`);
    events.push({
      kind: "trouble",
      text: `${label}: more activity than one read follows; open the PR`,
      url: row.url,
    });
  }
  return { activity: fetched, events };
}

// GitHub answers UNKNOWN while it recomputes the merge test after either side moved, so only a
// settled answer is judged, and a move keeps the standing conflict line until one arrives.
function judgeConflict(
  previous: PrTarget["seen"],
  row: Row,
  headMoved: boolean,
): { line: ConflictLine; said: string | null } {
  const baseMoved = previous !== null && previous.row.baseRefName !== row.baseRefName;
  let line = previous?.conflict ?? null;
  if (line === "told" && (headMoved || baseMoved)) line = "told-before-move";

  if (row.mergeable === "CONFLICTING" && line !== "told") {
    return { line: "told", said: `conflicts with ${row.baseRefName}; rebase needed` };
  }

  if (row.mergeable === "MERGEABLE" && line !== null) {
    return { line: null, said: "conflicts resolved" };
  }

  return { line, said: null };
}

export function processPr(
  target: PrTarget,
  reply: { row: Row; suites: Suites | null } | null,
  io: Io,
): Outcome {
  const label = prLabel(target);
  if (reply === null) {
    return unreadableOutcome(target, {
      repo: target.repo,
      pr: target.number,
      sha: null,
      kind: "trouble",
      text: `${label} is not readable; unwatch it or check access`,
      url: `https://github.com/${target.repo}/pull/${target.number}`,
    });
  }

  const { row, suites } = reply;
  const previous = target.seen;
  const fields = { repo: target.repo, pr: target.number, sha: row.headRefOid };
  const changes = rowChanged(previous?.row, row);
  const ended = watchEnd(label, row, fields);
  if (ended !== null) return ended;

  const read = pollActivity(target, row, changes.activity, io);
  const events: EventInput[] = read.events.map((event) => ({ ...fields, ...event }));
  if (previous !== null && changes.head) {
    events.push({
      ...fields,
      kind: "head",
      text: `${label}: head moved to ${row.headRefOid.slice(0, 12)}; last commit by ${row.headAuthor ?? "an unknown author"}`,
      url: `https://github.com/${target.repo}/pull/${target.number}/commits/${row.headRefOid}`,
    });
  }
  if (previous !== null) {
    const labelMoves = describeLabels(previous.row.labels, row.labels);
    if (labelMoves !== null)
      events.push({ ...fields, kind: "label", text: `${label}: ${labelMoves}`, url: row.url });
  }

  const conflict = judgeConflict(previous, row, changes.head);
  if (conflict.said !== null) {
    events.push({ ...fields, kind: "conflict", text: `${label}: ${conflict.said}`, url: row.url });
  }

  const head: CiHead = {
    label,
    repo: target.repo,
    sha: row.headRefOid,
    rollupState: row.rollupState,
    suites,
    gates: target.gates,
    checksUrl: `${row.url}/checks`,
  };
  const judged = judgeCi(carriedCi(previous, changes.head, changes.rollup), head, io.log);
  if (judged.event !== null) {
    const { kind, text, url } = judged.event;
    events.push({ ...fields, kind, text, url });
  }

  delete target.unreadable;
  target.seen = { row, ...judged.cursor, conflict: conflict.line, activity: read.activity };
  // Pending CI holds the busy interval; a head with no CI does not. The ci term covers the poll a
  // rollup change is first seen on, and a named gate's run still registering or queued.
  return {
    events,
    busy: rollupPending(row.rollupState) || events.length > 0 || judged.cursor.ci === "pending",
    done: false,
  };
}
