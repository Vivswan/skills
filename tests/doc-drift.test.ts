import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Doc-drift gate for the doc-to-script surfaces in the map below - exactly
 * those, nothing broader:
 *
 * - skills/orchestrator-mode/references/fleet-monitor.md <-> the four fleet
 *   scripts (sweep.mts, probe.mts, ledger.mts, baseline.mts): every CONTRACT
 *   the doc cites about them, namely CLI invocation shapes and their
 *   arity/usage contracts, ledger worker states, sweep-row and diagnostic
 *   output fields, transcript-report fields, and token-table schema keys.
 * - skills/rubber-duck-review/SKILL.md <-> its scripts/run-review.mts: the
 *   two usage shapes (launch and --extract), the three reviewer invocations
 *   with their tool-restriction flags, the --background and --stdin-prompt
 *   flag dispatches with their output-emission and stdin-delivery sites, and
 *   the exit-code 0/1/2 semantics including the
 *   "review FAILED - relaunch" verdict literal.
 * - skills/watch-ci-after-push/SKILL.md <-> its scripts/watch-ci.sh: the
 *   invocation shape (one full-SHA argument, defaulting to HEAD), the
 *   full-SHA discovery command, the exit-code 0/1/2 semantics at their exit
 *   sites, the expected-workflow gate (its --expect-workflow override, its
 *   missing-evidence message, and the manual-dispatch hint), the failing-log
 *   excerpt command, the superseded/FAIL/skip reporting literals, and the
 *   60 s watch poll interval at its declaration and every watch call site.
 * - skills/watch-ci-after-push/SKILL.md <-> its
 *   scripts/wait-for-pr-event.mts: the invocation shape, the --until event
 *   set with its default, the interval defaults and floor, the
 *   baseline-first discipline, and the exit-code 0/1/2/3 semantics at their
 *   emission sites.
 * - skills/worktree-hygiene/SKILL.md <-> its scripts/retire-branch.mts: the
 *   invocation shape, every flag the section cites, the rehearsal and
 *   landing-gate literals, and the exit-code 1/2/3 constants at their exit
 *   sites.
 *
 * Non-contract citations (external commands like pgrep/ps, git idioms, path
 * examples) are deliberately unpinned. Each entry must appear in both the doc
 * and its script source; a one-sided rename fails this test until doc and
 * script move together. The script side is matched byte-for-byte. The doc
 * side is matched with whitespace runs collapsed and, on lines inside a bash
 * or sh fence only, the leading comment marker removed, so a pin names a
 * phrase, not where the prose happens to wrap.
 *
 * Entries pin a distinctive form PER SIDE: the doc side is a usage-line,
 * sample-JSON, or rendered-contract fragment as the doc prints it, and the
 * script side is a CODE-SHAPED fragment (an object-literal key at the
 * emission site, a dispatch literal or usage-error string, an echo or case
 * literal, a declaration literal) - never a bare word that a stale comment
 * could satisfy. A pin matches its side exactly once unless it declares how
 * often it is meant to occur, so a fragment that drifts into ambiguity fails
 * by construction: a script pin that covers several code sites states their
 * exact number, and a doc pin the prose repeats states ">=1". The gate's job
 * is doc-to-source text pinning only; actually executing the scripts is the
 * per-script *.test.ts suites' job.
 */

const ROOT = join(import.meta.dir, "..");
const FLEET_DOC = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const FLEET_SCRIPTS = join(ROOT, "skills", "orchestrator-mode", "scripts");
const RUBBER_DUCK = join(ROOT, "skills", "rubber-duck-review");
const WATCH_CI = join(ROOT, "skills", "watch-ci-after-push");
const WORKTREE_HYGIENE = join(ROOT, "skills", "worktree-hygiene");

type Occurrences = number | ">=1";
type DocPin = string | { text: string; occurrences: Occurrences };
type ScriptPin = string | { text: string; occurrences: number };
type CitedToken = { doc: DocPin; script: ScriptPin };
type Surface = { docPath: string; scriptPath: string; tokens: CitedToken[] };

