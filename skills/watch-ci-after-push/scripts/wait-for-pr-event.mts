#!/usr/bin/env bun
// Fully local, zero-token waiter for pull-request activity: the
// comment/review sibling of watch-ci.sh. Sleep on this instead of having an
// agent poll the PR.
//
// A COMPLETE baseline snapshot (issue-comment count, review-thread counts,
// latest review, per-check conclusions, merged state) must succeed before
// the wait starts: a probe that cannot read the PR errors out, never waits
// on garbage. Every exit prints evidence, never a bare code.
//
// Run with bun; node builtins only, no npm dependencies. Every external
// call goes through gh via spawnSync with an explicit timeout. Thread state
// comes from GraphQL (isResolved), paginated past 100 threads.
//
// Exit codes:
//   0  a watched event happened; the output names it (new review, comment
//      or thread counts, a check conclusion, merged)
//   1  the PR merged or closed while that outcome was not watched - the
//      wait's job ended
//   2  usage or tooling error (bad args, gh missing, gh failing at the
//      baseline or repeatedly mid-poll); never silently retried forever
//   3  timeout with no watched change; baseline and final snapshots printed

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const WATCHABLE = ["comment", "review", "checks", "merge"] as const;
type Watched = (typeof WATCHABLE)[number];

const DEFAULT_UNTIL = "comment,review";
const DEFAULT_INTERVAL_SECONDS = 45;
// Tighter polling hammers the API without making humans reply faster.
const MIN_INTERVAL_SECONDS = 15;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const GH_CALL_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
// A failed poll retries sooner than the interval: transient API errors get
// bounded retries, not a full silent interval each.
const POLL_RETRY_SECONDS = 2;
// 100 threads per page; a PR with >5000 threads is a broken measurement.
const MAX_THREAD_PAGES = 50;

const USAGE = [
  "usage: wait-for-pr-event.mts <pr-number> [--until <set>] [--interval <sec>] [--timeout <sec>] [--repo <owner/name>]",
  `  --until     comma set of ${WATCHABLE.join(",")} (default: ${DEFAULT_UNTIL})`,
  `  --interval  seconds between polls (default ${DEFAULT_INTERVAL_SECONDS}, minimum ${MIN_INTERVAL_SECONDS})`,
  `  --timeout   seconds before giving up (default ${DEFAULT_TIMEOUT_SECONDS})`,
  "  --repo      owner/name (default: the current repo via gh repo view)",
].join("\n");

// stdout gets evidence, stderr gets trouble; both via writeFileSync so a
// process.exit right after can never truncate the line mid-flush.
function print(line: string): void {
  writeFileSync(1, `${line}\n`);
}

function printErr(line: string): void {
  writeFileSync(2, `${line}\n`);
}

function usageError(message: string): never {
  writeFileSync(2, `${message}\n${USAGE}\n`);
  process.exit(2);
}

