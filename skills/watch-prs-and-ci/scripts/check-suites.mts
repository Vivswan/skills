// The CI reads for one commit, and the pure judgment over them. Discovery is GraphQL (one request
// per page of 100 check suites); REST is touched only for failed-step logs, because the Actions REST
// endpoints are a secondary rate bucket that parallel watchers lock for longer than a run lasts,
// while GraphQL keeps answering.

import { spawnSync } from "node:child_process";
import {
  beforeRead,
  DEFAULT_TIMEOUT_MS,
  GhError,
  get,
  gh,
  parseJson,
  requireNumber,
  requireString,
} from "./gh.mts";

// Heavy retriggering stacks hundreds of suites on one SHA; a re-run between two page fetches can
// hide a re-queued suite from both, so a multi-page snapshot is judged only once two reads agree.
const MAX_SUITE_PAGES = 10;
const MAX_SNAPSHOT_ROUNDS = 5;
// The excerpt of a failed run's log: the lines that name an error or a failure (`::error`,
// `##[error]`, `error:`, `error TS2304`, `Error`, `FAIL`, `FAILED`), or the failing step's own tail
// when none does. The stream's last lines are the run's wind-down (a summary job, credential
// cleanup), which is why a plain tail misses the error. The runner's own exit-code line is on every
// failed step and says nothing on its own, so it never counts as a match.
const ERROR_LINE = /\b(?:[Ee]rror|ERROR|FAIL|FAILED)\b/;
const EXIT_CODE_LINE = /Process completed with exit code \d+/;
const MAX_EXCERPT_LINES = 40;
const STEP_TAIL_LINES = 20;
// `gh run view --log-failed` renders `<job>\t<step>\t<line>`, the line still carrying its timestamp.
const LOG_LINE = /^([^\t]*)\t([^\t]*)\t(.*)$/;
const LINE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;

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

export type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  workflowId: number | null;
  updatedAt: string;
  name: string;
};

export type Verdict = {
  kind: "pending" | "green" | "red" | "missing" | "trouble";
  lines: string[];
};

// --- discovery ---------------------------------------------------------------

type Page = { runs: Run[]; nextCursor: string | null };

// Enum words are lowercased: GitHub returns SUCCESS, the output lines say success. A workflow run
// can lack a workflow id (ruleset or unnamed runs); such a run is judged on its own.
function parsePage(raw: string): Page {
  const body = parseJson(raw, "gh api graphql");
  const object = get(get(get(body, "data"), "repository"), "object");
  // An unknown SHA answers with a null object: an empty snapshot, not an error.
  const suites = get(object, "checkSuites");
  if (suites === undefined || suites === null) return { runs: [], nextCursor: null };
  const nodes = get(suites, "nodes");
  const runs: Run[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const workflowRun = get(node, "workflowRun");
    if (get(get(node, "app"), "slug") !== "github-actions" || !workflowRun) continue;
    const workflow = get(workflowRun, "workflow");
    const conclusion = get(node, "conclusion");
    const workflowId = get(workflow, "databaseId");
    runs.push({
      id: requireNumber(get(workflowRun, "databaseId"), "checkSuites workflowRun.databaseId"),
      status: requireString(get(node, "status"), "checkSuites status").toLowerCase(),
      conclusion: typeof conclusion === "string" ? conclusion.toLowerCase() : null,
      workflowId: typeof workflowId === "number" ? workflowId : null,
      updatedAt: String(get(workflowRun, "updatedAt")),
      name: String(get(workflow, "name")),
    });
  }
  const pageInfo = get(suites, "pageInfo");
  if (get(pageInfo, "hasNextPage") !== true) return { runs, nextCursor: null };
  return {
    runs,
    nextCursor: requireString(get(pageInfo, "endCursor"), "checkSuites pageInfo.endCursor"),
  };
}

type Snapshot = { runs: Run[]; pages: number };

