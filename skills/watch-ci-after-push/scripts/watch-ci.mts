#!/usr/bin/env bun
// Watch every CI run on a commit: wait for the latest run of each workflow, then report pass/fail
// with the failing jobs' log excerpts. Discovery and polling are GraphQL (one request per page of
// 100 check suites); REST is touched only for failed-job logs, because the Actions REST endpoints
// are a secondary rate bucket that parallel watchers lock for longer than a run lasts, while
// GraphQL keeps answering.
//
// Exit codes:
//   0  the latest run of every workflow passed or was skipped, and every expected workflow registered a run
//   1  some workflow's latest run ended with a non-success, non-skipped conclusion
//   2  no runs registered, gh failed, an expected workflow never registered, or an internal failure

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const USAGE = "usage: watch-ci.mts [--expect-workflow <name>]... [<full-sha>]";
const DEFAULT_EXPECTED_WORKFLOW = "CI";
// gh run watch's 3 s default refresh across parallel watchers drained the REST bucket and blinded
// every verdict until it refilled.
const POLL_INTERVAL_SECONDS = 60;
const REGISTRATION_ATTEMPTS = 5;
const REGISTRATION_RETRY_SECONDS = 3;
const POLL_RETRY_ATTEMPTS = 3;
const POLL_RETRY_SECONDS = 2;
// Heavy retriggering stacks hundreds of suites on one SHA; a re-run between two page fetches can
// hide a re-queued suite from both, so a multi-page snapshot is judged only once two reads agree.
const MAX_SUITE_PAGES = 10;
const MAX_SNAPSHOT_ROUNDS = 5;
const LOG_TAIL_LINES = 80;