const SURFACES: Record<string, Surface> = {
  "fleet-monitor.md <-> sweep.mts": {
    docPath: FLEET_DOC,
    scriptPath: join(FLEET_SCRIPTS, "sweep.mts"),
    tokens: [
      {
        doc: "sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]",
        script:
          'console.error("usage: sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]")',
      },
      { doc: { text: "`--base <mainline>`", occurrences: ">=1" }, script: 'arg === "--base"' },
      {
        doc: "`--base origin/develop`",
        script: { text: "cannot resolve --base ref", occurrences: 2 },
      },
      {
        doc: { text: "or ambiguous `--base` ref", occurrences: ">=1" },
        script: '.includes("is ambiguous")',
      },
      {
        doc: { text: '"baseRef":{"ok":false', occurrences: ">=1" },
        script: "baseRef: { ok: false",
      },
      { doc: { text: "--transcripts", occurrences: ">=1" }, script: '"--transcripts"' },
      { doc: '"worktree":', script: "worktree: path,\n    branch,\n    ok: true," },
      { doc: '"branch":', script: "worktree: path,\n    branch," },
      { doc: { text: '"ok":', occurrences: ">=1" }, script: "branch,\n    ok: true," },
      {
        doc: { text: "ok:false", occurrences: ">=1" },
        script: { text: "worktree: path, ok: false", occurrences: 14 },
      },
      { doc: '"headSha":', script: "headSha," },
      { doc: '"aheadBehind":', script: "aheadBehind," },
      { doc: '"ahead":', script: "ahead: Number.parseInt(ahead" },
      { doc: '"behind":', script: "behind: Number.parseInt(behind" },
      { doc: '"treeFileCount":', script: "treeFileCount," },
      { doc: '"dirtyCount":', script: "dirtyCount: dirtyPaths.length" },
      { doc: '"untrackedCount":', script: "untrackedCount: untrackedPaths.length" },
      { doc: '"newestDirtyMtime":', script: "newestDirtyMtime: newestDirtyMtime(" },
      { doc: '"statusHash":', script: "statusHash," },
      { doc: '"defaultRef":{"ok":false', script: "defaultRef: { ok: false" },
      { doc: '"lsof":{"ok":false', script: "lsof: { ok: false" },
      { doc: '"degraded":true', script: "degraded: true," },
      { doc: '"control":"FAILED"', script: { text: 'control: "FAILED"', occurrences: 3 } },
      { doc: "agent-*.jsonl", script: "agent-(.+)\\.jsonl" },
      { doc: "`mtime`", script: "mtime: stat.mtime.toISOString()" },
      { doc: "sizeBytes", script: "sizeBytes: stat.size" },
      { doc: "lastEventAgeSeconds", script: "lastEventAgeSeconds:" },
      { doc: "lastEventType", script: "lastEventType: lastEventType(" },
      { doc: '"processes":', script: "processes," },
      { doc: '"pid":', script: "pid: entry.pid" },
      { doc: '"command":', script: "command: entry.command" },
      { doc: '"state":', script: "state: states.get(" },
      { doc: "git ls-tree -r", script: '"ls-tree", "-r"' },
    ],
  },
  "fleet-monitor.md <-> probe.mts": {
    docPath: FLEET_DOC,
    scriptPath: join(FLEET_SCRIPTS, "probe.mts"),
    tokens: [
      { doc: "probe.mts count", script: 'case "count":' },
      { doc: "probe.mts json-keys", script: 'case "json-keys":' },
      { doc: "probe.mts set", script: 'case "set":' },
      { doc: "probe.mts tokens", script: 'case "tokens":' },
      { doc: "count <file> <literal>", script: "count needs <file> <literal>" },
      { doc: "json-keys <file> [<file2>]", script: "json-keys needs <file> [<other-file>]" },
      { doc: "set <repo-root> <base-ref>", script: "set needs <repo-root> <base-ref>" },
      { doc: "tokens <table.json> <root>", script: "tokens needs <table.json> <tree-root>" },
      {
        doc: { text: '"text":', occurrences: ">=1" },
        script: { text: "spec.text", occurrences: 6 },
      },
      {
        doc: { text: '"expect"', occurrences: ">=1" },
        script: { text: "spec.expect", occurrences: 5 },
      },
      { doc: { text: '"expect"', occurrences: ">=1" }, script: 'needs "expect" of ">=1"' },
      { doc: { text: '"expect": 0', occurrences: ">=1" }, script: "expect >= 0" },
      { doc: '">=1"', script: { text: 'expect === ">=1"', occurrences: 2 } },
      { doc: "`endLine`", script: "endLine?: number" },
    ],
  },
  "fleet-monitor.md <-> ledger.mts": {
    docPath: FLEET_DOC,
    scriptPath: join(FLEET_SCRIPTS, "ledger.mts"),
    tokens: [
      {
        doc: { text: "scripts/ledger.mts <file>", occurrences: ">=1" },
        script: "usage: ledger <file> <command> [args...]",
      },
      {
        doc: "active | dormant-by-design | landing-gate | landed-swept",
        script: '["active", "dormant-by-design", "landing-gate", "landed-swept"]',
      },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
      { doc: "lockfile", script: "${file}.lock" },
      { doc: "ledger.json init", script: 'case "init":' },
      { doc: "ledger.json init", script: "init takes no arguments" },
      { doc: "state <worker> <state>", script: 'case "state":' },
      { doc: "state <worker> <state>", script: "state requires <worker> <state>" },
      { doc: "flag <worker> <text>", script: 'case "flag":' },
      { doc: "flag <worker> <text>", script: "flag requires <worker> <text>" },
      { doc: "retract <hash-prefix>", script: 'case "retract":' },
      { doc: "retract <hash-prefix>", script: "retract requires <flag-hash-prefix>" },
      { doc: 'grant <worker> "<wording>" "<glob>"...', script: 'case "grant":' },
      {
        doc: 'grant <worker> "<wording>" "<glob>"...',
        script: "grant requires <worker> <wording> and one or more non-empty <glob...>",
      },
      { doc: "show [worker]", script: 'case "show":' },
      { doc: "show [worker]", script: "show takes at most one <worker>" },
    ],
  },
  "fleet-monitor.md <-> baseline.mts": {
    docPath: FLEET_DOC,
    scriptPath: join(FLEET_SCRIPTS, "baseline.mts"),
    tokens: [
      { doc: "baseline.mts pin", script: 'command === "pin"' },
      { doc: "baseline.mts check", script: 'command === "check"' },
      {
        doc: "/tmp/fleet-<sessionId>/baseline <tree-root> <file...>",
        script: 'pin <baseline-dir> <tree-root> <file...>",',
      },
      {
        doc: "/tmp/fleet-<sessionId>/baseline <tree-root> <file...>",
        script: "pin requires <baseline-dir> <tree-root> <file...>",
      },
      {
        doc: "check /tmp/fleet-<sessionId>/baseline <tree-root>",
        script: '<baseline-dir> <tree-root>",',
      },
      {
        doc: "check /tmp/fleet-<sessionId>/baseline <tree-root>",
        script: "check requires <baseline-dir> <tree-root>",
      },
    ],
  },
  "rubber-duck-review/SKILL.md <-> run-review.mts": {
    docPath: join(RUBBER_DUCK, "SKILL.md"),
    scriptPath: join(RUBBER_DUCK, "scripts", "run-review.mts"),
    tokens: [
      {
        doc: 'bun "<skill-dir>/scripts/run-review.mts" codex "$prompt_file"',
        script:
          "usage: run-review.mts <codex|claude|copilot> <prompt-file> [--background] [--stdin-prompt]",
      },
      {
        doc: 'bun "<skill-dir>/scripts/run-review.mts" <reviewer> --extract <output-file>',
        script: '"       run-review.mts <codex|claude|copilot> --extract <output-file>"',
      },
      { doc: "via `--extract`", script: 'rest[0] === "--extract"' },
      {
        doc: "`codex`: runs `codex exec --json --sandbox read-only`",
        script: 'codex: (prompt) => ["exec", "--json", "--sandbox", "read-only", prompt]',
      },
      {
        doc: "`claude`: runs `claude -p --permission-mode plan --verbose --output-format stream-json`",
        script:
          '"-p",\n    "--permission-mode",\n    "plan",\n    "--verbose",\n    "--output-format",\n    "stream-json",',
      },
      {
        doc: "`copilot`: runs `copilot -p <prompt> -s --available-tools=view,rg,glob --deny-tool=write --deny-tool=shell --disable-builtin-mcps`",
        script:
          'copilot: (prompt) => [\n    "-p",\n    prompt,\n    "-s",\n    "--available-tools=view,rg,glob",\n    "--deny-tool=write",\n    "--deny-tool=shell",\n    "--disable-builtin-mcps",',
      },
      {
        doc: "`--background` prints the output-file path and the PID of a detached monitor",
        script: 'arg === "--background"',
      },
      {
        doc: "`--background` prints the output-file path and the PID of a detached monitor",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "process.stdout.write(`output: ${scratch.outFile}\\npid: ${monitor.pid}\\n`);",
      },
      { doc: "`--stdin-prompt` (codex/claude only)", script: 'arg === "--stdin-prompt"' },
      {
        doc: "The prompt file itself is served as the reviewer's stdin",
        script: "stdinPrompt ? stdinDelivery(tool, promptSnapshot) : argvDelivery(tool, prompt)",
      },
      {
        doc: "0: verdict extracted and printed to stdout, or a `--background` launch started",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "process.stdout.write(`${extraction.verdict}\\n`);\n    process.exitCode = 0;",
      },
      {
        doc: "1: `review FAILED - relaunch`.",
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
          "review FAILED - relaunch (${extraction.reason}${kept})\\n`);\n  process.exitCode = 1;",
      },
      {
        doc: "2: usage error or reviewer binary not found.",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "process.stderr.write(`${message}\\n${USAGE}\\n`);\n  process.exitCode = 2;",
      },
      {
        doc: "reviewer binary not found",
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
          "process.stderr.write(`reviewer binary not found: ${tool}\\n`);\n        process.exitCode = 2;",
      },
    ],
  },
  "watch-ci-after-push/SKILL.md <-> watch-ci.sh": {
    docPath: join(WATCH_CI, "SKILL.md"),
    scriptPath: join(WATCH_CI, "scripts", "watch-ci.sh"),
    tokens: [
      {
        doc: '"<skill-dir>/scripts/watch-ci.sh <full-sha>"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the parameter-expansion source fragment
        script: 'sha="${1:-$(git rev-parse HEAD)}"',
      },
      {
        doc: 'bash "<skill-dir>/scripts/watch-ci.sh" "$(git rev-parse HEAD)" > /tmp/ci-watch.out 2>&1',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the parameter-expansion source fragment
        script: 'sha="${1:-$(git rev-parse HEAD)}"',
      },
      {
        doc: "**FULL 40-character SHA**: `gh run list --commit` silently returns an empty list for short SHAs",
        script:
          'gh run list --commit "$sha" --limit 100 --json databaseId,attempt,workflowDatabaseId,workflowName',
      },
      {
        doc: "exit 0: latest run per workflow green",
        script:
          '[ "$fail" -eq 1 ] && exit 1\n[ -n "$missing" ] && exit 2\n[ "$gherr" -eq 1 ] && exit 2\nexit 0',
      },
      {
        doc: "a red run (exit 1) outranks a missing expected workflow, which outranks a gh error (both exit 2)",
        script:
          '[ "$fail" -eq 1 ] && exit 1\n[ -n "$missing" ] && exit 2\n[ "$gherr" -eq 1 ] && exit 2',
      },
      {
        doc: "Exit 0: all green (skipped runs count as pass)",
        script: 'echo "skip: $name ($id)"',
      },
      {
        doc: "1: some latest run ended with a non-success, non-skipped conclusion",
        script: 'fail=1\n      echo "FAIL($conclusion): $name ($id)"',
      },
      {
        doc: "Exit 1: some workflow's latest run ended with any non-success, non-skipped conclusion",
        script: '[ "$fail" -eq 1 ] && exit 1',
      },
      { doc: "Include the FAIL lines", script: 'echo "FAIL($conclusion): $name ($id)"' },
      {
        doc: "older re-triggered runs are reported as superseded, not judged",
        script: 'echo "superseded: $name ($id)"',
      },
      {
        doc: "(log excerpts in the file)",
        script: 'gh run view "$id" --log-failed 2>&1 | tail -80 || true',
      },
      {
        doc: "2: no runs registered or gh failed",
        script:
          'echo "no workflow runs registered for $sha after ~15s (or gh failed; check stderr above, gh auth status, and the remote)" >&2\n  exit 2',
      },
      {
        doc: "Exit 2: discovery or gh itself failed",
        script: '[ "$gherr" -eq 1 ] && exit 2',
      },
      {
        doc: "`--expect-workflow <name>` (repeatable or comma-separated)",
        script: "    --expect-workflow)",
      },
      {
        doc: "or it exits 2 naming what it did find",
        script: 'echo "expected workflow(s) not found for $sha: $missing; discovered only:',
      },
      {
        doc: "dispatch the missing workflow by hand, e.g. `gh workflow run ci.yml --ref <branch>`",
        script: "dispatch the missing workflow by hand, e.g. gh workflow run ci.yml --ref <branch>",
      },
      {
        doc: "Transient gh or network errors mid-watch are retried (3 attempts with a short backoff) before the script concludes anything",
        script: "discover_with_retry() {",
      },
      {
        doc: "Transient gh or network errors mid-watch are retried (3 attempts with a short backoff) before the script concludes anything",
        script: "viewfail=1\n      continue\n    fi\n    viewfail=0",
      },
      {
        doc: "bundled script passes `--interval 60` to every `gh run watch`",
        script: "watch_interval=60",
      },
      {
        doc: "bundled script passes `--interval 60` to every `gh run watch`",
        script: { text: 'gh run watch "$id" --interval "$watch_interval"', occurrences: 3 },
      },
    ],
  },
  "watch-ci-after-push/SKILL.md <-> wait-for-pr-event.mts": {
    docPath: join(WATCH_CI, "SKILL.md"),
    scriptPath: join(WATCH_CI, "scripts", "wait-for-pr-event.mts"),
    tokens: [
      {
        doc: 'bun "<skill-dir>/scripts/wait-for-pr-event.mts" <pr-number> --repo <owner/name>',
        script:
          '"usage: wait-for-pr-event.mts <pr-number> [--until <set>] [--interval <sec>] [--timeout <sec>] [--repo <owner/name>]"',
      },
      {
        doc: "`comment,review,checks,merge`",
        script: 'const WATCHABLE = ["comment", "review", "checks", "merge"] as const;',
      },
      {
        doc: "(default: `comment,review`)",
        script: 'const DEFAULT_UNTIL = "comment,review";',
      },
      {
        doc: "default 60, minimum 60",
        script: "const DEFAULT_INTERVAL_SECONDS = 60;",
      },
      {
        doc: "default 60, minimum 60",
        script: "const MIN_INTERVAL_SECONDS = 60;",
      },
      {
        doc: "a failed poll retries after 2 seconds",
        script: "const POLL_RETRY_SECONDS = 2;",
      },
      {
        doc: "(default 1800)",
        script: "const DEFAULT_TIMEOUT_SECONDS = 1800;",
      },
      {
        doc: "via GraphQL `isResolved`",
        script: "nodes { isResolved comments { totalCount } }",
      },
      {
        doc: "exits 2 instead of waiting when that read fails",
        script: "baseline read failed; refusing to wait on a PR it cannot see",
      },
      {
        doc: "0 | a watched event happened",
        script: "for (const line of deltas) print(line);\n        process.exit(0);",
      },
      {
        doc: "`check <name> -> failure`, merged)",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: 'merged at ${snapshot.mergedAt ?? "an unrecorded time"}`);\n      process.exit(0);',
      },
      {
        doc: "1 | the PR merged or closed while that outcome was not watched; the wait's job ended",
        script: "but merge is not watched; the wait ended`,\n    );\n    process.exit(1);",
      },
      {
        doc: "1 | the PR merged or closed while that outcome was not watched; the wait's job ended",
        script: "closed without merging; the wait ended`);\n    process.exit(1);",
      },
      {
        doc: "2 | usage or tooling error (bad args, gh missing or failing)",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "writeFileSync(2, `${message}\\n${USAGE}\\n`);\n  process.exit(2);",
      },
      {
        doc: "gh missing or failing); it never retries forever",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "writeFileSync(2, `${message}\\n`);\n  process.exit(2);",
      },
      {
        doc: "3 | timeout with no watched change",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "print(`final:    ${renderSnapshot(last)}`);\n    process.exit(3);",
      },
      {
        doc: "the baseline and final snapshots are in the output",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "print(`baseline: ${renderSnapshot(baseline)}`);",
      },
    ],
  },
  "worktree-hygiene/SKILL.md <-> retire-branch.mts": {
    docPath: join(WORKTREE_HYGIENE, "SKILL.md"),
    scriptPath: join(WORKTREE_HYGIENE, "scripts", "retire-branch.mts"),
    tokens: [
      {
        doc: {
          text: 'bun "<skill-dir>/scripts/retire-branch.mts" --branch feature/thing',
          occurrences: 2,
        },
        script: '"usage: retire-branch.mts --branch <name> [options]"',
      },
      { doc: "--branch feature/thing --execute", script: 'flag === "--execute"' },
      {
        doc: "--mainline develop --remote upstream --repo-root /path/to/repo",
        script: '"--mainline": "mainline",',
      },
      {
        doc: "--mainline develop --remote upstream --repo-root /path/to/repo",
        script: '"--remote": "remote",',
      },
      {
        doc: "--mainline develop --remote upstream --repo-root /path/to/repo",
        script: '"--repo-root": "repoRoot",',
      },
      { doc: "--original-tip 7c31f0e", script: '"--original-tip": "originalTip",' },
      {
        doc: "--no-writer-check # a host where lsof cannot answer",
        script: 'flag === "--no-writer-check"',
      },
      {
        doc: "REHEARSED: every gate passed for feature/thing; nothing was destroyed",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "REHEARSED: every gate passed for ${options.branch}; nothing was destroyed",
      },
      {
        doc: { text: "(add --execute)", occurrences: 2 },
        script: { text: "(add --execute)", occurrences: 2 },
      },
      {
        doc: { text: "[landed] by content equivalence at", occurrences: 2 },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "by content equivalence at ${short(base)}",
      },
      {
        doc: "`[landed] by ancestry`",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "by ancestry: ${label} is contained in",
      },
      { doc: "| 1 | a gate REFUSED on the evidence", script: "const EXIT_REFUSED = 1;" },
      { doc: "| 1 | a gate REFUSED on the evidence", script: "exitWith(EXIT_REFUSED," },
      { doc: "| 2 | usage error", script: "const EXIT_USAGE = 2;" },
      { doc: "| 2 | usage error", script: "exitWith(EXIT_USAGE," },
      { doc: "| 3 | BROKEN measurement", script: "const EXIT_BROKEN = 3;" },
      { doc: "| 3 | BROKEN measurement", script: "exitWith(EXIT_BROKEN," },
    ],
  },
};

