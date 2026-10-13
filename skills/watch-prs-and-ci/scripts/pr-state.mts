// What the PR source saves between polls: the subscriptions and the last row seen of each PR,
// with the CI judgment in flight on its head, and the commits watched for their mainline verdict.

import type { PrKey, Row } from "./pr-rows.mts";
import type { Event } from "./source.mts";

export type EventKind = "comment" | "review" | "ci" | "head" | "merged" | "closed" | "trouble";

/** The kinds a PR subscription can narrow to; `trouble` is tooling news and always comes. */
export type SubscribedKind = Exclude<EventKind, "trouble">;
export const ALL_SUBSCRIBED: readonly SubscribedKind[] = [
  "comment",
  "review",
  "ci",
  "head",
  "merged",
  "closed",
];

export function isSubscribedKind(value: string): value is SubscribedKind {
  return (ALL_SUBSCRIBED as readonly string[]).includes(value);
}

/** What the PR source hands the daemon for one event: the target it names, then the kind and text. */
export type PrEventInput = {
  repo: string;
  pr: number | null;
  sha: string | null;
  url: string;
  kind: EventKind;
  text: string;
  /** On a `ci` line: the GitHub Actions runs the verdict rests on, `id:status:conclusion:updatedAt` sorted and comma-joined. */
  runs?: string;
};

/** One line of the write-ahead log; every line is addressed to the daemon's one owner. */
export type PrEvent = Event<PrEventInput>;

/** What the owner asked for on a PR: the head they pushed, the complete gate set, and the kinds they hear about, sorted. */
export interface PrWatch {
  head: string | null;
  expected: string[];
  events: SubscribedKind[];
}

/** `${repo}@${sha}`: a fork shares its commits' shas with the upstream repository. */
export type CommitKey = string;

export function commitKey(repo: string, sha: string): CommitKey {
  return `${repo}@${sha}`;
}

/**
 * What a head still being judged carries between full polls: the polls in a row on which no run had
 * registered (the grace before a trouble event), and the workflow ids the last poll saw (a green
 * with no gate named is terminal only once two polls agree on that set). The read a `watch`
 * triggers leaves both alone.
 */
export interface Grace {
  missingPolls: number;
  registered: string[];
}

export function freshGrace(): Grace {
  return { missingPolls: 0, registered: [] };
}

export interface CommitWatch {
  repo: string;
  sha: string;
  expected: string[];
  firstSeenAt: string;
  grace: Grace;
}

/** What a settled verdict said, so a rollup that only catches up with it is told from a new result. */
export type CiOutcome = "green" | "red";

/**
 * A settled judgment: what it said, and a fingerprint of the GitHub Actions runs it judged (id,
 * status, conclusion, last change), so a later re-judgment that sees the same runs says nothing new. A head
 * being judged again after a verdict (a rollup move) carries that verdict's runs as `priorRuns`
 * for as many polls as the re-judgment stays pending; null when nothing was delivered on the head.
 */
export type RowCi =
  | { pending: true; grace: Grace; priorRuns: string | null }
  | { pending: false; outcome: CiOutcome; runs: string };

export function pendingCi(priorRuns: string | null = null): RowCi {
  return { pending: true, grace: freshGrace(), priorRuns };
}

export function outcomeOfVerdict(text: string): CiOutcome {
  return text.startsWith("CI green") ? "green" : "red";
}

export interface SavedRow extends Row {
  ci: RowCi;
  /** The activity ids the last two detail reads returned, oldest read first; what is in neither is news. */
  seenActivity: string[][];
  /** Polls spent on a merged row whose merge commit GitHub has not reported yet. */
  mergeCommitPolls: number;
}

export interface PrSaved {
  prs: Record<PrKey, PrWatch>;
  commits: Record<CommitKey, CommitWatch>;
  rows: Record<PrKey, SavedRow>;
}

export function emptySaved(): PrSaved {
  return { prs: {}, commits: {}, rows: {} };
}

/**
 * The saved part as the last daemon left it, made whole for this one. A subscription saved before
 * kinds could be narrowed hears everything, as it did then. The log ahead of the state is the
 * crash a verdict was appended in before the state that drops its target was saved: the log
 * carries the verdict, so the target is settled. A line names its one target: a commit watch (no
 * pr) or a PR; another watch on the same sha may require other gates, so it keeps its own
 * judgment. Registration then settles over this daemon's own polls: the startup poll can follow
 * the last daemon's by seconds, so what that one saw counts toward no confirmation and no grace.
 */
export function restoreSaved(raw: unknown, logAhead: PrEvent[]): PrSaved {
  const saved: PrSaved = { ...emptySaved(), ...(raw as Partial<PrSaved> | undefined) };
  for (const watch of Object.values(saved.prs) as Array<Partial<PrWatch>>) {
    watch.events ??= [...ALL_SUBSCRIBED].sort();
  }
  for (const event of logAhead) {
    if (event.kind !== "ci" || event.sha === null) continue;
    if (event.pr === null) {
      delete saved.commits[commitKey(event.repo, event.sha)];
      continue;
    }
    const row = saved.rows[`${event.repo}#${event.pr}`];
    if (row && row.headRefOid === event.sha && row.ci.pending) {
      row.ci = { pending: false, outcome: outcomeOfVerdict(event.text), runs: event.runs ?? "" };
    }
  }
  for (const row of Object.values(saved.rows)) {
    if (row.ci.pending) row.ci.grace = freshGrace();
  }
  for (const commit of Object.values(saved.commits)) commit.grace = freshGrace();
  return saved;
}