function toolingError(message: string): never {
  writeFileSync(2, `${message}\n`);
  process.exit(2);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- gh plumbing -------------------------------------------------------------

/** A gh call or response-shape failure: retryable at poll time, fatal at
 * baseline time. Distinct from usage errors, which never retry. */
class GhError extends Error {}

function gh(args: string[]): string {
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_CALL_TIMEOUT_MS,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing binary cannot heal between polls; fail now, not after
      // MAX_CONSECUTIVE_POLL_FAILURES identical retries.
      toolingError("gh not found on PATH; install and authenticate the GitHub CLI");
    }
    throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new GhError(
      `gh ${args.slice(0, 2).join(" ")} exited ${result.status ?? "on a signal"}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new GhError(`GraphQL response: ${label} is not a number`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new GhError(`GraphQL response: ${label} is not a string`);
  return value;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new GhError(`${label} returned non-JSON output`);
  }
}

// --- snapshot ----------------------------------------------------------------

interface Review {
  id: string;
  login: string;
  state: string;
  submittedAt: string;
}

interface CheckState {
  name: string;
  conclusion: string;
}

interface Snapshot {
  state: string;
  mergedAt: string | null;
  issueComments: number;
  threadTotal: number;
  unresolvedThreads: number;
  reviewCount: number;
  latestReview: Review | null;
  /** keyed by "<typename>:<name>" so a CheckRun and a StatusContext sharing
   * a display name stay distinct; conclusion is lowercased, "pending" while
   * unconcluded. */
  checks: Map<string, CheckState>;
}

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      mergedAt
      comments { totalCount }
      reviews(last: 1) {
        totalCount
        nodes { fullDatabaseId state submittedAt author { login } }
      }
      reviewThreads(first: 100, after: $cursor) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface PrPage {
  state: string;
  mergedAt: string | null;
  issueComments: number;
  reviewCount: number;
  latestReview: Review | null;
  threadResolved: boolean[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function parsePrPage(raw: string): PrPage {
  const pr = get(get(get(parseJson(raw, "gh api graphql"), "data"), "repository"), "pullRequest");
  if (pr === null || pr === undefined) {
    throw new GhError("GraphQL response has no pullRequest (wrong repo or PR number?)");
  }
  const mergedAt = get(pr, "mergedAt");
  if (mergedAt !== null && typeof mergedAt !== "string") {
    throw new GhError("GraphQL response: mergedAt is neither a string nor null");
  }
  const reviews = get(pr, "reviews");
  const reviewNodes = get(reviews, "nodes");
  if (!Array.isArray(reviewNodes)) {
    throw new GhError("GraphQL response: reviews.nodes is not an array");
  }
  let latestReview: Review | null = null;
  if (reviewNodes.length > 0) {
    const node = reviewNodes[reviewNodes.length - 1];
    const login = get(get(node, "author"), "login");
    const submittedAt = get(node, "submittedAt");
    if (submittedAt !== null && typeof submittedAt !== "string") {
      throw new GhError("GraphQL response: review submittedAt is neither a string nor null");
    }
    latestReview = {
      id: requireString(get(node, "fullDatabaseId"), "review fullDatabaseId"),
      state: requireString(get(node, "state"), "review state"),
      // Deleted accounts null the author; a PENDING review has no submittedAt.
      login: typeof login === "string" ? login : "unknown",
      submittedAt: submittedAt ?? "unsubmitted",
    };
  }
  const threads = get(pr, "reviewThreads");
  const threadNodes = get(threads, "nodes");
  if (!Array.isArray(threadNodes)) {
    throw new GhError("GraphQL response: reviewThreads.nodes is not an array");
  }
  const pageInfo = get(threads, "pageInfo");
  const hasNextPage = get(pageInfo, "hasNextPage");
  if (typeof hasNextPage !== "boolean") {
    throw new GhError("GraphQL response: pageInfo.hasNextPage is not a boolean");
  }
  const endCursor = get(pageInfo, "endCursor");
  return {
    state: requireString(get(pr, "state"), "state"),
    mergedAt,
    issueComments: requireNumber(get(get(pr, "comments"), "totalCount"), "comments.totalCount"),
    reviewCount: requireNumber(get(reviews, "totalCount"), "reviews.totalCount"),
    latestReview,
    threadResolved: threadNodes.map((node, i) => {
      const resolved = get(node, "isResolved");
      if (typeof resolved !== "boolean") {
        throw new GhError(`GraphQL response: reviewThreads.nodes[${i}].isResolved is missing`);
      }
      return resolved;
    }),
    hasNextPage,
    endCursor: typeof endCursor === "string" ? endCursor : null,
  };
}

function readChecks(repo: string, prNumber: number): Map<string, CheckState> {
  const raw = gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "statusCheckRollup"]);
  const parsed = parseJson(raw, "gh pr view");
  // The field must be PRESENT: a response missing it is a broken read, not a
  // PR with no checks (null and [] are how gh renders those).
  if (!isRecord(parsed) || !("statusCheckRollup" in parsed)) {
    throw new GhError("gh pr view: response carries no statusCheckRollup field");
  }
  const rollup = parsed.statusCheckRollup;
  const checks = new Map<string, CheckState>();
  if (rollup === null) return checks;
  if (!Array.isArray(rollup)) throw new GhError("gh pr view: statusCheckRollup is not an array");
  for (const entry of rollup) {
    // CheckRun rows carry name+conclusion, StatusContext rows context+state.
    const name = get(entry, "name") ?? get(entry, "context");
    if (typeof name !== "string" || name === "") {
      throw new GhError("gh pr view: a statusCheckRollup entry has neither name nor context");
    }
    const typename = get(entry, "__typename");
    const conclusion = get(entry, "conclusion") ?? get(entry, "state");
    // Keyed by typename too: a CheckRun and a StatusContext can share a
    // display name, and one must never mask the other's conclusion.
    checks.set(`${typeof typename === "string" ? typename : "CheckRun"}:${name}`, {
      name,
      conclusion:
        typeof conclusion === "string" && conclusion !== "" ? conclusion.toLowerCase() : "pending",
    });
  }
  return checks;
}

function readSnapshot(repo: string, prNumber: number): Snapshot {
  const [owner, name] = repo.split("/") as [string, string];
  let first: PrPage | null = null;
  let threadTotal = 0;
  let unresolvedThreads = 0;
  let cursor: string | null = null;
  for (let pageCount = 1; ; pageCount += 1) {
    if (pageCount > MAX_THREAD_PAGES) {
      throw new GhError(`review-thread pagination did not end after ${MAX_THREAD_PAGES} pages`);
    }
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${PR_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
    ];
    if (cursor !== null) args.push("-F", `cursor=${cursor}`);
    const page = parsePrPage(gh(args));
    first ??= page;
    threadTotal += page.threadResolved.length;
    unresolvedThreads += page.threadResolved.filter((resolved) => !resolved).length;
    if (!page.hasNextPage) break;
    if (page.endCursor === null) {
      throw new GhError("GraphQL response: hasNextPage without an endCursor");
    }
    cursor = page.endCursor;
  }
  if (first === null) throw new GhError("unreachable: the pagination loop read no pages");
  return {
    state: first.state,
    mergedAt: first.mergedAt,
    issueComments: first.issueComments,
    reviewCount: first.reviewCount,
    latestReview: first.latestReview,
    threadTotal,
    unresolvedThreads,
    checks: readChecks(repo, prNumber),
  };
}

function renderSnapshot(snapshot: Snapshot): string {
  const review = snapshot.latestReview
    ? `${snapshot.latestReview.id} by ${snapshot.latestReview.login} (${snapshot.latestReview.state})`
    : "none";
  const checks =
    snapshot.checks.size === 0
      ? "none"
      : [...snapshot.checks.values()]
          .map(({ name, conclusion }) => `${name}=${conclusion}`)
          .join(" ");
  return (
    `state ${snapshot.state}; issue comments ${snapshot.issueComments}; ` +
    `review threads ${snapshot.threadTotal} (${snapshot.unresolvedThreads} unresolved); ` +
    `latest review ${review}; checks ${checks}; merged ${snapshot.mergedAt ?? "no"}`
  );
}

// --- deltas ------------------------------------------------------------------

/** Evidence lines for every WATCHED change since the previous successful
 * snapshot; merged/closed transitions are handled by settleTerminalState.
 * Diffing against the PREVIOUS snapshot, not the baseline, matters for one
 * case only (any watched delta exits at once, so the two are otherwise
 * equal): a check that appears pending AFTER the baseline is not itself a
 * delta, but its later conclusion or disappearance must still be one. */
function diffDeltas(previous: Snapshot, current: Snapshot, watched: Set<Watched>): string[] {
  const deltas: string[] = [];
  if (watched.has("comment")) {
    if (current.issueComments !== previous.issueComments) {
      deltas.push(`issue comments ${previous.issueComments} -> ${current.issueComments}`);
    }
    if (current.threadTotal !== previous.threadTotal) {
      deltas.push(`review threads ${previous.threadTotal} -> ${current.threadTotal}`);
    }
    if (current.unresolvedThreads !== previous.unresolvedThreads) {
      deltas.push(
        `unresolved threads ${previous.unresolvedThreads} -> ${current.unresolvedThreads}`,
      );
    }
  }
  if (watched.has("review")) {
    const changed =
      current.reviewCount !== previous.reviewCount ||
      (current.latestReview?.id ?? null) !== (previous.latestReview?.id ?? null);
    if (changed) {
      deltas.push(
        current.latestReview
          ? `new review by ${current.latestReview.login} (${current.latestReview.state}) at ${current.latestReview.submittedAt}`
          : `reviews ${previous.reviewCount} -> ${current.reviewCount}`,
      );
    }
  }
  if (watched.has("checks")) {
    for (const [key, { name, conclusion }] of current.checks) {
      const before = previous.checks.get(key);
      if (before === undefined && conclusion !== "pending") {
        deltas.push(`check ${name} -> ${conclusion} (new)`);
      } else if (before !== undefined && before.conclusion !== conclusion) {
        deltas.push(`check ${name} -> ${conclusion} (was ${before.conclusion})`);
      }
    }
    // A vanished check (a force-push resets the rollup) is a change too;
    // staying silent about it would read as "nothing happened".
    for (const [key, { name, conclusion }] of previous.checks) {
      if (!current.checks.has(key)) {
        deltas.push(`check ${name} -> vanished (was ${conclusion})`);
      }
    }
  }
  return deltas;
}

/** Merged/closed always ends the wait: watched merge is the awaited event
 * (exit 0); anything else means no watched event can ever arrive (exit 1). */
function settleTerminalState(snapshot: Snapshot, watched: Set<Watched>, prLabel: string): void {
  if (snapshot.state === "MERGED") {
    if (watched.has("merge")) {
      print(`${prLabel} merged at ${snapshot.mergedAt ?? "an unrecorded time"}`);
      process.exit(0);
    }
    print(
      `${prLabel} merged at ${snapshot.mergedAt ?? "an unrecorded time"} but merge is not watched; the wait ended`,
    );
    process.exit(1);
  }
  if (snapshot.state === "CLOSED") {
    print(`${prLabel} closed without merging; the wait ended`);
    process.exit(1);
  }
}

// --- arguments ---------------------------------------------------------------

interface Options {
  prNumber: number;
  watched: Set<Watched>;
  intervalSeconds: number;
  timeoutSeconds: number;
  repo: string | null;
}

function parseUntil(raw: string): Set<Watched> {
  const watched = new Set<Watched>();
  for (const part of raw.split(",")) {
    const event = part.trim();
    if (!(WATCHABLE as readonly string[]).includes(event)) {
      usageError(
        `--until accepts a comma set of ${WATCHABLE.join(",")}; got: ${event || "(empty)"}`,
      );
    }
    watched.add(event as Watched);
  }
  return watched;
}

/** Digit-only AND safely representable: a long enough digit string parses to
 * Infinity-adjacent doubles, and an Infinity deadline would wait forever. */
function parseCount(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    usageError(`${flag} must be a whole number within safe integer range, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  let prNumber: number | null = null;
  let until = DEFAULT_UNTIL;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let repo: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--until" || arg === "--interval" || arg === "--timeout" || arg === "--repo") {
      const value = argv[i + 1];
      // A dash-prefixed "value" is a flag that ate its neighbor, never data.
      if (value === undefined || value.startsWith("-")) {
        usageError(`${arg} requires a value; got: ${value ?? "(nothing)"}`);
      }
      i += 1;
      if (arg === "--until") until = value;
      else if (arg === "--repo") repo = value;
      else if (arg === "--interval") intervalSeconds = parseCount(arg, value);
      else timeoutSeconds = parseCount(arg, value);
    } else if (arg.startsWith("-")) {
      usageError(`unknown flag: ${arg}`);
    } else if (prNumber === null) {
      if (!/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(Number.parseInt(arg, 10))) {
        usageError(`<pr-number> must be a positive integer, got: ${arg}`);
      }
      prNumber = Number.parseInt(arg, 10);
    } else {
      usageError(`unexpected extra argument: ${arg}`);
    }
  }
  if (prNumber === null) usageError("missing <pr-number>");
  if (intervalSeconds < MIN_INTERVAL_SECONDS) {
    usageError(
      `--interval must be at least ${MIN_INTERVAL_SECONDS} seconds, got: ${intervalSeconds}`,
    );
  }
  if (timeoutSeconds < 1) usageError("--timeout must be at least 1 second");
  if (repo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    usageError(`--repo must be owner/name, got: ${repo}`);
  }
  return { prNumber, watched: parseUntil(until), intervalSeconds, timeoutSeconds, repo };
}