/**
 * Doc pins name phrases: line wrapping carries no contract, and neither does
 * the comment marker on lines inside a bash or sh fence. Comment markers in
 * prose and in every other fence stay intact. Only a bare ``` closes a fence.
 */
function normalizeDoc(text: string): string {
  const lines = text.split("\n");
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence === null) {
      fence = /^\s*```(\S*)/.exec(line)?.[1] ?? null;
    } else if (/^\s*```\s*$/.test(line)) {
      fence = null;
    } else if (fence === "bash" || fence === "sh") {
      lines[index] = line.replace(/^(\s*)#( |$)/, "$1");
    }
  }
  return lines.join("\n").replace(/\s+/g, " ");
}

/**
 * The single assertion every check in this file goes through - positive
 * checks and the negative control alike, so the control exercises the SAME
 * code path it certifies.
 */
function assertOccurrences(haystack: string, text: string, occurrences: Occurrences): void {
  const found = haystack.split(text).length - 1;
  const message = `${JSON.stringify(text)} occurs ${found} time(s), expected ${occurrences}`;
  if (occurrences === ">=1") {
    expect(found, message).toBeGreaterThanOrEqual(1);
  } else {
    expect(found, message).toBe(occurrences);
  }
}

// Rows may share a fragment; it registers once, and two rows disagreeing on
// its count is a table error, not two tests. Only prose may repeat a phrase:
// a script pin always states the exact number of code sites it covers.
function uniquePins(
  pins: Array<DocPin | ScriptPin>,
  side: "doc" | "script",
): Map<string, Occurrences> {
  const byText = new Map<string, Occurrences>();
  for (const pin of pins) {
    const { text, occurrences } = typeof pin === "string" ? { text: pin, occurrences: 1 } : pin;
    const valid =
      typeof occurrences === "number"
        ? Number.isInteger(occurrences) && occurrences >= 1
        : side === "doc";
    if (!valid) {
      throw new Error(
        `${JSON.stringify(text)}: a ${side} pin needs a positive integer count, got ${occurrences}`,
      );
    }
    const known = byText.get(text);
    if (known !== undefined && known !== occurrences) {
      throw new Error(
        `${JSON.stringify(text)} is pinned with occurrences ${known} and ${occurrences}`,
      );
    }
    byText.set(text, occurrences);
  }
  return byText;
}

