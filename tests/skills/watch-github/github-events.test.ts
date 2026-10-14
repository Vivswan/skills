import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import type { Activity } from "../../../skills/watch-github/scripts/github/pr-activity.mts";
import { parseBranchTarget } from "../../../skills/watch-github/scripts/targets/branch.mts";
import {
  describeActivities,
  parsePrTarget,
} from "../../../skills/watch-github/scripts/targets/pr.mts";
import {
  CLOSING,
  detail,
  FORK,
  githubEventsHarness,
  HEAD_A,
  HEAD_B,
  headlines,
  INJECTION,
  jobs,
  MAIN,
  PR7,
  PR7_URL,
  prNode,
  REPO,
  type RowSpec,
  refNode,
  rows,
  SCRIPT,
  Scenario,
  SHORT_A,
  SHORT_B,
  suiteNodes,
  text,
} from "../../helpers/github-events-scenario";

// Contract tests for the GitHub source through the daemon: the two target forms, the one request
// per repository, what each event says and does not say, the CI rules, and the budget. The stub
// gh (../../helpers/github-events-scenario.ts) serves GitHub-shaped fixtures and records every REST
// call as a violation; every test ends with none.

const { temp, emptyBinDir } = githubEventsHarness();
const MAIN_URL = `https://github.com/${REPO}/commit/${HEAD_A}`;

