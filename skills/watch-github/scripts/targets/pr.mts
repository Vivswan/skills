// A pull request as a target, `owner/repo#n`: new comments and reviews (who, where, how many,
// never the words), head moves, CI verdicts judged with the gates named on it, and the merge or
// close that ends the watch.

import type { EventInput, Io } from "../../../session-events/scripts/session-events.mts";
import {
  type CiState,
  describeVerdict,
  discoverRuns,
  judgeHead,
  NO_RUN_POLLS,
  plural,
  rollupPending,
  type Suites,
  verdictKey,
} from "../check-suites.mts";
import { type Activity, newActivity, readPrDetail } from "../pr-detail.mts";
import { type Row, rowChanged } from "../pr-rows.mts";
import type { Outcome } from "./branch.mts";

const PR_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;
// GraphQL's Int: a number past it makes the whole repository query invalid, every target with it.
const MAX_PR_NUMBER = 2_147_483_647;

export interface PrTarget {
  form: "pr";
  repo: string;
  number: number;
  gates: string[];
  /** The cursor: the row at the last poll, where its CI judgment stands, the verdict last delivered on its head, and the activity ids the last two detail reads fetched. */
  seen: {
    row: Row;
    ci: CiState;
    /** The last delivered verdict's key (check-suites.mts verdictKey). */
    verdict: string | null;
    /** Polls on this head with no checks at all, for a named gate that never registers. */
    noRuns: number;
    activity: string[][];
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
    const places = loose.map(place).filter((at): at is string => at !== null);
    const at = places.length > 0 ? ` at ${places.join(", ")}` : "";
    events.push({
      kind: "comment",
      text: `${label}: ${plural(loose.length, "new comment")} by ${authors}${at}`,
      url: (loose.at(-1) as Activity).url,
    });
  }
  return events;
}

export function processPr(
  target: PrTarget,
  reply: { row: Row; suites: Suites | null } | null,
  viewer: string | null,
  io: Io,
): Outcome {
  const label = prLabel(target);
  const ref = { repo: target.repo, number: target.number };
  if (reply === null) {
    if (target.unreadable) return { events: [], busy: false, done: false };
    target.unreadable = true;
    return {
      events: [
        {
          repo: target.repo,
          pr: target.number,
          sha: null,
          kind: "trouble",
          text: `${label} is not readable; unwatch it or check access`,
          url: `https://github.com/${target.repo}/pull/${target.number}`,
        },
      ],
      busy: true,
      done: false,
    };
  }
  const { row, suites } = reply;
  const previous = target.seen;
  const fields = { repo: target.repo, pr: target.number, sha: row.headRefOid };
  const changes = rowChanged(previous?.row, row);
  const events: EventInput[] = [];
  // A merged or closed row ends the watch before any other read: a detail read that keeps
  // failing (a PR past the paging cap) must not keep a finished PR watched for good.
  if (row.state === "MERGED") {
    events.push({
      ...fields,
      kind: "merged",
      text: `${label}: merged into ${row.baseRefName}`,
      url: row.url,
    });
    return { events, busy: true, done: true };
  }
  if (row.state === "CLOSED") {
    events.push({
      ...fields,
      kind: "closed",
      text: `${label}: closed without merging`,
      url: row.url,
    });
    return { events, busy: true, done: true };
  }
  let activity = previous?.activity ?? [];
  // A first sighting reads the detail too: what is on the PR now is the baseline, by id.
  if (previous === null || changes.activity) {
    const seen = previous === null ? null : new Set(previous.activity.flat());
    const detail = readPrDetail(ref, seen);
    activity = [...activity.slice(-1), detail.fetchedIds];
    if (seen !== null) {
      for (const event of describeActivities(label, newActivity(detail, seen, viewer))) {
        events.push({ ...fields, ...event });
      }
      for (const gap of detail.gaps) {
        io.log(`${label}: ${gap}`);
        events.push({
          ...fields,
          kind: "trouble",
          text: `${label}: more activity than one read follows; open the PR`,
          url: row.url,
        });
      }
    }
  }
  if (previous !== null && changes.head) {
    events.push({
      ...fields,
      kind: "head",
      text: `${label}: head moved to ${row.headRefOid.slice(0, 12)}; last commit by ${row.headAuthor ?? "an unknown author"}`,
      url: `https://github.com/${target.repo}/pull/${target.number}/commits/${row.headRefOid}`,
    });
  }
  let ci: CiState = previous?.ci ?? "pending";
  // The verdict last delivered on this head; a new head has none, so its first verdict is news. A
  // rollup that moves after a verdict is judged again, and the same verdict stays silent.
  let verdict = previous !== null && !changes.head ? previous.verdict : null;
  let noRuns = previous !== null && !changes.head ? previous.noRuns : 0;
  if (previous !== null && (changes.head || changes.rollup)) ci = "pending";
  if (suites !== null) {
    const runs = suites.complete ? suites.runs : discoverRuns(target.repo, row.headRefOid);
    noRuns = runs.length === 0 && row.rollupState === null ? noRuns + 1 : 0;
    const judged = judgeHead(row.rollupState, runs, target.gates, noRuns >= NO_RUN_POLLS);
    const key = verdictKey(judged);
    ci = judged.kind;
    // Described (a red reads its failed jobs) only when it is news.
    if (key !== null && key !== verdict) {
      const said = describeVerdict(label, row.headRefOid, judged, `${row.url}/checks`, io.log);
      if (said !== null)
        events.push({ ...fields, kind: said.kind, text: said.text, url: said.url });
      verdict = key;
    }
  }
  delete target.unreadable;
  target.seen = { row, ci, verdict, noRuns, activity };
  return {
    events,
    busy: ci === "pending" || rollupPending(row.rollupState) || events.length > 0,
    done: false,
  };
}
