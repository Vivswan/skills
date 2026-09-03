import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Every verdict branch of retire-branch.mts is forced by a scratch repository
// built to produce it, run through the REAL entry point as a child. Cases are
// independent (own repository under the launcher's TMPDIR) and run in a pool.

const SCRIPT = join(ROOT, "skills", "worktree-hygiene", "scripts", "retire-branch.mts");
const REAL_GIT = Bun.which("git") ?? "/usr/bin/git";
const CASE_TIMEOUT_MS = 240_000;

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_BROKEN = 3;

const USAGE = [
  "usage: retire-branch.mts --branch <name> [options]",
  "",
  "  --branch <name>       the branch to retire (required)",
  "  --repo-root <path>    repository to operate in (default: cwd)",
  "  --remote <name>       remote to fetch the mainline from (default: origin)",
  "  --mainline <name>     branch the work must have landed on (default: main)",
  "  --original-tip <sha>  pre-rebase tip to also prove landed",
  "  --no-writer-check     skip the lsof live-writer probe (hosts without a usable lsof)",
  "  --execute             actually remove the worktree and delete the branch",
  "",
  "exit codes: 0 every requested step passed; 1 a gate refused on the evidence;",
  "            2 usage error; 3 broken measurement (the question was never answered)",
].join("\n");

// --- pool -------------------------------------------------------------------

const workspaces: string[] = [];
let running = 0;
const waiting: Array<() => void> = [];
const POOL_SIZE = availableParallelism();