for (const [surface, { docPath, scriptPath, tokens }] of Object.entries(SURFACES)) {
  const doc = normalizeDoc(readFileSync(docPath, "utf-8"));
  const source = readFileSync(scriptPath, "utf-8");
  const docName = basename(docPath);
  const scriptName = basename(scriptPath);
  describe(surface, () => {
    for (const [text, occurrences] of uniquePins(
      tokens.map((token) => token.doc),
      "doc",
    )) {
      test(`${docName} still asserts ${JSON.stringify(text)}`, () => {
        assertOccurrences(doc, text, occurrences);
      });
    }
    for (const [text, occurrences] of uniquePins(
      tokens.map((token) => token.script),
      "script",
    )) {
      test(`${scriptName} still carries ${JSON.stringify(text)}`, () => {
        assertOccurrences(source, text, occurrences);
      });
    }
  });
}

// Negative control: prove the checker can fail, through the same helper the
// positive checks use, on every file this gate reads. The pinned message
// rejects unrelated throws (a failed read, a matcher misuse).
test("negative control: the shared assertion fails on an impossible token", () => {
  const impossible = "zzDocDriftImpossibleToken414";
  const paths = new Set(
    Object.values(SURFACES).flatMap(({ docPath, scriptPath }) => [docPath, scriptPath]),
  );
  for (const path of paths) {
    expect(() => assertOccurrences(readFileSync(path, "utf-8"), impossible, 1)).toThrow(
      /"zzDocDriftImpossibleToken414" occurs 0 time\(s\), expected 1/,
    );
  }
});