function resolveRepo(): string {
  // One catch for the whole read: a gh failure and malformed gh output are
  // the same tooling error (exit 2), never an uncaught crash.
  try {
    const raw = gh(["repo", "view", "--json", "nameWithOwner"]);
    const nameWithOwner = get(parseJson(raw, "gh repo view"), "nameWithOwner");
    if (typeof nameWithOwner !== "string" || !nameWithOwner.includes("/")) {
      throw new GhError("gh repo view returned no nameWithOwner");
    }
    return nameWithOwner;
  } catch (error) {
    toolingError(`cannot resolve the current repo (pass --repo owner/name): ${errorText(error)}`);
  }
}

// --- main --------------------------------------------------------------------

async function main(): Promise<never> {
  const options = parseArgs(process.argv.slice(2));
  const repo = options.repo ?? resolveRepo();
  const prLabel = `PR #${options.prNumber} (${repo})`;
  const watchedList = [...options.watched].join(",");

  let baseline: Snapshot;
  try {
    baseline = readSnapshot(repo, options.prNumber);
  } catch (error) {
    toolingError(
      `baseline read failed; refusing to wait on a PR it cannot see: ${errorText(error)}`,
    );
  }
  print(`baseline ${prLabel}: ${renderSnapshot(baseline)}`);
  print(
    `watching ${watchedList}; interval ${options.intervalSeconds}s; timeout ${options.timeoutSeconds}s`,
  );
  settleTerminalState(baseline, options.watched, prLabel);

  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let consecutiveFailures = 0;
  let last = baseline;
  const exitTimeout = (): never => {
    print(`no watched change in ${watchedList} after ${options.timeoutSeconds}s on ${prLabel}`);
    print(`baseline: ${renderSnapshot(baseline)}`);
    print(`final:    ${renderSnapshot(last)}`);
    process.exit(3);
  };
  while (true) {
    // The first poll runs right after the baseline: a multi-page baseline
    // read takes real time, and activity landing inside that window should
    // surface immediately, not one full interval later.
    let current: Snapshot | null = null;
    try {
      current = readSnapshot(repo, options.prNumber);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      printErr(
        `poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${errorText(error)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        toolingError(
          `gh failed ${MAX_CONSECUTIVE_POLL_FAILURES} polls in a row (auth or network?); giving up rather than retrying forever`,
        );
      }
    }
    if (current !== null) {
      settleTerminalState(current, options.watched, prLabel);
      const deltas = diffDeltas(last, current, options.watched);
      if (deltas.length > 0) {
        for (const line of deltas) print(line);
        process.exit(0);
      }
      last = current;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) exitTimeout();
    const waitSeconds = consecutiveFailures > 0 ? POLL_RETRY_SECONDS : options.intervalSeconds;
    const sleepMs = Math.min(waitSeconds * 1000, remainingMs);
    await sleep(sleepMs);
    // A sleep truncated to the deadline IS the timeout: exiting here keeps
    // the deadline honest instead of overrunning it with one more poll.
    if (sleepMs === remainingMs) exitTimeout();
  }
}

await main();