// A failed gh call yields nothing, even after earlier pages were received: a partial snapshot
// judged as complete would leave the omitted runs unmeasured.
function readSnapshot(repo: string, oid: string): Snapshot {
  const [owner, name] = repo.split("/") as [string, string];
  const runs: Run[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= MAX_SUITE_PAGES; pages += 1) {
    const args = ["api", "graphql", "-f", `query=${SUITES_QUERY}`];
    args.push("-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `oid=${oid}`);
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const page = parsePage(gh(args));
    runs.push(...page.runs);
    if (page.nextCursor === null) return { runs, pages };
    cursor = page.nextCursor;
  }
  throw new GhError(
    `check suites for ${oid} span more than ${MAX_SUITE_PAGES} pages of 100; refusing to judge a partial snapshot`,
  );
}

// One page is one atomic read of the run list with its states. A multi-page snapshot is not, so it
// is confirmed by an identical second read. updatedAt is part of the comparison: status and
// conclusion alone cannot see a re-run that completed again between two reads.
export function discoverRuns(repo: string, oid: string): Run[] {
  let previous = "";
  for (let round = 1; round <= MAX_SNAPSHOT_ROUNDS; round += 1) {
    const snapshot = readSnapshot(repo, oid);
    const serialized = JSON.stringify(snapshot.runs);
    if (snapshot.pages === 1 || serialized === previous) return snapshot.runs;
    previous = serialized;
  }
  throw new GhError(
    `check suites for ${oid} kept changing across ${MAX_SNAPSHOT_ROUNDS} multi-page reads; refusing to judge a partial snapshot`,
  );
}

// --- judgment ----------------------------------------------------------------

type Selection = { latest: Run[]; superseded: Run[] };

// The unit of judgment is the workflow: re-triggers stack several runs of one workflow on one SHA,
// and a concurrency group cancels all but the newest, so judging every run would report a green
// pipeline as red. Grouped by workflow id, not name, since two workflow files can share a name.
// Run ids are monotonic, so the highest id is the newest. A re-run keeps its id and flips the
// status away from completed, so "not completed" is the only running signal.
function partitionRuns(runs: Run[]): Selection {
  const sorted = [...runs].sort((a, b) => b.id - a.id);
  const seen = new Set<number>();
  const selection: Selection = { latest: [], superseded: [] };
  for (const run of sorted) {
    if (run.workflowId !== null) {
      if (seen.has(run.workflowId)) {
        selection.superseded.push(run);
        continue;
      }
      seen.add(run.workflowId);
    }
    selection.latest.push(run);
  }
  return selection;
}

export function selectLatest(runs: Run[]): Run[] {
  return partitionRuns(runs).latest;
}

export function missingWorkflows(latest: Run[], expected: string[]): string[] {
  const discovered = new Set(latest.map((run) => run.name));
  return expected.filter((name) => !discovered.has(name));
}

// Run outcome and gh health are judged apart so tooling trouble is never reported as a red
// pipeline. A cancelled LATEST run is a failure: with no newer run to supersede it, the pipeline
// never delivered a verdict. The kinds rank: red, then missing, then pending, then trouble. A
// missing expected workflow outranks a pending bystander: ranked below it, a gate that never
// registers would be waited on for as long as anything else ran, and the caller's grace for a
// late registration sits on top of this judgment. A commit with no runs at all is pending, never
// a vacuous green.
export function judgeRuns(runs: Run[], expected: string[]): Verdict {
  const { latest, superseded } = partitionRuns(runs);
  const lines = superseded.map((run) => `superseded: ${run.name} (${run.id})`);
  let red = false;
  let pending = false;
  let trouble = false;
  for (const run of latest) {
    if (run.status !== "completed") {
      pending = true;
      lines.push(`pending(${run.status}): ${run.name} (${run.id})`);
    } else if (run.conclusion === "success") {
      lines.push(`pass: ${run.name} (${run.id})`);
    } else if (run.conclusion === "skipped") {
      lines.push(`skip: ${run.name} (${run.id})`);
    } else if (run.conclusion === null) {
      trouble = true;
      lines.push(
        `run ${run.id} (${run.name}) is completed but carries no conclusion (gh or GitHub trouble?)`,
      );
    } else {
      red = true;
      lines.push(`FAIL(${run.conclusion}): ${run.name} (${run.id})`);
    }
  }
  const missing = missingWorkflows(latest, expected);
  for (const name of missing) lines.push(`no run registered for ${name}`);
  if (latest.length === 0 && missing.length === 0) {
    return { kind: "pending", lines: [...lines, "no workflow runs registered"] };
  }
  if (red) return { kind: "red", lines };
  if (missing.length > 0) return { kind: "missing", lines };
  if (pending) return { kind: "pending", lines };
  if (trouble) return { kind: "trouble", lines };
  return { kind: "green", lines };
}

type LogLine = { step: string | null; text: string };

/**
 * The excerpt of a `--log-failed` stream: the lines naming an error, grouped under their
 * `<job> / <step>:` and capped, else the last lines of the step that failed last. A line without
 * the job and step columns (gh's own stderr) belongs to the step before it.
 */
export function excerptFailedLog(stream: string): string {
  const parsed: LogLine[] = [];
  let step: string | null = null;
  for (const raw of stream.split("\n")) {
    if (raw === "") continue;
    const match = LOG_LINE.exec(raw);
    if (match) {
      step = `${match[1]} / ${match[2]}`;
      parsed.push({ step, text: (match[3] as string).replace(LINE_TIMESTAMP, "") });
    } else {
      parsed.push({ step, text: raw });
    }
  }
  const matching = parsed.filter(
    (line) => ERROR_LINE.test(line.text) && !EXIT_CODE_LINE.test(line.text),
  );
  let kept: LogLine[];
  let overflow = 0;
  if (matching.length > 0) {
    kept = matching.slice(0, MAX_EXCERPT_LINES);
    overflow = matching.length - kept.length;
  } else {
    const last = parsed.at(-1)?.step ?? null;
    const stepLines = parsed.filter((line) => line.step === last);
    // gh labels a job whose step logs are unavailable as one step, cleanup included; the runner's
    // exit-code line is where the failing command's output ends.
    const exit = stepLines.findLastIndex((line) => EXIT_CODE_LINE.test(line.text));
    kept = (exit < 0 ? stepLines : stepLines.slice(0, exit + 1)).slice(-STEP_TAIL_LINES);
  }
  const out: string[] = [];
  let heading: string | null | undefined;
  for (const line of kept) {
    if (line.step !== heading) {
      heading = line.step;
      if (heading !== null) out.push(`${heading}:`);
    }
    out.push(heading === null ? line.text : `  ${line.text}`);
  }
  if (overflow > 0) out.push(`${overflow} more lines naming an error`);
  return out.join("\n");
}

// The only REST call, and informational: a rate-limited or expired-log answer is returned as the
// excerpt and never changes a verdict. --log-failed exits non-zero for runs with no failed step.
// The shell merges both streams, so the excerpt keeps gh's interleaving; the unbounded buffer keeps
// the final lines of a log past spawnSync's 1 MiB default, which piped capture lost. The repository
// is named: gh would otherwise resolve it from the working directory, which is not the run's. The
// spawn is bounded because the caller is a poll loop that a hung gh would stall.
export function failedJobLog(
  repo: string,
  runId: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): string {
  beforeRead();
  const result = spawnSync(
    "sh",
    ["-c", 'exec gh run view "$1" --log-failed --repo "$2" 2>&1', "sh", String(runId), repo],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: Number.POSITIVE_INFINITY,
      timeout: timeoutMs,
    },
  );
  const lines = [excerptFailedLog(result.stdout ?? "")].filter((text) => text !== "");
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const why = code === "ETIMEDOUT" ? `no answer within ${timeoutMs} ms` : result.error.message;
    lines.push(`gh run view ${runId} --log-failed: ${why}`);
  }
  return lines.join("\n");
}