// External apps (CodeQL, Semgrep) register check suites without a workflowRun; only github-actions
// suites carrying one are workflow runs.
const SUITES_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit {
      checkSuites(first: 100, after: $cursor) {
        nodes {
          status conclusion app { slug }
          workflowRun { databaseId updatedAt workflow { databaseId name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }
}`;

type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  workflowId: number | null;
  updatedAt: string;
  name: string;
};

// stdout gets the verdict, stderr gets trouble; both through writeFileSync so a process.exit right
// after can never truncate a line mid-flush.
function print(line: string): void {
  writeFileSync(1, `${line}\n`);
}

function printErr(line: string): void {
  writeFileSync(2, `${line}\n`);
}

function usageError(message: string): never {
  printErr(`${message} (${USAGE})`);
  process.exit(2);
}

function toolingError(message: string): never {
  printErr(message);
  process.exit(2);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- command line ------------------------------------------------------------

type CommandLine = { expected: string[]; sha: string };

// The gate workflow can silently fail to register on a push, leaving only green bystanders on the
// SHA, so exit 0 requires every expected name among the discovered runs. The names are matched
// exactly, and the list is split on commas, so an empty entry or a newline would shrink the
// expectation set and silently disable the gate.
function parseCommandLine(argv: string[]): CommandLine {
  const parsed = parseFlags(argv);
  const expected: string[] = [];
  for (const value of parsed.values["expect-workflow"] ?? []) {
    if (value.includes("\n")) usageError("--expect-workflow value must not contain newlines");
    const names = value.split(",");
    if (names.some((name) => name === "")) {
      usageError(`--expect-workflow requires a workflow name (empty entry in "${value}")`);
    }
    expected.push(...names);
  }
  // Flags go before the SHA: a flag after it would otherwise be silently ignored, and a green
  // bystander could then read as the gate.
  const shaToken = parsed.tokens.find((token) => token.kind === "positional");
  const trailing = shaToken === undefined ? [] : argv.slice(shaToken.index + 1);
  if (trailing.length > 0) {
    usageError(`unexpected argument(s) after the SHA: ${trailing.join(" ")}`);
  }
  return {
    expected: expected.length > 0 ? expected : [DEFAULT_EXPECTED_WORKFLOW],
    sha: shaToken?.value ?? gitHead(),
  };
}

function parseFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: { "expect-workflow": { type: "string", multiple: true } },
      allowPositionals: true,
      tokens: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      // parseArgs's own text names the --expect-workflow=<name> form a dash-led name needs.
      usageError(`--expect-workflow requires a workflow name: ${errorText(error)}`);
    }
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") usageError(`unknown flag: ${errorText(error)}`);
    throw error;
  }
}

function gitHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  if (result.status !== 0) toolingError(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// --- gh plumbing -------------------------------------------------------------

/** stdout of a successful gh call, or null after a failure; gh's own stderr passes through, so the
 * exit-2 messages can say "check stderr above". */
function gh(args: string[]): string | null {
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) {
    printErr(`gh ${args.slice(0, 2).join(" ")}: ${result.error.message}`);
    return null;
  }
  return result.status === 0 ? result.stdout : null;
}

// The wait is a child process, not a timer, so a fake `sleep` on PATH can pin the polling shape in
// tests without a seam in this file. A failing sleep is an internal failure like any other.
function sleep(seconds: number): void {
  const result = spawnSync("sleep", [String(seconds)], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`sleep ${seconds} exited ${result.status ?? "on a signal"}`);
  }
}

// --- discovery ---------------------------------------------------------------

type Repo = { owner: string; name: string };

type Page = { runs: Run[]; nextCursor: string | null };

// Enum words are lowercased: GitHub returns SUCCESS, the output lines say success. A workflow run
// can lack a workflow id (ruleset or unnamed runs); such a run is judged on its own.
function parsePage(raw: string): Page | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    printErr("gh api graphql returned non-JSON output");
    return null;
  }
  const data = isRecord(body) ? body.data : undefined;
  const repository = isRecord(data) ? data.repository : undefined;
  const object = isRecord(repository) ? repository.object : undefined;
  const suites = isRecord(object) ? object.checkSuites : undefined;
  // An unknown SHA answers with a null object: an empty snapshot, not an error.
  if (!isRecord(suites)) return { runs: [], nextCursor: null };
  const runs: Run[] = [];
  for (const node of Array.isArray(suites.nodes) ? suites.nodes : []) {
    if (!isRecord(node)) continue;
    const app = isRecord(node.app) ? node.app : {};
    const workflowRun = isRecord(node.workflowRun) ? node.workflowRun : null;
    if (app.slug !== "github-actions" || workflowRun === null) continue;
    const workflow = isRecord(workflowRun.workflow) ? workflowRun.workflow : {};
    if (typeof workflowRun.databaseId !== "number" || typeof node.status !== "string") {
      printErr("gh api graphql returned a check suite without a run id or status");
      return null;
    }
    runs.push({
      id: workflowRun.databaseId,
      status: node.status.toLowerCase(),
      conclusion: typeof node.conclusion === "string" ? node.conclusion.toLowerCase() : null,
      workflowId: typeof workflow.databaseId === "number" ? workflow.databaseId : null,
      updatedAt: String(workflowRun.updatedAt),
      name: String(workflow.name),
    });
  }
  const pageInfo = isRecord(suites.pageInfo) ? suites.pageInfo : {};
  if (pageInfo.hasNextPage !== true) return { runs, nextCursor: null };
  if (typeof pageInfo.endCursor !== "string") {
    printErr("gh api graphql reported a next page without a cursor");
    return null;
  }
  return { runs, nextCursor: pageInfo.endCursor };
}

type Snapshot = { runs: Run[]; pages: number };

// A failed gh call yields nothing, even after earlier pages were received: a partial snapshot
// judged as complete would leave the omitted runs unmeasured.
function readSnapshot(repo: Repo, sha: string): Snapshot | null {
  const runs: Run[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= MAX_SUITE_PAGES; pages += 1) {
    const args = ["api", "graphql", "-f", `query=${SUITES_QUERY}`];
    args.push("-f", `owner=${repo.owner}`, "-f", `name=${repo.name}`, "-f", `oid=${sha}`);
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const raw = gh(args);
    if (raw === null) return null;
    const page = parsePage(raw);
    if (page === null) return null;
    runs.push(...page.runs);
    if (page.nextCursor === null) return { runs, pages };
    cursor = page.nextCursor;
  }
  printErr(
    `check suites for ${sha} span more than ${MAX_SUITE_PAGES} pages of 100; refusing to judge a partial snapshot`,
  );
  return null;
}

// One page is one atomic read of the run list with its states. A multi-page snapshot is not, so it
// is confirmed by an identical second read. updatedAt is part of the comparison: status and
// conclusion alone cannot see a re-run that completed again between two reads.
function discover(repo: Repo, sha: string): Run[] | null {
  let previous = "";
  for (let round = 1; round <= MAX_SNAPSHOT_ROUNDS; round += 1) {
    const snapshot = readSnapshot(repo, sha);
    if (snapshot === null) return null;
    const serialized = JSON.stringify(snapshot.runs);
    if (snapshot.pages === 1 || serialized === previous) return snapshot.runs;
    previous = serialized;
  }
  printErr(
    `check suites for ${sha} kept changing across ${MAX_SNAPSHOT_ROUNDS} multi-page reads; refusing to judge a partial snapshot`,
  );
  return null;
}

// A dropped connection or a rate-limit blip must not conclude anything from a single failed read.
function discoverWithRetry(repo: Repo, sha: string): Run[] {
  for (let attempt = 1; attempt <= POLL_RETRY_ATTEMPTS; attempt += 1) {
    const runs = discover(repo, sha) ?? [];
    if (runs.length > 0) return runs;
    if (attempt < POLL_RETRY_ATTEMPTS) sleep(POLL_RETRY_SECONDS);
  }
  return [];
}

// --- judgment ----------------------------------------------------------------

type Selection = { latest: Run[]; superseded: Run[]; pending: number };

// The unit of judgment is the workflow: re-triggers stack several runs of one workflow on one SHA,
// and a concurrency group cancels all but the newest, so judging every run would report a green
// pipeline as red. Grouped by workflow id, not name, since two workflow files can share a name.
// Run ids are monotonic, so the highest id is the newest. A re-run keeps its id and flips the
// status away from completed, so "not completed" is the only running signal.
function selectLatest(runs: Run[]): Selection {
  const sorted = [...runs].sort((a, b) => b.id - a.id);
  const seen = new Set<number>();
  const selection: Selection = { latest: [], superseded: [], pending: 0 };
  for (const run of sorted) {
    if (run.workflowId !== null) {
      if (seen.has(run.workflowId)) {
        selection.superseded.push(run);
        continue;
      }
      seen.add(run.workflowId);
    }
    selection.latest.push(run);
    if (run.status !== "completed") selection.pending += 1;
  }
  return selection;
}

function missingWorkflows(expected: string[], runs: Run[]): string[] {
  const discovered = new Set(runs.map((run) => run.name));
  return expected.filter((name) => !discovered.has(name));
}

// The only REST call, and informational: a rate-limited or expired-log answer is printed as the
// excerpt and never changes the verdict. --log-failed exits non-zero for runs with no failed step.
// The shell merges both streams, so the excerpt keeps gh's interleaving; the unbounded buffer keeps
// the final lines of a log past spawnSync's 1 MiB default, which piped capture lost.
function failedJobLog(id: number): string {
  const result = spawnSync(
    "sh",
    ["-c", 'exec gh run view "$1" --log-failed 2>&1', "sh", String(id)],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: Number.POSITIVE_INFINITY,
    },
  );
  const text = (result.stdout ?? "").replace(/\n$/, "");
  return text.split("\n").slice(-LOG_TAIL_LINES).join("\n");
}

function resolveRepo(): Repo {
  const nameWithOwner = (
    gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]) ?? ""
  ).trim();
  const slash = nameWithOwner.indexOf("/");
  if (slash < 1 || slash === nameWithOwner.length - 1) {
    toolingError(
      "cannot resolve the repository for this checkout (gh failed; check stderr above, gh auth status, and the remote)",
    );
  }
  return { owner: nameWithOwner.slice(0, slash), name: nameWithOwner.slice(slash + 1) };
}

function main(argv: string[]): number {
  const { expected, sha } = parseCommandLine(argv);
  const repo = resolveRepo();

  // A fast bystander (an auto-assign workflow) can register seconds before the gate workflow, so
  // registration keeps polling while an expected workflow is still absent, within the same window.
  let runs: Run[] = [];
  for (let attempt = 1; attempt <= REGISTRATION_ATTEMPTS; attempt += 1) {
    runs = discover(repo, sha) ?? [];
    if (runs.length > 0 && missingWorkflows(expected, runs).length === 0) break;
    if (attempt < REGISTRATION_ATTEMPTS) sleep(REGISTRATION_RETRY_SECONDS);
  }
  if (runs.length === 0) {
    toolingError(
      `no workflow runs registered for ${sha} after ~15s (or gh failed; check stderr above, gh auth status, and the remote)`,
    );
  }

  // Each poll is a fresh snapshot and the selection is recomputed from it, so a run registered or
  // re-run mid-watch is waited on like any other, and the judged selection is never stale.
  let selection = selectLatest(runs);
  while (selection.pending > 0) {
    sleep(POLL_INTERVAL_SECONDS);
    runs = discoverWithRetry(repo, sha);
    if (runs.length === 0) {
      toolingError(
        `polling ${sha} returned nothing (gh failed, or the runs vanished); refusing to judge without a fresh snapshot`,
      );
    }
    selection = selectLatest(runs);
  }

  for (const run of selection.superseded) print(`superseded: ${run.name} (${run.id})`);

  // Run outcome and gh health are tracked apart so tooling trouble is never reported as a red
  // pipeline. A cancelled LATEST run is a failure: with no newer run to supersede it, the pipeline
  // never delivered a verdict.
  let failed = false;
  let ghTrouble = false;
  for (const run of selection.latest) {
    if (run.conclusion === "success") {
      print(`pass: ${run.name} (${run.id})`);
    } else if (run.conclusion === "skipped") {
      print(`skip: ${run.name} (${run.id})`);
    } else if (run.conclusion === null) {
      printErr(
        `run ${run.id} (${run.name}) is completed but carries no conclusion (gh or GitHub trouble?)`,
      );
      ghTrouble = true;
    } else {
      failed = true;
      print(`FAIL(${run.conclusion}): ${run.name} (${run.id})`);
      const log = failedJobLog(run.id);
      if (log !== "") print(log);
    }
  }

  // Computed against the final snapshot, so a gate that registered mid-watch heals here.
  const missing = missingWorkflows(expected, runs);
  if (missing.length > 0) {
    const found = [...new Set(runs.map((run) => run.name))].sort().join(", ") || "nothing";
    printErr(
      `expected workflow(s) not found for ${sha}: ${missing.join(", ")}; discovered only: ${found}.` +
        " The push event can fail to register the run; dispatch the missing workflow by hand, e.g. gh workflow run ci.yml --ref <branch>" +
        " (or override the expectation with --expect-workflow <name>)",
    );
  }

  // A red run outranks a missing expected workflow, which outranks a gh hiccup.
  if (failed) return 1;
  if (missing.length > 0) return 2;
  if (ghTrouble) return 2;
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  printErr(
    `watch-ci.mts: unexpected failure (${errorText(error)}); tooling trouble, not a pipeline verdict`,
  );
  process.exit(2);
}