// Negative control: the normalizer's exact output for every fence shape the
// pinned docs use, so a marker stripped outside bash/sh, a dropped language,
// or a fence closed by a language line all fail here.
const NORMALIZATION_CASES: Array<{ id: string; input: string; expected: string }> = [
  {
    id: "prose wrapping and tabs collapse to single spaces",
    input: "Exit 0: all\ngreen  (skipped\truns)",
    expected: "Exit 0: all green (skipped runs)",
  },
  {
    id: "prose keeps its comment markers",
    input: "# Heading\n\n# not a comment",
    expected: "# Heading # not a comment",
  },
  {
    id: "bash fence drops leading markers, blank marker lines included",
    input: "```bash\n# exit 0\n#\n# pass\n```",
    expected: "```bash exit 0 pass ```",
  },
  {
    id: "indented bash fence drops leading markers",
    input: "Run:\n  ```bash\n  # exit 0\n  ```",
    expected: "Run: ```bash exit 0 ```",
  },
  {
    id: "sh fence drops leading markers",
    input: "```sh\n# exit 0\n```",
    expected: "```sh exit 0 ```",
  },
  {
    id: "bash fence keeps a marker that is not at line start",
    input: "```bash\necho '# kept'\n```",
    expected: "```bash echo '# kept' ```",
  },
  {
    id: "text fence keeps its markers",
    input: "```text\n# exit 0\n```",
    expected: "```text # exit 0 ```",
  },
  {
    id: "json fence keeps its markers",
    input: "```json\n# exit 0\n```",
    expected: "```json # exit 0 ```",
  },
  {
    id: "a language line inside an open bash fence does not close it",
    input: "```bash\n# one\n```json\n# two\n```\n# three",
    expected: "```bash one ```json two ``` # three",
  },
];

describe("doc normalization", () => {
  for (const { id, input, expected } of NORMALIZATION_CASES) {
    test(id, () => {
      expect(normalizeDoc(input), id).toBe(expected);
    });
  }
});