async function withSlot<T>(body: () => Promise<T>): Promise<T> {
  if (running >= POOL_SIZE) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await body();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function scenario(name: string, body: (workspace: string) => Promise<void>): void {
  test.concurrent(
    name,
    () =>
      withSlot(async () => {
        const workspace = mkdtempSync(join(tmpdir(), "retire-branch-"));
        workspaces.push(workspace);
        await body(workspace);
      }),
    CASE_TIMEOUT_MS,
  );
}

afterAll(() => {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
});

// --- child processes --------------------------------------------------------

interface Spawned {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnText(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
): Promise<Spawned> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // A child killed by a signal produced NO verdict; folding that into a
  // sentinel exit code would make it look like one.
  if (child.exitCode === null) {
    throw new Error(
      `${argv.join(" ")} was killed by ${child.signalCode ?? "an unknown signal"} (stderr: ${stderr})`,
    );
  }
  return { status: child.exitCode, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnText(["git", ...args], { cwd, timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(`fixture: git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function gitStatus(cwd: string, ...args: string[]): Promise<number> {
  return (await spawnText(["git", ...args], { cwd, timeoutMs: 30_000 })).status;
}

/** Raw stdout bytes, for listings whose paths need not be valid UTF-8. */
async function gitBytes(
  cwd: string,
  input: Uint8Array | undefined,
  ...args: string[]
): Promise<Buffer> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: process.env,
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (child.exitCode !== 0) {
    throw new Error(`fixture: git ${args.join(" ")} in ${cwd} exited ${child.exitCode}: ${stderr}`);
  }
  return Buffer.from(stdout);
}

async function rev(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, "rev-parse", ref)).trim();
}

/** The ref's state: its sha, `symref:<target>` (dangling or not), "absent", or "unreadable:<codes>". */
async function tip(repo: string, branch: string): Promise<string> {
  const ref = `refs/heads/${branch}`;
  const symref = await spawnText(["git", "symbolic-ref", "-q", ref], {
    cwd: repo,
    timeoutMs: 30_000,
  });
  if (symref.status === 0) return `symref:${symref.stdout.trim()}`;
  const resolved = await spawnText(["git", "rev-parse", "--verify", "--quiet", ref], {
    cwd: repo,
    timeoutMs: 30_000,
  });
  if (resolved.status === 0) return resolved.stdout.trim();
  if (resolved.status === 1 && symref.status === 1) return "absent";
  return `unreadable:${resolved.status}/${symref.status}`;
}

// --- the outcome ------------------------------------------------------------

interface Site {
  readonly repo: string;
  /** The branch whose tip is watched across the run (default: topic). */
  readonly branch?: string;
  /** The worktree whose survival is watched across the run. */
  readonly tree?: string;
}

interface Outcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly branch: "unchanged" | "moved" | "absent";
  readonly tree: "present" | "absent" | "none";
}

// Placeholders let a whole transcript be pinned: the workspace path (as given and
// as git canonicalises it), process ids, and commit ids numbered by first
// appearance, so one commit reads the same at both widths and swaps are visible.
function normalize(text: string, ws: string, numbered = new Map<string, string>()): string {
  return text
    .replaceAll(realpathSync(ws), "<ws>")
    .replaceAll(ws, "<ws>")
    .replace(/\bpid \d+\b/g, "pid <pid>")
    .replace(/refs\/retire-branch\/\d+\//g, "refs/retire-branch/<pid>/")
    .replace(/\b[0-9a-f]{12}(?:[0-9a-f]{28})?\b/g, (hex) => {
      const key = hex.slice(0, 12);
      const name = numbered.get(key) ?? `<sha${numbered.size + 1}>`;
      numbered.set(key, name);
      return name;
    })
    .trimEnd();
}

/** The one assertion shape: exit code, complete transcript, and what the run did to the repository. */
async function retire(
  ws: string,
  site: Site,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; script?: string } = {},
): Promise<Outcome> {
  const branch = site.branch ?? "topic";
  const before = await tip(site.repo, branch);
  const result = await spawnText([process.execPath, options.script ?? SCRIPT, ...args], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 120_000,
  });
  const after = await tip(site.repo, branch);
  const numbered = new Map<string, string>();
  return {
    status: result.status,
    stdout: normalize(result.stdout, ws, numbered),
    stderr: normalize(result.stderr, ws, numbered),
    branch: after === "absent" ? "absent" : after === before ? "unchanged" : "moved",
    tree: site.tree === undefined ? "none" : existsSync(site.tree) ? "present" : "absent",
  };
}

const lines = (...text: string[]): string => text.join("\n");
const FETCH = "[fetch] origin/main -> <sha1> (the remote-tracking ref was already current)";
const FETCH_STALE = "[fetch] origin/main -> <sha1> (the pre-fetch origin/main was STALE at <sha2>)";
const BRANCH = "[branch] refs/heads/topic is at <sha2>";
const LANDED = "[landed] by ancestry: topic is contained in <sha1>";
const NO_TREE = "[worktree] no worktree holds refs/heads/topic";
const HELD = "[recheck] origin/main did not move; the gates still hold";
const MOVED = "[recheck] origin/main moved <sha1> -> <sha3> while the gates ran";
const RECHECKED = "topic (re-checked: origin/main moved <sha1> -> <sha3> while the gates ran)";
const DELETED = "[delete] deleted refs/heads/topic (was <sha2>)";
const RETIRED = "LANDED: topic retired at <sha2>";
const WOULD_DELETE = "[delete] would delete refs/heads/topic at <sha2> (add --execute)";
const REHEARSED = "REHEARSED: every gate passed for topic; nothing was destroyed";
const SKIPPED = "[worktree] live-writer probe SKIPPED (--no-writer-check): no evidence either way";
const ALLOW_NO_TREE = lines(FETCH, BRANCH, LANDED, NO_TREE, HELD, DELETED, RETIRED);

const landedByContent = (paths: number, label = "topic"): string =>
  `[landed] by content equivalence at <sha3>: ${label} matches <sha1> on all ${paths} path(s) it changed`;
/** Placeholders name commits by first appearance: <sha1> the fetched mainline, <sha2> the branch tip. */
const notContained = (label = "topic", subject = "<sha2>", reference = "<sha1>"): string =>
  `${label} (${subject}) is NOT contained in the mainline tip (${reference})`;
const differs = (
  paths: string,
  label = "topic",
  subject = "<sha2>",
  reference = "<sha1>",
): string =>
  `REFUSED: ${notContained(label, subject, reference)}, and its content differs from that tip on ${paths.split(", ").length} path(s): ${paths}`;
const clean = (tree: string): string => `[worktree] ${tree} is clean and idle`;
const removed = (tree: string): string => `[worktree] removed ${tree}`;
const allowWithTree = (tree: string): string =>
  lines(FETCH, BRANCH, LANDED, clean(tree), HELD, removed(tree), DELETED, RETIRED);
const holdsWork = (tree: string, reasons: string[], late = ""): string =>
  `REFUSED: the worktree ${tree} holds work${late}:\n  - ${reasons.join("\n  - ")}`;
const probeBroken = (tree: string, why: string): string =>
  `BROKEN: the live-writer probe on ${tree} could not run (${why}); re-run where lsof works, or pass --no-writer-check to proceed without this evidence`;

// --- fixtures ---------------------------------------------------------------

/** A repo with `origin`, one commit on main, and a `topic` branch off it. */
async function buildRepo(
  workspace: string,
  name: string,
): Promise<{ repo: string; origin: string }> {
  const origin = join(workspace, `${name}-origin.git`);
  const repo = join(workspace, name);
  mkdirSync(repo, { recursive: true });
  await git(workspace, "init", "-q", "--bare", "-b", "main", origin);
  await git(workspace, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-q", "origin", "main");
  await git(repo, "branch", "topic");
  return { repo, origin };
}

async function commitOnBranch(
  repo: string,
  branch: string,
  file: string,
  body: string,
): Promise<void> {
  const worktree = join(repo, `.fixture-${branch}`);
  await git(repo, "worktree", "add", "-q", worktree, branch);
  writeFileSync(join(worktree, file), body);
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-qm", `work on ${branch}`);
  await git(repo, "worktree", "remove", "--force", worktree);
}

/** Commit directly on main, which the repo's own worktree has checked out. */
async function commitOnMain(repo: string, file: string, body: string): Promise<void> {
  writeFileSync(join(repo, file), body);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", `work on main: ${file}`);
}

async function landTopicNamed(repo: string, branch: string): Promise<void> {
  await git(repo, "merge", "-q", "--no-ff", "-m", `land ${branch}`, branch);
  await git(repo, "push", "-q", "origin", "main");
}

/** Merge `topic` into main and push, so the branch is genuinely landed. */
function landTopic(repo: string): Promise<void> {
  return landTopicNamed(repo, "topic");
}

/** A squash merge: main gets one new commit with topic's tree; topic's shas never land. */
async function squashLandTopic(repo: string): Promise<void> {
  await git(repo, "merge", "-q", "--squash", "topic");
  await git(repo, "commit", "-qm", "squash topic");
  await git(repo, "push", "-q", "origin", "main");
}

/** A landed topic checked out in a worktree named `<name>-tree`. */
async function landedWithTree(ws: string, name: string): Promise<{ repo: string; tree: string }> {
  const { repo } = await buildRepo(ws, name);
  await commitOnBranch(repo, "topic", "t.txt", "topic\n");
  await landTopic(repo);
  const tree = join(ws, `${name}-tree`);
  await git(repo, "worktree", "add", "-q", tree, "topic");
  return { repo, tree };
}

async function privateRefs(repo: string): Promise<string> {
  return (await git(repo, "for-each-ref", "--format=%(refname)", "refs/retire-branch/")).trim();
}

function shimDir(workspace: string, tag: string, binary: string, body: string): string {
  const dir = join(workspace, `bin-${tag}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, binary);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}

function onPath(dir: string): Record<string, string> {
  return { PATH: `${dir}:${process.env.PATH ?? ""}` };
}

/** A `git` shim: `arms` are case arms over "$*"; everything falls through to the real git. */
function gitShim(workspace: string, tag: string, ...arms: string[]): Record<string, string> {
  return onPath(
    shimDir(
      workspace,
      tag,
      "git",
      [`case "$*" in`, ...arms, "esac", `exec "${REAL_GIT}" "$@"`].join("\n"),
    ),
  );
}

/** A `git` shim that fails ONE subcommand and execs the real git for everything else. */
function gitFailingShim(workspace: string, tag: string, match: string): Record<string, string> {
  return gitShim(workspace, tag, `  *"${match}"*) echo "shim: refusing ${match}" >&2; exit 1 ;;`);
}

/** Shell that runs `action` the Nth time it is reached, counted through marker files. */
function onNth(marker: string, n: number, action: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const file = i === 1 ? marker : `${marker}.${i}`;
    const keyword = i === 1 ? "if" : "elif";
    lines.push(`${keyword} [ ! -f "${file}" ]; then : > "${file}"${i === n ? `; ${action}` : ""}`);
  }
  lines.push("fi");
  return lines.join("\n");
}

/** A git shim that runs `action` the Nth time `stash list` runs: after the landing gate, before the destruction. */
function afterGates(
  workspace: string,
  tag: string,
  n: number,
  action: string,
): Record<string, string> {
  return gitShim(
    workspace,
    tag,
    `  *"stash list"*)\n${onNth(join(workspace, `${tag}-done`), n, action)}\n;;`,
  );
}

/** A git shim that runs `action` during the SECOND mainline fetch: the pre-destruction re-fetch. */
function duringRefetch(workspace: string, tag: string, action: string): Record<string, string> {
  return gitShim(
    workspace,
    tag,
    `  *fetch*refs/retire-branch/*)\n${onNth(join(workspace, `${tag}-fetch`), 2, action)}\n;;`,
  );
}

// --- the cases --------------------------------------------------------------

describe("retire-branch.mts landing gates", () => {
  scenario(
    "ALLOW: a merged branch passes every gate and is deleted at its verified sha",
    async (ws) => {
      const { repo } = await buildRepo(ws, "allow");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_OK,
        stdout: ALLOW_NO_TREE,
        stderr: "",
        branch: "absent",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: an UNMERGED branch is not deleted (the case a swapped comparison passes)",
    async (ws) => {
      const { repo } = await buildRepo(ws, "unmerged");
      await commitOnBranch(repo, "topic", "t.txt", "unlanded\n");
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("t.txt"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("META: the swapped argument order ALLOWS exactly that unmerged shape", async (ws) => {
    // Both orders agree on a merged branch, which is why a merged-only suite
    // cannot see the bug at all.
    const { repo } = await buildRepo(ws, "swapped");
    await commitOnBranch(repo, "topic", "t.txt", "unlanded\n");
    const main = await rev(repo, "main");
    const topic = await rev(repo, "topic");
    const unmerged = {
      correct: await gitStatus(repo, "merge-base", "--is-ancestor", topic, main),
      swapped: await gitStatus(repo, "merge-base", "--is-ancestor", main, topic),
    };
    await git(repo, "checkout", "-q", "main");
    await git(repo, "merge", "-q", "--no-ff", "-m", "land", "topic");
    const merged = await gitStatus(
      repo,
      "merge-base",
      "--is-ancestor",
      await rev(repo, "topic"),
      await rev(repo, "main"),
    );
    expect({ unmerged, merged }).toEqual({ unmerged: { correct: 1, swapped: 0 }, merged: 0 });
  });

  scenario(
    "REFUSE: a stale remote-tracking ref would FALSE-ALLOW; the fetch catches it",
    async (ws) => {
      const { repo, origin } = await buildRepo(ws, "stale");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      const base = await rev(repo, "main");
      await landTopic(repo);
      await git(repo, "fetch", "-q", "origin", "main");
      // The rewrite happens from ANOTHER clone: pushing from `repo` would
      // update its own origin/main and the staleness would not reproduce.
      const other = join(ws, "stale-other");
      await git(ws, "clone", "-q", origin, other);
      await git(other, "push", "-q", "--force", "origin", `${base}:refs/heads/main`);
      const staleAllows = await gitStatus(
        repo,
        "merge-base",
        "--is-ancestor",
        await rev(repo, "topic"),
        "refs/remotes/origin/main",
      );
      expect({
        staleAllows,
        ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"])),
      }).toEqual({
        staleAllows: 0,
        status: EXIT_REFUSED,
        stdout: lines(FETCH_STALE, "[branch] refs/heads/topic is at <sha3>"),
        stderr: differs("t.txt", "topic", "<sha3>"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: FETCH_HEAD, not the tracking ref - a fetch need not update origin/<mainline>",
    async (ws) => {
      // Narrow the remote's refspec: the fetch still retrieves the true tip
      // while origin/main stays frozen at a tip that DOES contain the branch.
      const { repo, origin } = await buildRepo(ws, "refspec");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      const base = await rev(repo, "main");
      await landTopic(repo);
      await git(repo, "fetch", "-q", "origin", "main");
      await git(repo, "config", "--unset-all", "remote.origin.fetch");
      await git(
        repo,
        "config",
        "remote.origin.fetch",
        "+refs/heads/unrelated/*:refs/remotes/origin/unrelated/*",
      );
      const other = join(ws, "refspec-other");
      await git(ws, "clone", "-q", origin, other);
      await git(other, "push", "-q", "--force", "origin", `${base}:refs/heads/main`);
      const outcome = await retire(ws, { repo }, [
        "--repo-root",
        repo,
        "--branch",
        "topic",
        "--execute",
      ]);
      // Control: the tracking ref is still stale AFTER the script's own fetch.
      const trackingStillStale =
        (await rev(repo, "refs/remotes/origin/main")) !== (await rev(repo, "FETCH_HEAD"));
      const staleAllows = await gitStatus(
        repo,
        "merge-base",
        "--is-ancestor",
        "topic",
        "refs/remotes/origin/main",
      );
      expect({ trackingStillStale, staleAllows, ...outcome }).toEqual({
        trackingStillStale: true,
        staleAllows: 0,
        status: EXIT_REFUSED,
        stdout: lines(FETCH_STALE, "[branch] refs/heads/topic is at <sha3>"),
        stderr: differs("t.txt", "topic", "<sha3>"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "BROKEN: an unknown branch ref exits 3, distinctly from an honest refusal",
    async (ws) => {
      const { repo } = await buildRepo(ws, "unknown");
      // 1 means "asked and answered no", 3 means "never answered"; git's own
      // exit for an unknown ref is 128, which the script must not pass through.
      const gitUnknown = await gitStatus(
        repo,
        "merge-base",
        "--is-ancestor",
        "main",
        "refs/heads/nope",
      );
      expect({
        gitUnknown,
        ...(await retire(ws, { repo, branch: "main" }, [
          "--repo-root",
          repo,
          "--branch",
          "no-such-branch",
        ])),
      }).toEqual({
        gitUnknown: 128,
        status: EXIT_BROKEN,
        stdout: FETCH,
        stderr:
          "BROKEN: refs/heads/no-such-branch does not resolve to a commit: an unanswered question, not a passed gate",
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("ALLOW: a SQUASH-merged branch passes by content equivalence", async (ws) => {
    const { repo } = await buildRepo(ws, "squash");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await squashLandTopic(repo);
    // Unrelated mainline movement after the squash must not count against it.
    await commitOnMain(repo, "other.txt", "someone else\n");
    await git(repo, "push", "-q", "origin", "main");
    const ancestry = await gitStatus(repo, "merge-base", "--is-ancestor", "topic", "main");
    expect({
      ancestry,
      ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"])),
    }).toEqual({
      ancestry: 1,
      status: EXIT_OK,
      stdout: lines(FETCH, BRANCH, landedByContent(1), NO_TREE, HELD, DELETED, RETIRED),
      stderr: "",
      branch: "absent",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: a squash-merged branch with a further commit refuses and names the path",
    async (ws) => {
      const { repo } = await buildRepo(ws, "squashmore");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await squashLandTopic(repo);
      await commitOnBranch(repo, "topic", "t2.txt", "not landed\n");
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("t2.txt"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("ALLOW: a REBASE-merged branch passes by content equivalence", async (ws) => {
    const { repo } = await buildRepo(ws, "rebase");
    await commitOnMain(repo, "other.txt", "moved ahead\n");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await git(repo, "cherry-pick", "main..topic");
    await git(repo, "push", "-q", "origin", "main");
    const ancestry = await gitStatus(repo, "merge-base", "--is-ancestor", "topic", "main");
    expect({
      ancestry,
      ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"])),
    }).toEqual({
      ancestry: 1,
      status: EXIT_OK,
      stdout: lines(FETCH, BRANCH, landedByContent(1), NO_TREE, HELD, DELETED, RETIRED),
      stderr: "",
      branch: "absent",
      tree: "none",
    });
  });

  scenario("BROKEN: a content check whose diff command fails is exit 3", async (ws) => {
    const { repo } = await buildRepo(ws, "diffbroken");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await squashLandTopic(repo);
    const env = gitFailingShim(ws, "diffbroken", "--no-textconv");
    expect(
      await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], { env }),
    ).toEqual({
      status: EXIT_BROKEN,
      stdout: lines(FETCH, BRANCH),
      stderr: `BROKEN: ${notContained()}, and the content check could not run: git diff <sha3> <sha2>: shim: refusing --no-textconv`,
      branch: "unchanged",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: an unlanded branch whose commits net to NO delta is not judged landed",
    async (ws) => {
      // An empty delta is not equivalence: there is nothing to compare.
      const { repo } = await buildRepo(ws, "nodelta");
      const tree = join(ws, "nodelta-tree");
      await git(repo, "worktree", "add", "-q", tree, "topic");
      await git(tree, "commit", "-q", "--allow-empty", "-m", "empty");
      await git(repo, "worktree", "remove", "--force", tree);
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: `REFUSED: ${notContained()}, and there is no delta to judge by content`,
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: a gitlink that differs at the tip is judged even under diff.ignoreSubmodules=all",
    async (ws) => {
      // The branch bumps a submodule pointer and adds a file; both squash-land,
      // then the mainline moves the pointer back. With the config honoured the
      // gitlink difference would be hidden and the file alone would look landed.
      const { repo } = await buildRepo(ws, "gitlink");
      const first = "1111111111111111111111111111111111111111";
      const second = "2222222222222222222222222222222222222222";
      const tree = join(ws, "gitlink-tree");
      await git(repo, "worktree", "add", "-q", tree, "topic");
      await git(tree, "update-index", "--add", "--cacheinfo", `160000,${first},sub`);
      writeFileSync(join(tree, "t.txt"), "topic\n");
      await git(tree, "add", "t.txt");
      await git(tree, "commit", "-qm", "gitlink and file");
      await git(repo, "worktree", "remove", "--force", tree);
      await squashLandTopic(repo);
      await git(repo, "update-index", "--add", "--cacheinfo", `160000,${second},sub`);
      await git(repo, "commit", "-qm", "move the pointer back");
      await git(repo, "push", "-q", "origin", "main");
      await git(repo, "config", "diff.ignoreSubmodules", "all");
      const hiddenByConfig = (await git(repo, "diff", "--name-only", "main", "topic")).trim();
      expect({
        hiddenByConfig,
        ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"])),
      }).toEqual({
        hiddenByConfig: "",
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("sub"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: an unlanded file whose name is not valid UTF-8 is still judged by content",
    async (ws) => {
      // The name is built through `mktree -z` from raw bytes, since the
      // filesystem may refuse it; decoding it and passing it back to git as a
      // pathspec would name a path that does not exist and diff nothing.
      const { repo } = await buildRepo(ws, "rawname");
      const blob = (
        await gitBytes(repo, new TextEncoder().encode("unlanded\n"), "hash-object", "-w", "--stdin")
      )
        .toString("utf-8")
        .trim();
      const listing = await gitBytes(repo, undefined, "ls-tree", "-z", "main");
      const rawName = Buffer.concat([Buffer.from([0xff]), Buffer.from(".txt")]);
      const entries = Buffer.concat([
        listing,
        Buffer.from(`100644 blob ${blob}\t`),
        rawName,
        Buffer.from([0]),
      ]);
      const treeSha = (await gitBytes(repo, entries, "mktree", "-z")).toString("utf-8").trim();
      const commit = (
        await git(repo, "commit-tree", treeSha, "-p", "main", "-m", "raw-named file")
      ).trim();
      await git(repo, "update-ref", "refs/heads/topic", commit);
      const changed = await gitBytes(repo, undefined, "diff", "--name-only", "-z", "main", "topic");
      expect({
        rawByteInDiff: changed.includes(0xff),
        ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"])),
      }).toEqual({
        rawByteInDiff: true,
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        // The refusal prints the name decoded, so the invalid byte shows as U+FFFD.
        stderr: differs("\uFFFD.txt"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "BROKEN: a SHALLOW repository can never produce an honest not-contained refusal",
    async (ws) => {
      const { repo, origin } = await buildRepo(ws, "shallow");
      await commitOnBranch(repo, "topic", "t.txt", "unlanded\n");
      await git(repo, "push", "-q", "origin", "topic");
      const clone = join(ws, "shallow-clone");
      await git(ws, "clone", "-q", "--depth", "1", "--no-single-branch", `file://${origin}`, clone);
      await git(clone, "checkout", "-q", "-b", "topic", "origin/topic");
      await git(clone, "checkout", "-q", "main");
      const shallow = (await git(clone, "rev-parse", "--is-shallow-repository")).trim();
      expect({
        shallow,
        ...(await retire(ws, { repo: clone }, [
          "--repo-root",
          clone,
          "--branch",
          "topic",
          "--execute",
        ])),
      }).toEqual({
        shallow: "true",
        status: EXIT_BROKEN,
        stdout: lines(FETCH, BRANCH),
        stderr:
          "BROKEN: topic looks unlanded, but this is a SHALLOW repository: fetch --unshallow first",
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("BROKEN: an unreadable shallow flag is not read as 'not shallow'", async (ws) => {
    const { repo } = await buildRepo(ws, "shallowbroken");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await landTopic(repo);
    const env = gitFailingShim(ws, "shallowbroken", "--is-shallow-repository");
    expect(
      await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], { env }),
    ).toEqual({
      status: EXIT_BROKEN,
      stdout: "",
      stderr:
        "BROKEN: git rev-parse --is-shallow-repository failed (exit 1): shim: refusing --is-shallow-repository",
      branch: "unchanged",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: a pre-rebase original tip that is not contained is judged by content and refused when it differs",
    async (ws) => {
      const { repo } = await buildRepo(ws, "rebased");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      // An abandoned pre-rebase tip: a commit on no branch the mainline holds.
      const origTree = join(ws, "orig-tree");
      await git(repo, "worktree", "add", "-q", origTree, "-b", "orig", "main");
      writeFileSync(join(origTree, "orig.txt"), "pre-rebase\n");
      await git(origTree, "add", "-A");
      await git(origTree, "commit", "-qm", "pre-rebase work");
      const originalTip = await rev(origTree, "HEAD");
      await git(repo, "worktree", "remove", "--force", origTree);
      await landTopic(repo);
      expect(
        await retire(ws, { repo }, [
          "--repo-root",
          repo,
          "--branch",
          "topic",
          "--original-tip",
          originalTip,
          "--execute",
        ]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: differs("orig.txt", "the pre-rebase tip", "<sha3>"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: a mainline rewritten while the gates ran invalidates the passed gate",
    async (ws) => {
      const { repo, origin } = await buildRepo(ws, "moved");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      const base = await rev(repo, "main");
      await landTopic(repo);
      const other = join(ws, "moved-other");
      await git(ws, "clone", "-q", origin, other);
      // The rewrite lands after the landing gate passed and before the
      // pre-destruction re-fetch.
      const env = afterGates(
        ws,
        "moved",
        1,
        `"${REAL_GIT}" -C "${other}" push -q --force origin ${base}:refs/heads/main`,
      );
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, MOVED),
        stderr: differs("t.txt", RECHECKED, "<sha2>", "<sha3>"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: a mainline rewritten while the gates ran is refused BEFORE the worktree is removed",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "orderly");
      const base = await rev(repo, "main~1");
      const other = join(ws, "orderly-other");
      await git(ws, "clone", "-q", (await git(repo, "remote", "get-url", "origin")).trim(), other);
      // The rewrite lands after the first worktree judgement. The re-fetch that
      // catches it must run before the removal, or the refusal arrives over a
      // worktree that is already gone.
      const env = afterGates(
        ws,
        "orderly",
        1,
        `"${REAL_GIT}" -C "${other}" push -q --force origin ${base}:refs/heads/main`,
      );
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, clean("<ws>/orderly-tree"), MOVED),
        stderr: differs("t.txt", RECHECKED, "<sha2>", "<sha3>"),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario("REFUSE: the re-check covers the PRE-REBASE tip, not only the branch", async (ws) => {
    // A rewrite while the gates ran keeps the rebased commits while dropping
    // the separately-required original tip.
    const { repo, origin } = await buildRepo(ws, "recheckorig");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await commitOnMain(repo, "orig.txt", "pre-rebase\n");
    const originalTip = await rev(repo, "main");
    const beforeOriginal = await rev(repo, "main~1");
    await landTopic(repo);
    await git(repo, "push", "-q", "origin", "topic");
    const other = join(ws, "recheckorig-other");
    await git(ws, "clone", "-q", origin, other);
    await git(other, "checkout", "-q", "-B", "rewritten", beforeOriginal);
    await git(other, "merge", "-q", "--no-ff", "-m", "re-land topic", "origin/topic");
    const env = afterGates(
      ws,
      "recheckorig",
      1,
      `"${REAL_GIT}" -C "${other}" push -q --force origin rewritten:refs/heads/main`,
    );
    expect(
      await retire(
        ws,
        { repo },
        ["--repo-root", repo, "--branch", "topic", "--original-tip", originalTip, "--execute"],
        { env },
      ),
    ).toEqual({
      status: EXIT_REFUSED,
      stdout: lines(
        FETCH,
        BRANCH,
        LANDED,
        "[landed] by ancestry: the pre-rebase tip is contained in <sha1>",
        NO_TREE,
        MOVED,
        `[recheck] by ancestry: ${RECHECKED} is contained in <sha3>`,
      ),
      stderr: differs(
        "orig.txt",
        "the pre-rebase tip (re-checked: origin/main moved <sha1> -> <sha3> while the gates ran)",
        "<sha4>",
        "<sha3>",
      ),
      branch: "unchanged",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: a rename whose deletion half did not land is judged as two paths",
    async (ws) => {
      // Rename detection would report only the destination, so the surviving
      // source file on the mainline would never be compared.
      const { repo } = await buildRepo(ws, "rename");
      const tree = join(ws, "rename-tree");
      await git(repo, "worktree", "add", "-q", tree, "topic");
      await git(tree, "mv", "base.txt", "renamed.txt");
      await git(tree, "commit", "-qm", "rename");
      await git(repo, "worktree", "remove", "--force", tree);
      writeFileSync(join(repo, "renamed.txt"), "base\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-qm", "the add half only");
      await git(repo, "push", "-q", "origin", "main");
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("base.txt"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("REFUSE: a mode-only difference at the tip is judged", async (ws) => {
    const { repo } = await buildRepo(ws, "mode");
    const tree = join(ws, "mode-tree");
    await git(repo, "worktree", "add", "-q", tree, "topic");
    await git(tree, "update-index", "--chmod=+x", "base.txt");
    await git(tree, "commit", "-qm", "make executable");
    await git(repo, "worktree", "remove", "--force", tree);
    await squashLandTopic(repo);
    await git(repo, "update-index", "--chmod=-x", "base.txt");
    await git(repo, "commit", "-qm", "mode back");
    await git(repo, "push", "-q", "origin", "main");
    expect(
      await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
    ).toEqual({
      status: EXIT_REFUSED,
      stdout: lines(FETCH, BRANCH),
      stderr: differs("base.txt"),
      branch: "unchanged",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: diff.relative from a nested --repo-root cannot hide an unlanded path",
    async (ws) => {
      const { repo } = await buildRepo(ws, "relative");
      const tree = join(ws, "relative-tree");
      await git(repo, "worktree", "add", "-q", tree, "topic");
      mkdirSync(join(tree, "sub"));
      writeFileSync(join(tree, "sub", "in.txt"), "inside\n");
      writeFileSync(join(tree, "out.txt"), "outside\n");
      await git(tree, "add", "-A");
      await git(tree, "commit", "-qm", "inside and outside");
      await git(repo, "worktree", "remove", "--force", tree);
      await squashLandTopic(repo);
      await commitOnBranch(repo, "topic", "out.txt", "changed again, not landed\n");
      await git(repo, "config", "diff.relative", "true");
      expect(
        await retire(ws, { repo }, [
          "--repo-root",
          join(repo, "sub"),
          "--branch",
          "topic",
          "--execute",
        ]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("out.txt"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("SAFETY: a GIT_DIR inherited from a hook cannot retarget the run", async (ws) => {
    const { repo } = await buildRepo(ws, "gitdir");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await landTopic(repo);
    const decoy = await buildRepo(ws, "gitdir-decoy");
    expect({
      ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
        env: { GIT_DIR: join(decoy.repo, ".git"), GIT_WORK_TREE: decoy.repo },
      })),
      decoyTopic: await tip(decoy.repo, "topic"),
    }).toEqual({
      status: EXIT_OK,
      stdout: ALLOW_NO_TREE,
      stderr: "",
      branch: "absent",
      tree: "none",
      decoyTopic: await rev(decoy.repo, "main"),
    });
  });

  scenario("BROKEN: a private-ref clear that FAILS stops the fetch", async (ws) => {
    const { repo } = await buildRepo(ws, "clearfail");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await landTopic(repo);
    const env = gitFailingShim(ws, "clearfail", "update-ref -d --no-deref refs/retire-branch/");
    expect(
      await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], { env }),
    ).toEqual({
      status: EXIT_BROKEN,
      stdout: "",
      // The teardown's own drop fails under the same shim, and says so first.
      stderr: lines(
        "note: refs/retire-branch/<pid>/mainline was left behind in <ws>/clearfail",
        "BROKEN: refs/retire-branch/<pid>/mainline could not be cleared before fetching: shim: refusing update-ref -d --no-deref refs/retire-branch/",
      ),
      branch: "unchanged",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: a concurrent fetch that rewrites FETCH_HEAD cannot supply the reference",
    async (ws) => {
      // Right after the run's own fetch, another fetch in the same worktree
      // points FETCH_HEAD at the unlanded topic itself.
      const { repo } = await buildRepo(ws, "fetchhead");
      await commitOnBranch(repo, "topic", "t.txt", "unlanded\n");
      await git(repo, "push", "-q", "origin", "topic");
      const env = gitShim(
        ws,
        "fetchhead",
        `  *fetch*refs/retire-branch/*) "${REAL_GIT}" "$@"; rc=$?; "${REAL_GIT}" -C "${repo}" fetch -q origin refs/heads/topic; exit $rc ;;`,
      );
      const outcome = await retire(
        ws,
        { repo },
        ["--repo-root", repo, "--branch", "topic", "--execute"],
        { env },
      );
      expect({
        fetchHeadIsTopic: (await rev(repo, "FETCH_HEAD")) === (await rev(repo, "topic")),
        ...outcome,
      }).toEqual({
        fetchHeadIsTopic: true,
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("t.txt"),
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("HYGIENE: the private fetch ref is dropped on success AND on refusal", async (ws) => {
    const { repo } = await buildRepo(ws, "privateref");
    await commitOnBranch(repo, "topic", "t.txt", "unlanded\n");
    const refused = await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic"]);
    const afterRefusal = await privateRefs(repo);
    await landTopic(repo);
    const ok = await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"]);
    expect({ refused, afterRefusal, ok, afterSuccess: await privateRefs(repo) }).toEqual({
      refused: {
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH),
        stderr: differs("t.txt"),
        branch: "unchanged",
        tree: "none",
      },
      afterRefusal: "",
      ok: { status: EXIT_OK, stdout: ALLOW_NO_TREE, stderr: "", branch: "absent", tree: "none" },
      afterSuccess: "",
    });
  });
});

describe("retire-branch.mts worktree gates", () => {
  scenario("REFUSE: a DIRTY worktree blocks the removal and the deletion", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "dirty");
    writeFileSync(join(tree, "scratch.txt"), "unsaved work\n");
    expect(
      await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
    ).toEqual({
      status: EXIT_REFUSED,
      stdout: lines(FETCH, BRANCH, LANDED),
      stderr: holdsWork("<ws>/dirty-tree", ["1 uncommitted change(s): ?? scratch.txt"]),
      branch: "unchanged",
      tree: "present",
    });
  });

  scenario(
    "REFUSE: an in-progress merge is named even though the tree is also dirty",
    async (ws) => {
      const { repo } = await buildRepo(ws, "inprogress");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await commitOnMain(repo, "other.txt", "other\n");
      await landTopic(repo);
      const tree = join(ws, "inprogress-tree");
      await git(repo, "worktree", "add", "-q", tree, "topic");
      await gitStatus(tree, "merge", "--no-commit", "--no-ff", "main");
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: holdsWork("<ws>/inprogress-tree", [
          "1 uncommitted change(s): A  other.txt",
          "an operation is in progress (MERGE_HEAD present)",
        ]),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario("REFUSE: a LOCKED worktree is never removed", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "locked");
    await git(repo, "worktree", "lock", "--reason", "on a USB stick", tree);
    expect(
      await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
    ).toEqual({
      status: EXIT_REFUSED,
      stdout: lines(FETCH, BRANCH, LANDED),
      stderr: holdsWork("<ws>/locked-tree", ["the worktree is locked: on a USB stick"]),
      branch: "unchanged",
      tree: "present",
    });
  });

  scenario(
    "REFUSE: a stash on the branch blocks it, even though the worktree reads CLEAN",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "stash");
      writeFileSync(join(tree, "t.txt"), "work in progress\n");
      await git(tree, "stash", "push", "-q", "-m", "wip");
      const cleanTree = (await git(tree, "status", "--porcelain", "-uall")).trim() === "";
      expect({
        cleanTree,
        ...(await retire(ws, { repo, tree }, [
          "--repo-root",
          repo,
          "--branch",
          "topic",
          "--execute",
        ])),
      }).toEqual({
        cleanTree: true,
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: holdsWork("<ws>/stash-tree", [
          "a stash belongs to this branch: stash@{0}: On topic: wip",
        ]),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario("REFUSE: a live process with its cwd in the worktree blocks the removal", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "writer");
    // Killed by the pid captured at spawn, bounded, and self-terminating besides.
    const parked = Bun.spawn(["sleep", "30"], {
      cwd: tree,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    try {
      await Bun.sleep(500);
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: holdsWork("<ws>/writer-tree", [
          "a live process has its cwd inside the worktree: pid <pid> (sleep) cwd <ws>/writer-tree",
        ]),
        branch: "unchanged",
        tree: "present",
      });
    } finally {
      parked.kill("SIGKILL");
    }
  });

  scenario(
    "REFUSE: the branch checked out in the MAIN worktree is never deleted underneath it",
    async (ws) => {
      const { repo } = await buildRepo(ws, "mainwt");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      await git(repo, "checkout", "-q", "topic");
      expect(
        await retire(ws, { repo, tree: repo }, [
          "--repo-root",
          repo,
          "--branch",
          "topic",
          "--execute",
        ]),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: holdsWork("<ws>/mainwt", [
          "refs/heads/topic is checked out in the MAIN worktree; switch it to another branch first",
        ]),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario("REHEARSE: without --execute every gate runs and nothing is destroyed", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "rehearse");
    expect(await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic"])).toEqual({
      status: EXIT_OK,
      stdout: lines(
        FETCH,
        BRANCH,
        LANDED,
        clean("<ws>/rehearse-tree"),
        "[worktree] would remove <ws>/rehearse-tree (add --execute)",
        WOULD_DELETE,
        REHEARSED,
      ),
      stderr: "",
      branch: "unchanged",
      tree: "present",
    });
  });

  scenario(
    "REFUSE: a push landing between the gate and the deletion loses the lease",
    async (ws) => {
      const { repo } = await buildRepo(ws, "lease");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      const moved = await rev(repo, "main");
      // The branch moves after the landing gate judged it: the sha the gate saw
      // is no longer the sha the ref holds.
      const env = afterGates(
        ws,
        "lease",
        1,
        `"${REAL_GIT}" -C "${repo}" update-ref refs/heads/topic ${moved}`,
      );
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, HELD),
        stderr:
          "REFUSED: refs/heads/topic was not deleted: it is no longer at the verified <sha2> (now <sha1>). Something landed between the gate and the deletion; re-run.",
        branch: "moved",
        tree: "none",
      });
    },
  );

  scenario("BROKEN: an lsof that answers nothing is exit 3, never an all-clear", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "lsofbroken");
    // Exit 0 with no output: a shape a real lsof cannot produce.
    const env = onPath(shimDir(ws, "lsofbroken", "lsof", "exit 0"));
    const args = ["--repo-root", repo, "--branch", "topic", "--execute"];
    const probed = await retire(ws, { repo, tree }, args, { env });
    // The documented way past it trades the evidence for an explicit decision.
    const waived = await retire(ws, { repo, tree }, [...args, "--no-writer-check"], { env });
    expect({ probed, waived }).toEqual({
      probed: {
        status: EXIT_BROKEN,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: probeBroken(
          "<ws>/lsofbroken-tree",
          "lsof returned zero cwd records: broken probe, not a quiet host",
        ),
        branch: "unchanged",
        tree: "present",
      },
      waived: {
        status: EXIT_OK,
        stdout: lines(
          FETCH,
          BRANCH,
          LANDED,
          SKIPPED,
          clean("<ws>/lsofbroken-tree"),
          HELD,
          removed("<ws>/lsofbroken-tree"),
          DELETED,
          RETIRED,
        ),
        stderr: "",
        branch: "absent",
        tree: "absent",
      },
    });
  });

  scenario(
    "BROKEN: a PARTIAL lsof scan (non-zero exit with output) is not an all-clear",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "lsofpartial");
      const env = onPath(
        shimDir(ws, "lsofpartial", "lsof", 'printf "p1\\ncsh\\nn/tmp\\n"\nexit 1'),
      );
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_BROKEN,
        stdout: lines(FETCH, BRANCH, LANDED),
        stderr: probeBroken(
          "<ws>/lsofpartial-tree",
          "lsof exited 1: a partial scan is not an all-clear",
        ),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario(
    "REFUSE: two worktrees holding one branch are never retired under each other",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "twowt");
      const second = join(ws, "twowt-b");
      await git(repo, "worktree", "add", "-q", "--force", second, "topic");
      expect({
        ...(await retire(ws, { repo, tree }, [
          "--repo-root",
          repo,
          "--branch",
          "topic",
          "--execute",
        ])),
        second: existsSync(second),
      }).toEqual({
        status: EXIT_REFUSED,
        stdout: "",
        stderr:
          "REFUSED: refs/heads/topic is checked out in 2 worktrees at once; release all but one first",
        branch: "unchanged",
        tree: "present",
        second: true,
      });
    },
  );

  scenario("BROKEN: a stash list that failed to be read is not an empty stash list", async (ws) => {
    const { repo } = await buildRepo(ws, "stashbroken");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await landTopic(repo);
    const env = gitFailingShim(ws, "stashbroken", "stash list");
    expect(
      await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], { env }),
    ).toEqual({
      status: EXIT_BROKEN,
      stdout: lines(FETCH, BRANCH, LANDED, NO_TREE),
      stderr:
        "BROKEN: git stash list failed: shim: refusing stash list - a stash list that failed to be read is not an empty stash list",
      branch: "unchanged",
      tree: "none",
    });
  });

  scenario("REFUSE: a stash survives a branch RENAME, caught by the at-tip signal", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "stashrename");
    writeFileSync(join(tree, "t.txt"), "work in progress\n");
    await git(tree, "stash", "push", "-q", "-m", "wip");
    // The reflog subject still says "On topic"; name matching alone goes blind.
    await git(repo, "branch", "-m", "topic", "renamed");
    expect(
      await retire(ws, { repo, branch: "renamed", tree }, [
        "--repo-root",
        repo,
        "--branch",
        "renamed",
        "--execute",
      ]),
    ).toEqual({
      status: EXIT_REFUSED,
      stdout: lines(
        FETCH,
        "[branch] refs/heads/renamed is at <sha2>",
        "[landed] by ancestry: renamed is contained in <sha1>",
      ),
      stderr: holdsWork("<ws>/stashrename-tree", [
        "a stash belongs to this branch: stash@{0}: On topic: wip",
      ]),
      branch: "unchanged",
      tree: "present",
    });
  });

  scenario(
    "BROKEN: a deletion that fails with the ref UNCHANGED is not a lost lease",
    async (ws) => {
      const { repo } = await buildRepo(ws, "delbroken");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      const env = gitFailingShim(ws, "delbroken", "-d --no-deref --end-of-options");
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_BROKEN,
        stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, HELD),
        stderr:
          "BROKEN: refs/heads/topic is still at the verified <sha2> but the deletion failed: shim: refusing -d --no-deref --end-of-options. The lease held; the write did not.",
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario(
    "SAFETY: shell metacharacters in a printed command are quoted, and branch names are not interpolated at all",
    async (ws) => {
      const { repo } = await buildRepo(ws, "metachar");
      const hostile = "wip/a;b$(id)";
      await git(repo, "branch", hostile, "main");
      const tree = join(ws, "meta ;dir$(id)");
      await git(repo, "worktree", "add", "-q", tree, hostile);
      writeFileSync(join(tree, ".gitignore"), "junk/\n");
      await git(tree, "add", "-A");
      await git(tree, "commit", "-qm", "ignore junk");
      mkdirSync(join(tree, "junk"), { recursive: true });
      writeFileSync(join(tree, "junk", "artifact.bin"), "build output\n");
      await landTopicNamed(repo, hostile);
      const rehearsed = await retire(ws, { repo, branch: hostile, tree }, [
        "--repo-root",
        repo,
        "--branch",
        hostile,
      ]);
      // A refusal names the branch as a label only; the printed transcript shows
      // that no command line carries the raw name where a paste would run it.
      const { repo: repo2 } = await buildRepo(ws, "metachar2");
      await git(repo2, "branch", hostile, "main");
      await commitOnBranch(repo2, hostile, "u.txt", "unlanded\n");
      const refused = await retire(ws, { repo: repo2, branch: hostile }, [
        "--repo-root",
        repo2,
        "--branch",
        hostile,
      ]);
      expect({ rehearsed, refused }).toEqual({
        rehearsed: {
          status: EXIT_OK,
          stdout: lines(
            FETCH,
            "[branch] refs/heads/wip/a;b$(id) is at <sha2>",
            "[landed] by ancestry: wip/a;b$(id) is contained in <sha1>",
            "[worktree] 1 ignored file(s) will be destroyed with the tree (list them with: git -C '<ws>/meta ;dir$(id)' status --porcelain -uall --ignored)",
            clean("<ws>/meta ;dir$(id)"),
            "[worktree] would remove <ws>/meta ;dir$(id) (add --execute)",
            "[delete] would delete refs/heads/wip/a;b$(id) at <sha2> (add --execute)",
            "REHEARSED: every gate passed for wip/a;b$(id); nothing was destroyed",
          ),
          stderr: "",
          branch: "unchanged",
          tree: "present",
        },
        refused: {
          status: EXIT_REFUSED,
          stdout: lines(FETCH, "[branch] refs/heads/wip/a;b$(id) is at <sha2>"),
          stderr: differs("u.txt", hostile),
          branch: "unchanged",
          tree: "none",
        },
      });
    },
  );

  scenario(
    "BROKEN: a bare repository is refused, not measured as if it had a worktree",
    async (ws) => {
      const { origin } = await buildRepo(ws, "bare");
      // `rev-parse --is-inside-work-tree` prints "false" and exits ZERO here.
      expect(
        await retire(ws, { repo: origin, branch: "main" }, [
          "--repo-root",
          origin,
          "--branch",
          "topic",
        ]),
      ).toEqual({
        status: EXIT_BROKEN,
        stdout: "",
        stderr: "BROKEN: <ws>/bare-origin.git is a bare repository; a working tree is needed",
        branch: "unchanged",
        tree: "none",
      });
    },
  );

  scenario("SAFETY: the script runs from an install path containing a space", async (ws) => {
    const spacedDir = join(ws, "dir with space");
    mkdirSync(spacedDir, { recursive: true });
    const copy = join(spacedDir, "retire-branch.mts");
    writeFileSync(copy, readFileSync(SCRIPT, "utf-8"));
    const { repo } = await buildRepo(ws, "spaced");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await landTopic(repo);
    expect(
      await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
        script: copy,
      }),
    ).toEqual({
      status: EXIT_OK,
      stdout: ALLOW_NO_TREE,
      stderr: "",
      branch: "absent",
      tree: "none",
    });
  });

  scenario(
    "REFUSE: a SYMBOLIC branch ref is never deleted, because that deletes its target",
    async (ws) => {
      const { repo } = await buildRepo(ws, "symref");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      await git(repo, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
      const mainBefore = await rev(repo, "main");
      expect({
        ...(await retire(ws, { repo, branch: "alias" }, [
          "--repo-root",
          repo,
          "--branch",
          "alias",
          "--execute",
        ])),
        main: await tip(repo, "main"),
      }).toEqual({
        status: EXIT_REFUSED,
        stdout: FETCH,
        stderr:
          "REFUSED: refs/heads/alias is a SYMBOLIC ref -> refs/heads/main; deleting it would delete that target. Resolve the symbolic ref before retrying.",
        branch: "unchanged",
        tree: "none",
        main: mainBefore,
      });
    },
  );

  scenario("ALLOW: running from INSIDE the worktree being retired still completes", async (ws) => {
    const { repo, tree } = await landedWithTree(ws, "insidewt");
    // --repo-root AND cwd are the worktree about to be removed: the real shape
    // of "I am standing in the branch I am retiring".
    expect({
      ...(await retire(
        ws,
        { repo, tree },
        ["--repo-root", tree, "--branch", "topic", "--execute"],
        {
          cwd: tree,
        },
      )),
      leftover: await privateRefs(repo),
    }).toEqual({
      status: EXIT_OK,
      stdout: lines(
        "[anchor] --repo-root is inside the worktree being retired; the removal and the deletion run from <ws>/insidewt",
        allowWithTree("<ws>/insidewt-tree"),
      ),
      stderr: "",
      branch: "absent",
      tree: "absent",
      leftover: "",
    });
  });

  scenario(
    "BROKEN: a postcondition that cannot be READ is never reported as LANDED",
    async (ws) => {
      const { repo } = await buildRepo(ws, "postcond");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      const marker = join(ws, "postcond-deleted");
      const env = gitShim(
        ws,
        "postcond",
        `  *"update-ref"*"refs/heads/topic"*) : > "${marker}" ;;`,
        `  *rev-parse*refs/heads/topic*) if [ -f "${marker}" ]; then echo "shim: cannot read the ref" >&2; exit 128; fi ;;`,
      );
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_BROKEN,
        stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, HELD),
        stderr:
          "BROKEN: update-ref reported success but refs/heads/topic could not be re-read to confirm it (rev-parse refs/heads/topic exited 128: shim: cannot read the ref)",
        branch: "absent",
        tree: "none",
      });
    },
  );

  scenario("BROKEN: a DANGLING symref left behind is not the absence of a branch", async (ws) => {
    const { repo } = await buildRepo(ws, "dangling");
    await commitOnBranch(repo, "topic", "t.txt", "topic\n");
    await landTopic(repo);
    // show-ref and rev-parse answer for this exactly as for a missing ref.
    const env = gitShim(
      ws,
      "dangling",
      `  *"update-ref"*"refs/heads/topic"*) "${REAL_GIT}" -C "${repo}" symbolic-ref refs/heads/topic refs/heads/ghost; exit 0 ;;`,
    );
    expect({
      ...(await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
        env,
      })),
      symref: (await git(repo, "symbolic-ref", "refs/heads/topic")).trim(),
    }).toEqual({
      status: EXIT_BROKEN,
      stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, HELD),
      stderr:
        "BROKEN: update-ref reported success but refs/heads/topic could not be re-read to confirm it (refs/heads/topic is a dangling symbolic ref -> refs/heads/ghost)",
      branch: "moved",
      tree: "none",
      symref: "refs/heads/ghost",
    });
  });

  scenario(
    "BROKEN: an unreadable symbolic-ref probe is not the absence of a branch",
    async (ws) => {
      const { repo } = await buildRepo(ws, "symrefbroken");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      const marker = join(ws, "symrefbroken-deleted");
      const env = gitShim(
        ws,
        "symrefbroken",
        `  *"-d --no-deref --end-of-options"*) : > "${marker}" ;;`,
        `  *"symbolic-ref"*"refs/heads/topic"*) if [ -f "${marker}" ]; then echo "shim: symbolic-ref failed" >&2; exit 128; fi ;;`,
      );
      expect(
        await retire(ws, { repo }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_BROKEN,
        stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, HELD),
        stderr:
          "BROKEN: update-ref reported success but refs/heads/topic could not be re-read to confirm it (symbolic-ref could not say whether refs/heads/topic exists: shim: symbolic-ref failed)",
        branch: "absent",
        tree: "none",
      });
    },
  );

  scenario(
    "REFUSE: a branch that ACQUIRES a worktree while the gates run is not deleted",
    async (ws) => {
      const { repo } = await buildRepo(ws, "acquired");
      await commitOnBranch(repo, "topic", "t.txt", "topic\n");
      await landTopic(repo);
      const stolen = join(ws, "acquired-tree");
      // The holder set is read at the top of the run; the sha lease says nothing
      // about worktree ownership.
      const env = afterGates(
        ws,
        "acquired",
        1,
        `"${REAL_GIT}" -C "${repo}" worktree add -q --force "${stolen}" topic >/dev/null 2>&1`,
      );
      expect(
        await retire(
          ws,
          { repo, tree: stolen },
          ["--repo-root", repo, "--branch", "topic", "--execute"],
          { env },
        ),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, NO_TREE, HELD),
        stderr:
          "REFUSED: refs/heads/topic acquired a worktree while the gates ran (<ws>/acquired-tree)",
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario(
    "REFUSE: a worktree that SWITCHES branches while the gates run is not removed",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "switched");
      await git(repo, "branch", "other", "main");
      // The first capture said this tree holds `topic`; it is then repurposed
      // before the pre-destruction re-capture.
      const env = duringRefetch(
        ws,
        "switched",
        `"${REAL_GIT}" -C "${tree}" checkout -q other 2>/dev/null`,
      );
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, clean("<ws>/switched-tree"), HELD),
        stderr:
          "REFUSED: <ws>/switched-tree no longer holds refs/heads/topic on its own (now held by: nobody)",
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario(
    "REFUSE: a process that ENTERS the worktree while the gates run blocks the removal",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "entered");
      // The arrival happens on the second fetch (the pre-removal re-fetch), after
      // the first capture. The >/dev/null 2>&1 is load-bearing: a backgrounded
      // child inheriting the shim's pipes would block the fetch for the whole sleep.
      const env = duringRefetch(
        ws,
        "entered",
        `( cd "${tree}" && exec sleep 20 ) >/dev/null 2>&1 & sleep 1`,
      );
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, clean("<ws>/entered-tree"), HELD),
        stderr: holdsWork(
          "<ws>/entered-tree",
          [
            "a live process has its cwd inside the worktree while the gates ran: pid <pid> (sleep) cwd <ws>/entered-tree",
          ],
          " while the gates ran",
        ),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  scenario(
    "ALLOW: a real parent SHELL sitting in the worktree does not block its retirement",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "parentshell");
      // A SHELL whose cwd is the worktree stays alive as the script's parent:
      // the process lsof actually reports in a real terminal.
      const result = await spawnText(
        [
          "sh",
          "-c",
          `cd ${JSON.stringify(tree)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --repo-root ${JSON.stringify(tree)} --branch topic --execute`,
        ],
        { timeoutMs: 120_000 },
      );
      const numbered = new Map<string, string>();
      expect({
        status: result.status,
        stdout: normalize(result.stdout, ws, numbered).replace(
          /\((sh|bash|zsh|dash)\)/,
          "(<shell>)",
        ),
        stderr: normalize(result.stderr, ws, numbered),
        branch: await tip(repo, "topic"),
        tree: existsSync(tree),
      }).toEqual({
        status: EXIT_OK,
        stdout: lines(
          "[anchor] --repo-root is inside the worktree being retired; the removal and the deletion run from <ws>/parentshell",
          FETCH,
          BRANCH,
          LANDED,
          "[worktree] your own shell is inside this worktree (pid <pid> (<shell>) cwd <ws>/parentshell-tree); cd out afterwards",
          clean("<ws>/parentshell-tree"),
          HELD,
          removed("<ws>/parentshell-tree"),
          DELETED,
          RETIRED,
        ),
        stderr: "",
        branch: "absent",
        tree: false,
      });
    },
  );

  scenario(
    "REFUSE: a worktree that COMMITS while the gates run is not removed on an expired reading",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "committed");
      // Without the tip re-check the tree is removed and the pinned deletion
      // then refuses: a run that ends in a refusal having destroyed something.
      // The commit is built here and only the ref moves inside the shim: the
      // script strips GIT_* from its children, so a commit made by the shim
      // would need the host's global identity and fail on a bare runner.
      const late = (
        await git(repo, "commit-tree", "topic^{tree}", "-p", "topic", "-m", "late work")
      ).trim();
      const env = duringRefetch(
        ws,
        "committed",
        `"${REAL_GIT}" -C "${tree}" update-ref refs/heads/topic ${late}`,
      );
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, clean("<ws>/committed-tree"), HELD),
        stderr:
          "REFUSED: <ws>/committed-tree committed while the gates ran (refs/heads/topic is now at <sha3>, verified at <sha2>)",
        branch: "moved",
        tree: "present",
      });
    },
  );

  scenario(
    "REFUSE: work appearing DURING the final fetch is caught by the re-capture",
    async (ws) => {
      const { repo, tree } = await landedWithTree(ws, "latework");
      // A file written during the pre-removal fetch leaves a tree that still
      // holds the right branch at the right tip with no live writer.
      const env = duringRefetch(ws, "latework", `echo late > "${tree}/unsaved.txt"`);
      expect(
        await retire(ws, { repo, tree }, ["--repo-root", repo, "--branch", "topic", "--execute"], {
          env,
        }),
      ).toEqual({
        status: EXIT_REFUSED,
        stdout: lines(FETCH, BRANCH, LANDED, clean("<ws>/latework-tree"), HELD),
        stderr: holdsWork(
          "<ws>/latework-tree",
          ["1 uncommitted change(s): ?? unsaved.txt"],
          " while the gates ran",
        ),
        branch: "unchanged",
        tree: "present",
      });
    },
  );

  // The same mid-probe move, with and without the writer waiver: the flag waives
  // one probe, never the closing tip re-read.
  const midProbeMoves: Array<{ id: string; extra: string[]; stdout: (tree: string) => string }> = [
    {
      id: "with the writer probe",
      extra: [],
      stdout: (tree) => lines(FETCH, BRANCH, LANDED, clean(tree), HELD),
    },
    {
      id: "under --no-writer-check",
      extra: ["--no-writer-check"],
      stdout: (tree) => lines(FETCH, BRANCH, LANDED, SKIPPED, clean(tree), HELD),
    },
  ];
  for (const row of midProbeMoves) {
    scenario(
      `REFUSE: a branch that moves DURING the final probes is caught by the last tip re-read: ${row.id}`,
      async (ws) => {
        const name = row.extra.length === 0 ? "movedmid" : "waiver";
        const { repo, tree } = await landedWithTree(ws, name);
        const elsewhere = await rev(repo, "main");
        // `stash list` runs once per worktree judgement; the second is inside the
        // final one, after that pass's opening tip check.
        const env = afterGates(
          ws,
          name,
          2,
          `"${REAL_GIT}" -C "${repo}" update-ref refs/heads/topic ${elsewhere}`,
        );
        expect(
          await retire(
            ws,
            { repo, tree },
            ["--repo-root", repo, "--branch", "topic", ...row.extra, "--execute"],
            { env },
          ),
          row.id,
        ).toEqual({
          status: EXIT_REFUSED,
          stdout: row.stdout(`<ws>/${name}-tree`),
          stderr:
            "REFUSED: refs/heads/topic moved to <sha1> while the final checks ran (verified at <sha2>)",
          branch: "moved",
          tree: "present",
        });
      },
    );
  }
});

describe("retire-branch.mts usage", () => {
  const usageCases: Array<{ id: string; args: string[]; reason: string }> = [
    { id: "a flag without a value", args: ["--branch"], reason: "--branch needs a value" },
    {
      id: "a value that is really the next flag",
      args: ["--branch", "--execute"],
      reason: "--branch needs a value",
    },
    { id: "no branch at all", args: ["--execute"], reason: "--branch is required" },
    {
      id: "an unknown option",
      args: ["--branch", "topic", "--nope"],
      reason: "unknown option: --nope",
    },
    {
      id: "branch and mainline naming the same ref",
      args: ["--branch", "main", "--mainline", "main", "--execute"],
      reason:
        "--branch and --mainline are both 'main'; that would judge the mainline against itself and then delete it",
    },
  ];
  for (const row of usageCases) {
    scenario(`USAGE: ${row.id}`, async (ws) => {
      const { repo } = await buildRepo(ws, "usage");
      expect(
        await retire(ws, { repo, branch: "main" }, ["--repo-root", repo, ...row.args]),
        row.id,
      ).toEqual({
        status: EXIT_USAGE,
        stdout: "",
        stderr: `${row.reason}\n\n${USAGE}`,
        branch: "unchanged",
        tree: "none",
      });
    });
  }
});

describe("retire-branch.mts process discipline", () => {
  const source = readFileSync(SCRIPT, "utf-8");
  // Whole-line comments are dropped first: the script explains the `jobs -p`
  // trap in prose, and a guard that fired on its own explanation would have to
  // be weakened to pass.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  test("never asks a shell which jobs are running", () => {
    // `jobs -p` is empty in a non-interactive shell, so a cleanup loop built on
    // it kills nothing while reporting success.
    expect({
      jobsLookup: /\bjobs\s+-p\b/.test(code),
      entry: code.includes("function retire(options: Options)"),
    }).toEqual({ jobsLookup: false, entry: true });
  });

  test("every spawn carries an explicit timeout", () => {
    // Each call site is scanned to its own closing paren: counting `timeout:`
    // lines against spawn sites would miss inline options and could be
    // satisfied by another call's timeout.
    const sites = [...code.matchAll(/spawnSync\(/g)];
    const unbounded: number[] = [];
    for (const site of sites) {
      const start = (site.index ?? 0) + site[0].length;
      let depth = 1;
      let end = start;
      while (end < code.length && depth > 0) {
        const char = code[end];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        end += 1;
      }
      if (!code.slice(start, end).includes("timeout:")) {
        unbounded.push(code.slice(0, site.index ?? 0).split("\n").length);
      }
    }
    expect({ sites: sites.length > 0, unbounded }).toEqual({ sites: true, unbounded: [] });
  });
});