describe("github-events.mts", () => {
  test("the two target forms subscribe, a third is refused; one poll is one request per repository carrying its rows, its tips, and the suites of gated or pending heads", async () => {
    const s = new Scenario("forms");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-example-1": rows({
        p7: prNode({ suites: [["ci", "IN_PROGRESS", null]], rollup: "PENDING" }),
        p8: prNode({ number: 8, rollup: "PENDING", suites: [] }),
        b0: refNode({ rollup: "SUCCESS", suites: [] }),
      }),
      "rows-fork-1": rows({ p3: prNode({ number: 3, suites: [] }) }),
    });
    await s.start({ inbox: box.path });
    for (const [args, reason] of [
      [["watch", "octo/example"], "target must be <owner/repo>#<n> or <owner/repo>:<branch>, got:"],
      [["watch", "octo/example#0"], "target must be <owner/repo>#<n> or <owner/repo>:<branch>"],
      [["watch", PR7, "--expect-workflow"], "--expect-workflow needs a workflow name"],
      [["watch", PR7, "--head", HEAD_A], "unknown option: --head"],
    ] as Array<[string[], string]>) {
      const r = s.run(args, { inbox: box.path });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(reason);
    }
    expect(s.ghCalls()).toEqual([]);
    expect(s.run(["watch", PR7, "--expect-workflow", "ci"], { inbox: box.path }).stdout).toContain(
      `watching ${PR7} for session`,
    );
    expect(s.run(["watch", `${REPO}#8`], { inbox: box.path }).code).toBe(0);
    expect(s.run(["watch", MAIN], { inbox: box.path }).code).toBe(0);
    expect(s.run(["watch", `${FORK}#3`], { inbox: box.path }).code).toBe(0);
    const before = s.rowsCalls().length;
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.rowsCalls().slice(before)).toEqual(["example", "fork"]);
    const [example, fork] = s
      .ghCalls()
      .filter((call) => call.includes("r: repository("))
      .slice(-2) as [string, string];
    expect(example).toContain('r: repository(owner: "octo", name: "example")');
    expect(example).toContain("p7: pullRequest(number: 7)");
    expect(example).toContain("p8: pullRequest(number: 8)");
    expect(example).toContain('b0: ref(qualifiedName: "refs/heads/main")');
    // The gated PR always, the pending gateless PR too, the settled gateless tip not.
    const blocks = example.split(/(?=p7: pullRequest|p8: pullRequest|b0: ref)/);
    const asked = Object.fromEntries(
      blocks
        .slice(1)
        .map((block) => [block.slice(0, 2), block.includes("checkSuites(first: 100)")]),
    );
    expect(asked).toEqual({ p7: true, p8: true, b0: false });
    expect(fork).toContain("p3: pullRequest(number: 3)");
    expect(fork).not.toContain("ref(");
    // A first sighting reads the detail as its baseline, once per PR, and reports none of it.
    expect(s.ghCalls().filter((call) => call.includes("reviewThreads(first:"))).toHaveLength(3);
    // The settled gateless tip is the one verdict: the rollup says SUCCESS.
    expect(headlines(await box.frames(1))).toEqual([
      `branch ${MAIN}: CI green on ${SHORT_A}: 0 workflows`,
    ]);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
      `targets: 4\n  ${PR7}\n  ${REPO}#8\n  ${MAIN}\n  ${FORK}#3\n`,
    );
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a PR GitHub answers null for is one trouble event, said once, while the rest of the batch is read; a row that comes back clears it without a word", async () => {
    const s = new Scenario("null-alias");
    const box = await s.inbox("a");
    // GitHub answers the deleted PR with null and an errors entry, on which gh exits 1 with the
    // body still on stdout; a reader that dropped nonzero replies would lose PR 8's green with it.
    const notFound = [
      {
        type: "NOT_FOUND",
        message: "Could not resolve to a PullRequest with the number of 7.",
        path: ["r", "p7"],
      },
    ];
    s.fixtures({
      "rows-1": rows({
        p7: prNode({ rollup: "PENDING", suites: [] }),
        p8: prNode({ number: 8, rollup: "PENDING", suites: [] }),
      }),
      "rows-3": rows(
        { p7: null, p8: prNode({ number: 8, rollup: "SUCCESS", suites: [] }) },
        notFound,
      ),
      "rows-3.exit1": "gh: Could not resolve to a PullRequest with the number of 7.\n",
      "rows-5": rows({
        p7: prNode({ rollup: "PENDING", suites: [] }),
        p8: prNode({ number: 8, rollup: "SUCCESS", suites: [] }),
      }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    expect(s.run(["watch", `${REPO}#8`], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("2 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    const frames = await box.frames(1);
    expect(frames.map(text)).toEqual([
      [
        `PR ${PR7} is not readable; unwatch it or check access`,
        PR7_URL,
        "",
        `PR ${REPO}#8: CI green on ${SHORT_A}: 0 workflows`,
        `https://github.com/${REPO}/pull/8/checks`,
        CLOSING,
      ].join("\n"),
    ]);
    expect(s.events().map((e) => [e.kind, e.pr, e.sha])).toEqual([
      ["trouble", 7, null],
      ["ci", 8, HEAD_A],
    ]);
    const state = s.state();
    expect(state.targets[PR7]).toMatchObject({ form: "pr", seen: expect.anything() });
    expect(state.targets[PR7]).not.toHaveProperty("unreadable");
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a head move is an event naming the commit's author, own pushes included, and the new head is judged from nothing", async () => {
    const s = new Scenario("head");
    const box = await s.inbox("a");
    const green = (head: string): RowSpec => ({
      head,
      rollup: "SUCCESS",
      suites: [["ci", "COMPLETED", "SUCCESS", 700]],
    });
    s.fixtures({
      "rows-1": rows({ p7: prNode(green(HEAD_A)) }),
      // The viewer's own push: a head move is reported whoever made it.
      "rows-2": rows({
        p7: prNode({
          head: HEAD_B,
          author: "me",
          rollup: "PENDING",
          suites: [["ci", "IN_PROGRESS", null, 701]],
        }),
      }),
      "rows-3": rows({ p7: prNode({ ...green(HEAD_B), author: "me" }) }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, "--expect-workflow", "ci"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect((await box.frames(3)).map(text)).toEqual([
      [`PR ${PR7}: CI green on ${SHORT_A}: 1 workflow`, `${PR7_URL}/checks`, CLOSING].join("\n"),
      [
        `PR ${PR7}: head moved to ${SHORT_B}; last commit by me`,
        `${PR7_URL}/commits/${HEAD_B}`,
        CLOSING,
      ].join("\n"),
      [`PR ${PR7}: CI green on ${SHORT_B}: 1 workflow`, `${PR7_URL}/checks`, CLOSING].join("\n"),
    ]);
    expect(s.events().map((e) => e.sha)).toEqual([HEAD_A, HEAD_B, HEAD_B]);
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a merged PR says what it merged into, a closed one that it closed, and both leave the targets", async () => {
    const s = new Scenario("merged");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({
        p7: prNode({ rollup: "SUCCESS", suites: [] }),
        p8: prNode({ number: 8, rollup: "SUCCESS", suites: [] }),
      }),
      "rows-3": rows({
        p7: prNode({
          state: "MERGED",
          mergedAt: "2026-01-01T01:00:00Z",
          base: "release/2",
          rollup: "SUCCESS",
        }),
        p8: prNode({ number: 8, state: "CLOSED", rollup: "SUCCESS" }),
      }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    expect(s.run(["watch", `${REPO}#8`], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("2 event(s)");
    const frames = await box.frames(3);
    expect(text(frames[2] as string)).toBe(
      [
        `PR ${PR7}: merged into release/2`,
        PR7_URL,
        "",
        `PR ${REPO}#8: closed without merging`,
        `https://github.com/${REPO}/pull/8`,
        CLOSING,
      ].join("\n"),
    );
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("targets: 0");
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a label added or removed after the first sighting is one line per poll naming the labels, sorted, and nothing else; the labels a PR already carries are its baseline", async () => {
    const s = new Scenario("labels");
    const box = await s.inbox("a");
    const labelled = (minute: number, labels: string[]): RowSpec => ({
      rollup: "SUCCESS",
      updatedAt: `2026-01-01T00:${minute}:00Z`,
      labels,
    });
    s.fixtures({
      "rows-1": rows({ p7: prNode({ ...labelled(10, ["bug"]), suites: [] }) }),
      // GitHub lists labels in its own order; two added in one poll are one line, sorted.
      "rows-2": rows({ p7: prNode(labelled(11, ["merge-when-green", "bug", "approved"])) }),
      "rows-3": rows({ p7: prNode(labelled(12, ["approved"])) }),
      "rows-4": rows({ p7: prNode(labelled(13, ["needs-rebase"])) }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    for (let poll = 0; poll < 3; poll += 1) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    }
    expect((await box.frames(4)).map(text)).toEqual([
      [`PR ${PR7}: CI green on ${SHORT_A}: 0 workflows`, `${PR7_URL}/checks`, CLOSING].join("\n"),
      [`PR ${PR7}: labels added: approved, merge-when-green`, PR7_URL, CLOSING].join("\n"),
      [`PR ${PR7}: labels removed: bug, merge-when-green`, PR7_URL, CLOSING].join("\n"),
      [`PR ${PR7}: label added: needs-rebase; label removed: approved`, PR7_URL, CLOSING].join(
        "\n",
      ),
    ]);
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "label", "label", "label"]);
    expect(s.state().targets[PR7]).toMatchObject({ seen: { row: { labels: ["needs-rebase"] } } });
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a conflict is said when the merge test settles on it, once per settled stretch and again after a push it survived, " +
    "and resolved when it settles clean, a push in between or not; UNKNOWN says nothing; a PR already conflicting is said at its first sighting", async () => {
    const s = new Scenario("conflicts");
    const box = await s.inbox("a");
    const p7 = (mergeable: string, head = HEAD_A): RowSpec => ({
      head,
      mergeable,
      rollup: "SUCCESS",
    });
    s.fixtures({
      "rows-1": rows({ p7: prNode({ ...p7("MERGEABLE"), suites: [] }) }),
      "rows-2": rows({ p7: prNode(p7("UNKNOWN")) }),
      "rows-3": rows({ p7: prNode(p7("CONFLICTING")) }),
      "rows-4": rows({ p7: prNode(p7("UNKNOWN")) }),
      "rows-5": rows({ p7: prNode(p7("CONFLICTING")) }),
      // A push: GitHub recomputes, and a conflict that survives the push is news again.
      "rows-6": rows({ p7: prNode(p7("UNKNOWN", HEAD_B)) }),
      "rows-7": rows({ p7: prNode({ ...p7("CONFLICTING", HEAD_B), suites: [] }) }),
      "rows-8": rows({ p7: prNode(p7("MERGEABLE", HEAD_B)) }),
      "rows-9": rows({ p7: prNode(p7("CONFLICTING", HEAD_B)) }),
      // The rebase that fixes it: the resolved line follows the push once the test settles.
      "rows-10": rows({ p7: prNode(p7("UNKNOWN", HEAD_A)) }),
      "rows-11": rows({ p7: prNode({ ...p7("MERGEABLE", HEAD_A), suites: [] }) }),
      "rows-12": rows({
        p7: prNode(p7("MERGEABLE", HEAD_A)),
        p8: prNode({
          number: 8,
          base: "release/2",
          mergeable: "CONFLICTING",
          rollup: "SUCCESS",
          suites: [],
        }),
      }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    for (const count of [0, 1, 0]) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain(`${count} event(s)`);
    }
    // UNKNOWN moves nothing: the conflict line still stands after it.
    expect(s.state().targets[PR7]).toMatchObject({ seen: { conflict: "told" } });
    for (const count of [0, 1, 2, 1, 1, 1, 2]) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain(`${count} event(s)`);
    }
    expect(s.run(["watch", `${REPO}#8`], { inbox: box.path }).code).toBe(0);
    const conflicts = [`PR ${PR7}: conflicts with main; rebase needed`, PR7_URL, CLOSING].join(
      "\n",
    );
    const resolved = [`PR ${PR7}: conflicts resolved`, PR7_URL, CLOSING].join("\n");
    const headMoved = (sha: string) =>
      [
        `PR ${PR7}: head moved to ${sha.slice(0, 12)}; last commit by dev`,
        `${PR7_URL}/commits/${sha}`,
        CLOSING,
      ].join("\n");
    expect((await box.frames(9)).map(text)).toEqual([
      [`PR ${PR7}: CI green on ${SHORT_A}: 0 workflows`, `${PR7_URL}/checks`, CLOSING].join("\n"),
      conflicts,
      headMoved(HEAD_B),
      [
        `PR ${PR7}: conflicts with main; rebase needed`,
        PR7_URL,
        "",
        `PR ${PR7}: CI green on ${SHORT_B}: 0 workflows`,
        `${PR7_URL}/checks`,
        CLOSING,
      ].join("\n"),
      resolved,
      conflicts,
      headMoved(HEAD_A),
      [
        `PR ${PR7}: conflicts resolved`,
        PR7_URL,
        "",
        `PR ${PR7}: CI green on ${SHORT_A}: 0 workflows`,
        `${PR7_URL}/checks`,
        CLOSING,
      ].join("\n"),
      [
        `PR ${REPO}#8: conflicts with release/2; rebase needed`,
        `https://github.com/${REPO}/pull/8`,
        "",
        `PR ${REPO}#8: CI green on ${SHORT_A}: 0 workflows`,
        `https://github.com/${REPO}/pull/8/checks`,
        CLOSING,
      ].join("\n"),
    ]);
    expect(s.events().map((e) => [e.kind, e.pr])).toEqual([
      ["ci", 7],
      ["conflict", 7],
      ["head", 7],
      ["conflict", 7],
      ["ci", 7],
      ["conflict", 7],
      ["conflict", 7],
      ["head", 7],
      ["conflict", 7],
      ["ci", 7],
      ["conflict", 8],
      ["ci", 8],
    ]);
    expect(s.state().targets[PR7]).toMatchObject({ seen: { conflict: null } });
    expect(s.state().targets[`${REPO}#8`]).toMatchObject({ seen: { conflict: "told" } });
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a review and the comments beside it are counted, placed, and linked, and not one word of them is in the message or the log, whatever they say; the session's own login counts like any other; an id once fetched stays seen after it leaves the read window", async () => {
    const s = new Scenario("activity");
    const box = await s.inbox("a");
    const at = "2026-01-01T00:30:00Z";
    s.fixtures({
      "rows-1": rows({ p7: prNode({ rollup: "SUCCESS", suites: [] }) }),
      "rows-2": rows({
        p7: prNode({
          rollup: "SUCCESS",
          updatedAt: "2026-01-01T00:31:00Z",
          comments: 2,
          threads: 2,
        }),
      }),
      "detail-2": detail({
        comments: [
          { login: "hubot", at, body: INJECTION },
          { login: "me", at, body: "my own reply" },
        ],
        reviews: [{ id: "55", login: "octocat", at, state: "CHANGES_REQUESTED", body: INJECTION }],
        threads: [
          {
            path: "src/x.ts",
            line: 41,
            total: 1,
            comments: [{ login: "octocat", at, body: INJECTION, review: "55" }],
          },
          {
            path: "src/y.ts",
            line: 7,
            total: 1,
            comments: [{ login: "octocat", at, body: INJECTION, review: "55" }],
          },
        ],
      }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("2 event(s)");
    const frames = await box.frames(2);
    expect(text(frames[1] as string)).toBe(
      [
        `PR ${PR7}: review by octocat (CHANGES_REQUESTED), 2 comments`,
        `${PR7_URL}#pullrequestreview-55`,
        "",
        `PR ${PR7}: 2 new comments by hubot, me`,
        `${PR7_URL}#issuecomment-902`,
        CLOSING,
      ].join("\n"),
    );
    expect(frames.join("\n")).not.toContain("ignore previous");
    expect(readFileSync(s.files().events, "utf-8")).not.toContain("ignore previous");
    expect(readFileSync(s.files().state, "utf-8")).not.toContain("ignore previous");
    // A loose inline comment, a reply in an existing thread, is placed by path and line.
    s.fixtures({
      "rows-3": rows({
        p7: prNode({
          rollup: "SUCCESS",
          updatedAt: "2026-01-01T00:32:00Z",
          comments: 2,
          threads: 2,
        }),
      }),
      "detail-3": detail({
        comments: [
          { login: "hubot", at, body: INJECTION, id: 901 },
          { login: "me", at, body: "my own reply", id: 902 },
        ],
        reviews: [{ id: "55", login: "octocat", at, state: "CHANGES_REQUESTED", body: INJECTION }],
        threads: [
          {
            path: "src/x.ts",
            line: 41,
            total: 2,
            comments: [
              { login: "octocat", at, body: INJECTION, review: "55", id: 903 },
              { login: "hubot", at: "2026-01-01T00:32:00Z", body: "reply", id: 905 },
            ],
          },
          {
            path: "src/y.ts",
            line: 7,
            total: 1,
            comments: [{ login: "octocat", at, body: INJECTION, review: "55", id: 904 }],
          },
        ],
      }),
    });
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(text((await box.frames(3))[2] as string)).toBe(
      [
        `PR ${PR7}: 1 new comment by hubot at src/x.ts:41`,
        `${PR7_URL}#discussion_r905`,
        CLOSING,
      ].join("\n"),
    );
    // The thread grows past its three-comment window: 903 leaves it on the fourth read and is
    // still a seen id after the fifth, so a deletion that pulls it back cannot make it news.
    const thread = (ids: number[], total: number) => ({
      path: "src/x.ts",
      line: 41,
      total,
      comments: ids.map((id) => ({ login: "hubot", at: "2026-01-01T00:33:00Z", body: "more", id })),
    });
    for (const [n, ids] of [
      [4, [905, 906, 907]],
      [5, [906, 907, 908]],
    ] as const) {
      s.fixtures({
        [`rows-${n}`]: rows({
          p7: prNode({
            rollup: "SUCCESS",
            updatedAt: `2026-01-01T00:3${n}:00Z`,
            comments: 2,
            threads: 2,
          }),
        }),
        [`detail-${n}`]: detail({
          comments: [
            { login: "hubot", at, body: INJECTION, id: 901 },
            { login: "me", at, body: "my own reply", id: 902 },
          ],
          reviews: [
            { id: "55", login: "octocat", at, state: "CHANGES_REQUESTED", body: INJECTION },
          ],
          threads: [
            thread([...ids], n + 1),
            {
              path: "src/y.ts",
              line: 7,
              total: 1,
              comments: [{ login: "octocat", at, body: INJECTION, review: "55", id: 904 }],
            },
          ],
        }),
      });
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    }
    expect(headlines(await box.frames(5)).slice(3)).toEqual([
      `PR ${PR7}: 2 new comments by hubot at src/x.ts:41`,
      `PR ${PR7}: 1 new comment by hubot at src/x.ts:41`,
    ]);
    const remembered = (s.state().targets[PR7] as { seen: { activity: string[] } }).seen.activity;
    expect(remembered).toEqual(
      expect.arrayContaining(["comment:901", "review-comment:903", "review-comment:908"]),
    );
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a red names the failed workflow, job, and step from one read, said once; a gate re-run to green is judged without a head move; a bystander's failure is not the gate's", async () => {
    const s = new Scenario("red");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({
        b0: refNode({
          rollup: "FAILURE",
          suites: [
            ["ci", "COMPLETED", "FAILURE", 500],
            ["lint", "COMPLETED", "SUCCESS", 501],
          ],
        }),
      }),
      "jobs-1": jobs({
        S500: [
          {
            job: "test",
            steps: [
              ["Checkout", "SUCCESS"],
              ["Run tests", "FAILURE"],
            ],
          },
        ],
      }),
      // A re-run keeps its run id: the same runs, concluded the other way round.
      "rows-3": rows({
        b0: refNode({
          rollup: "FAILURE",
          suites: [
            ["ci", "COMPLETED", "SUCCESS", 500],
            ["lint", "COMPLETED", "FAILURE", 501],
          ],
        }),
      }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", MAIN, "--expect-workflow", "ci"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect((await box.frames(2)).map(text)).toEqual([
      [
        `branch ${MAIN}: CI red on ${SHORT_A}: ci / test / Run tests`,
        `https://github.com/${REPO}/actions/runs/500`,
        CLOSING,
      ].join("\n"),
      [`branch ${MAIN}: CI green on ${SHORT_A}: 2 workflows`, `${MAIN_URL}/checks`, CLOSING].join(
        "\n",
      ),
    ]);
    // The failed-jobs read happened for the red once, not on the quiet poll after it.
    expect(s.ghCalls().filter((call) => call.includes("nodes(ids:"))).toHaveLength(1);
    // The gated head's suites were asked for on every poll, the quiet one included, which is how
    // the re-run was seen with the rollup unmoved.
    const reads = s.ghCalls().filter((call) => call.includes("r: repository("));
    expect(reads).toHaveLength(3);
    expect(reads.every((call) => call.includes("checkSuites(first: 100)"))).toBe(true);
    expect(s.events().map((e) => [e.kind, e.branch, e.sha])).toEqual([
      ["ci", "main", HEAD_A],
      ["ci", "main", HEAD_A],
    ]);
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a gate with no run waits while the rollup is pending and is one trouble event once it settled; a head with more than a page of suites is read page by page and confirmed", async () => {
    const s = new Scenario("missing");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ b0: refNode({ rollup: "PENDING", suites: [["ci", "IN_PROGRESS", null]] }) }),
      "rows-2": rows({
        b0: refNode({ rollup: "SUCCESS", suites: [["ci", "COMPLETED", "SUCCESS"]] }),
      }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", MAIN, "--expect-workflow", "nope"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect((await box.frames(1)).map(text)).toEqual([
      [
        `branch ${MAIN}: CI settled on ${SHORT_A} with no run of nope; check the workflow name`,
        `${MAIN_URL}/checks`,
        CLOSING,
      ].join("\n"),
    ]);
    expect(s.events().map((e) => e.kind)).toEqual(["trouble"]);

    const paged = new Scenario("paged");
    const pagedBox = await paged.inbox("a");
    const page1 = JSON.stringify({
      data: {
        repository: {
          object: {
            checkSuites: {
              nodes: suiteNodes([["ci", "COMPLETED", "SUCCESS", 600]]),
              pageInfo: { hasNextPage: true, endCursor: "p2" },
            },
          },
        },
      },
    });
    const page2 = JSON.stringify({
      data: {
        repository: {
          object: {
            checkSuites: {
              nodes: suiteNodes([["lint", "COMPLETED", "SUCCESS", 601]]),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    // The second read's page 2 differs from the first's (a bystander re-ran), so a third read
    // confirms it; judged on the first two, a changing list would have been a verdict.
    const page2Rerun = JSON.stringify({
      data: {
        repository: {
          object: {
            checkSuites: {
              nodes: suiteNodes([["lint", "COMPLETED", "FAILURE", 602]]),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    paged.fixtures({
      "rows-1": rows({
        p7: prNode({
          rollup: "SUCCESS",
          suites: [["ci", "COMPLETED", "SUCCESS", 600]],
          suitesNext: "p2",
        }),
      }),
      "suites-1": page1,
      "suites-2": page2,
      "suites-3": page1,
      "suites-4": page2Rerun,
      "suites-5": page1,
      "suites-6": page2Rerun,
    });
    await paged.start({ inbox: pagedBox.path });
    expect(
      paged.run(["watch", PR7, "--expect-workflow", "ci"], { inbox: pagedBox.path }).code,
    ).toBe(0);
    expect((await pagedBox.frames(1)).map(text)).toEqual([
      [`PR ${PR7}: CI green on ${SHORT_A}: 2 workflows`, `${PR7_URL}/checks`, CLOSING].join("\n"),
    ]);
    const suiteCalls = paged
      .ghCalls()
      .filter((call) => call.includes("checkSuites(first: 100, after:"));
    expect(suiteCalls.map((call) => call.includes("-f cursor=p2"))).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(paged.violations()).toBe("");
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
    paged.stop({ inbox: pagedBox.path });
  }, 30000);
});

describe("the target modules", () => {
  test("a target parses in one form or the other, and the empty COMMENTED review GitHub wraps inline comments in is dropped when none of its comments is new", () => {
    expect(parsePrTarget("octo/example#7", ["ci"])).toEqual({
      form: "pr",
      repo: "octo/example",
      number: 7,
      gates: ["ci"],
      seen: null,
    });
    expect(parsePrTarget("octo/example:main", [])).toBeNull();
    // Past GraphQL's Int the whole repository query would be invalid, every target with it.
    expect(parsePrTarget("octo/example#2147483647", [])).toMatchObject({ number: 2147483647 });
    expect(parsePrTarget("octo/example#2147483648", [])).toBeNull();
    expect(parseBranchTarget("octo/example:release/2", [])).toEqual({
      form: "branch",
      repo: "octo/example",
      branch: "release/2",
      gates: [],
      seen: null,
    });
    const wrapper: Activity = {
      id: "review:1",
      kind: "review",
      at: "2026-01-01T00:00:00Z",
      author: "octocat",
      hasBody: false,
      url: "u",
      reviewState: "COMMENTED",
    };
    expect(describeActivities("PR x#1", [wrapper])).toEqual([]);
    expect(describeActivities("PR x#1", [{ ...wrapper, reviewState: "APPROVED" }])).toEqual([
      { kind: "review", text: "PR x#1: review by octocat (APPROVED)", url: "u" },
    ]);
  });
});

describe("a head nothing runs on, and a target whose own reads keep failing", () => {
  test("a named gate on a head with no checks at all is missing after two polls, said once; a settled rollup says so at once", async () => {
    const s = new Scenario("no-runs");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({
        p7: prNode({ rollup: null, suites: [["lint", "QUEUED", null]] }),
        p8: prNode({ number: 8, rollup: "SUCCESS", suites: [["lint", "COMPLETED", "SUCCESS"]] }),
      }),
    });
    await s.start({ inbox: box.path });
    // PR 7 has no checks at all: pending for one poll, missing on the second, then quiet. PR 8's
    // rollup settled without the gate: missing at once.
    expect(s.run(["watch", PR7, "--expect-workflow", "CI"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.run(["watch", `${REPO}#8`, "--expect-workflow", "CI"], { inbox: box.path }).code).toBe(
      0,
    );
    expect((await box.frames(2)).map(text)).toEqual([
      [
        `PR ${PR7}: no checks on ${SHORT_A} after 2 polls, so no run of CI; check the workflow name`,
        `${PR7_URL}/checks`,
        CLOSING,
      ].join("\n"),
      [
        `PR ${REPO}#8: CI settled on ${SHORT_A} with no run of CI; check the workflow name`,
        `https://github.com/${REPO}/pull/8/checks`,
        CLOSING,
      ].join("\n"),
    ]);
    expect(s.events().map((e) => e.kind)).toEqual(["trouble", "trouble"]);
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a head with no checks and no gate has no CI: nothing is said, its suites are not asked for again, and the watch idles until a rollup appears, when it is judged again", async () => {
    const s = new Scenario("no-ci");
    const box = await s.inbox("a");
    s.fixtures({
      // A run with no job yet lists a suite and leaves the rollup null: no checks, so no CI.
      "rows-1": rows({ b0: refNode({ rollup: null, suites: [["ci", "QUEUED", null]] }) }),
      "rows-3": rows({ b0: refNode({ rollup: "PENDING", suites: [] }) }),
    });
    // Busy polls are 1 s apart; a quiet poll doubles the wait. The watch's read and the poll's
    // are both quiet, so the daemon's log says so, and the second read is two doublings in.
    await s.start({ inbox: box.path, args: ["--interval", "1"] });
    expect(s.run(["watch", MAIN], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.log()).toContain("poll: 0 event(s), quiet; next in 4 s");
    expect(s.rowsCalls()).toEqual(["example", "example"]);
    expect(s.ghCalls().filter((call) => call.includes("checkSuites("))).toHaveLength(1);
    expect(s.state().targets[MAIN]).toMatchObject({ seen: { ci: "none", verdict: null } });
    // The rollup appears: that poll is busy, the next asks for the suites, and the head is pending.
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    const deadline = Date.now() + 3000;
    while (s.rowsCalls().length < 4 && Date.now() < deadline) await Bun.sleep(50);
    expect(s.rowsCalls().length).toBeGreaterThanOrEqual(4);
    expect(s.ghCalls().filter((call) => call.includes("checkSuites(")).length).toBeGreaterThan(1);
    expect(s.state().targets[MAIN]).toMatchObject({ seen: { ci: "pending" } });
    expect(s.events()).toEqual([]);
    // The rollup settles: the head that was no CI gets its verdict like any other. The stub serves
    // this fixture to every read from the fifth on, so whichever poll reads it first says green.
    s.fixtures({
      "rows-5": rows({
        b0: refNode({ rollup: "SUCCESS", suites: [["ci", "COMPLETED", "SUCCESS"]] }),
      }),
    });
    s.run(["poll"], { inbox: box.path });
    expect(headlines(await box.frames(1))).toEqual([
      `branch ${MAIN}: CI green on ${SHORT_A}: 1 workflow`,
    ]);
    expect(s.state().targets[MAIN]).toMatchObject({ seen: { ci: "green", verdict: "green" } });
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a repository read that fails three polls in a row is the daemon's one trouble line naming its log; no cursor moves, and the read coming back judges the head", async () => {
    const s = new Scenario("fail-rows");
    const box = await s.inbox("a");
    s.fixtures({ "rows-1": rows({ b0: refNode({ rollup: "SUCCESS", suites: [] }) }) });
    writeFileSync(join(s.fixtureDir, "fail-rows"), "HTTP 502");
    await s.start({ inbox: box.path });
    expect(s.run(["watch", MAIN], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect((await box.frames(1)).map(text)).toEqual([
      [
        "github-events: the last 3 polls failed; read the daemon log for the reason",
        s.files().log,
        CLOSING,
      ].join("\n"),
    ]);
    expect(s.log()).toContain("poll failed (3 in a row): gh api graphql exited 1: gh: HTTP 502");
    expect(s.state().targets[MAIN]).toMatchObject({ seen: null });
    expect(s.state().targets[MAIN]).not.toHaveProperty("readFailures");
    rmSync(join(s.fixtureDir, "fail-rows"));
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(2))[1]).toBe(
      `branch ${MAIN}: CI green on ${SHORT_A}: 0 workflows`,
    );
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a target whose detail read fails three polls in a row is one trouble event naming the count, while the repository read keeps the other targets served; a success resets the count", async () => {
    const s = new Scenario("read-failures");
    const box = await s.inbox("a");
    const row = (minute: number) =>
      prNode({ rollup: "SUCCESS", suites: [], updatedAt: `2026-01-01T00:${minute}:00Z` });
    const p8 = prNode({ number: 8, rollup: "SUCCESS", suites: [] });
    s.fixtures({
      "rows-1": rows({ p7: row(10), p8 }),
      "rows-2": rows({ p7: row(11), p8 }),
      // PR 8 merges while PR 7's reads fail: the batch keeps serving it.
      "rows-3": rows({
        p7: row(12),
        p8: prNode({ number: 8, state: "MERGED", rollup: "SUCCESS" }),
      }),
      "rows-4": rows({ p7: row(13) }),
      "rows-5": rows({ p7: row(14) }),
    });
    await s.start({ inbox: box.path });
    // PR 8 takes its baseline first; then every detail read fails, and only PR 7, which still
    // needs its baseline, reads one. The failing watch still returns, the target stays, the
    // count starts; the repository read keeps answering for both.
    expect(s.run(["watch", `${REPO}#8`], { inbox: box.path }).code).toBe(0);
    writeFileSync(join(s.fixtureDir, "fail-detail"), "GraphQL 502");
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(headlines(await box.frames(3))).toEqual([
      `PR ${REPO}#8: CI green on ${SHORT_A}: 0 workflows`,
      `PR ${REPO}#8: merged into main`,
      `PR ${PR7}: 3 reads failed; read the daemon log`,
    ]);
    expect(s.events().map((e) => [e.kind, e.pr])).toEqual([
      ["ci", 8],
      ["merged", 8],
      ["trouble", 7],
    ]);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(`targets: 1\n  ${PR7}\n`);
    expect(
      s
        .log()
        .split("\n")
        .filter((line) => line.includes(`${PR7}: gh api graphql exited 1`)),
    ).toHaveLength(4);
    expect(s.state().targets[PR7]).toMatchObject({ readFailures: 4, seen: null });
    // A merge ends the watch whether or not the detail read works: the finished PR must not stay.
    const merged = new Scenario("merged-unreadable");
    const mergedBox = await merged.inbox("a");
    merged.fixtures({
      "rows-1": rows({ p7: prNode({ rollup: "SUCCESS", suites: [] }) }),
      "rows-2": rows({
        p7: prNode({ state: "MERGED", mergedAt: "2026-01-01T01:00:00Z", rollup: "SUCCESS" }),
      }),
    });
    writeFileSync(join(merged.fixtureDir, "fail-detail"), "GraphQL 502");
    await merged.start({ inbox: mergedBox.path });
    expect(merged.run(["watch", PR7], { inbox: mergedBox.path }).code).toBe(0);
    expect(merged.run(["poll"], { inbox: mergedBox.path }).stdout).toContain("1 event(s)");
    expect(headlines(await mergedBox.frames(1))).toEqual([`PR ${PR7}: merged into main`]);
    expect(merged.run(["status"], { inbox: mergedBox.path }).stdout).toContain("targets: 0");
    merged.stop({ inbox: mergedBox.path });
    // The read comes back: the baseline is taken, the gateless SUCCESS rollup is green, the count goes.
    rmSync(join(s.fixtureDir, "fail-detail"));
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(4))[3]).toBe(
      `PR ${PR7}: CI green on ${SHORT_A}: 0 workflows`,
    );
    expect(s.state().targets[PR7]).not.toHaveProperty("readFailures");
    expect(s.state().targets[PR7]).toMatchObject({ seen: expect.anything() });
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);
});

describe("the two skills side by side", () => {
  test("installed as sibling folders, copied or symlinked, the GitHub source finds the library; with the base removed it exits 2 naming the install command", () => {
    // `npx skills add --skill <name>` copies one skill folder into a canonical directory and
    // symlinks the agent's skills directory to it, so the two skills stay siblings in both.
    const root = temp.dir("github-events-layout-");
    const canon = join(root, "canonical");
    mkdirSync(canon);
    for (const skill of ["session-events", "watch-github"]) {
      cpSync(join(ROOT, "skills", skill), join(canon, skill), { recursive: true });
    }
    const agent = join(root, "agent");
    mkdirSync(agent);
    for (const skill of ["session-events", "watch-github"]) {
      symlinkSync(join(canon, skill), join(agent, skill));
    }
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    const run = (skillsDir: string) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(skillsDir, "watch-github", "scripts", "github-events.mts"),
          "status",
          "--id",
          "layout",
        ],
        {
          env: { ...process.env, PATH: emptyBinDir, SESSION_EVENTS_DIR: runtime },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return { code: result.exitCode, stderr: result.stderr.toString() };
    };
    // bun names the script by its real path, so the symlinked layout prints the canonical one.
    for (const skillsDir of [canon, agent]) {
      const r = run(skillsDir);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(
        `bun "${join(canon, "watch-github", "scripts", "github-events.mts")}" daemon --id layout`,
      );
    }
    rmSync(join(canon, "session-events"), { recursive: true });
    for (const skillsDir of [canon, agent]) {
      const r = run(skillsDir);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        "install it beside this skill: npx skills add Vivswan/skills -g --skill session-events",
      );
    }
    expect(SCRIPT.endsWith("github-events.mts")).toBe(true);
  }, 30000);
});
