import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Doc-drift gate for three doc-to-script surfaces. What it pins - exactly the
 * map below, nothing broader:
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
 *   sites, the failing-log excerpt command, and the superseded/FAIL/skip
 *   reporting literals.
 *
 * Non-contract citations (external commands like pgrep/ps, git idioms, path
 * examples) are deliberately unpinned. Each entry must appear VERBATIM in
 * both the doc and its script source; a one-sided rename fails this test
 * until doc and script move together.
 *
 * Entries pin a distinctive form PER SIDE: the doc side is a usage-line,
 * sample-JSON, or rendered-contract fragment as the doc prints it, and the
 * script side is a CODE-SHAPED fragment (an object-literal key at the
 * emission site, a dispatch literal or usage-error string, an echo or case
 * literal, a declaration literal) - never a bare word that a stale comment
 * could satisfy. The gate's job is doc-to-source text pinning only; actually
 * executing the scripts is the per-script *.test.ts suites' job.
 */

const ROOT = join(import.meta.dir, "..");
const FLEET_DOC = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const FLEET_SCRIPTS = join(ROOT, "skills", "orchestrator-mode", "scripts");
const RUBBER_DUCK = join(ROOT, "skills", "rubber-duck-review");
const WATCH_CI = join(ROOT, "skills", "watch-ci-after-push");

type CitedToken = { doc: string; script: string };
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
      { doc: "`--base <mainline>`", script: 'arg === "--base"' },
      { doc: "`--base origin/develop`", script: "cannot resolve --base ref" },
      { doc: "or ambiguous `--base` ref", script: '.includes("is ambiguous")' },
      { doc: '"baseRef":{"ok":false', script: "baseRef: { ok: false" },
      { doc: "--transcripts", script: '"--transcripts"' },
      { doc: '"worktree":', script: "worktree: path," },
      { doc: '"branch":', script: "branch," },
      { doc: '"ok":', script: "branch,\n    ok: true," },
      { doc: "ok:false", script: "worktree: path, ok: false" },
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
      { doc: '"control":"FAILED"', script: 'control: "FAILED"' },
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
      { doc: '"text":', script: "spec.text" },
      { doc: '"expect"', script: "spec.expect" },
      { doc: '"expect"', script: 'needs "expect" of ">=1"' },
      { doc: '"expect": 0', script: "expect >= 0" },
      { doc: '">=1"', script: 'expect === ">=1"' },
      { doc: "`endLine`", script: "endLine?: number" },
    ],
  },
  "fleet-monitor.md <-> ledger.mts": {
    docPath: FLEET_DOC,
    scriptPath: join(FLEET_SCRIPTS, "ledger.mts"),
    tokens: [
      { doc: "scripts/ledger.mts <file>", script: "usage: ledger <file> <command> [args...]" },
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
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script:
          "review FAILED - relaunch (${extraction.reason}${kept})\\n`);\n  process.exitCode = 1;",
      },
      {
        doc: "2: usage error or reviewer binary not found.",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "process.stderr.write(`${message}\\n${USAGE}\\n`);\n  process.exitCode = 2;",
      },
      {
        doc: "reviewer binary not found",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script:
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
        script: '[ "$fail" -eq 1 ] && exit 1\n[ "$gherr" -eq 1 ] && exit 2\nexit 0',
      },
      {
        doc: "Exit 0: all green (skipped runs count as\npass)",
        script: 'echo "skip: $name ($id)"',
      },
      {
        doc: "1: some latest run ended with a non-success,\n# non-skipped conclusion",
        script: 'fail=1\n      echo "FAIL($conclusion): $name ($id)"',
      },
      {
        doc: "Exit 1: some workflow's latest run ended\nwith any non-success, non-skipped conclusion",
        script: '[ "$fail" -eq 1 ] && exit 1',
      },
      { doc: "Include the FAIL lines", script: 'echo "FAIL($conclusion): $name ($id)"' },
      {
        doc: "older re-triggered runs are reported\n# as superseded, not judged",
        script: 'echo "superseded: $name ($id)"',
      },
      {
        doc: "(log excerpts in the file)",
        script: 'gh run view "$id" --log-failed 2>&1 | tail -80 || true',
      },
      {
        doc: "2: no runs registered or\n# gh failed",
        script:
          'echo "no workflow runs registered for $sha after ~15s (or gh failed; check stderr above, gh auth status, and the remote)" >&2\n  exit 2',
      },
      {
        doc: "Exit 2: discovery or gh itself failed",
        script: '[ "$gherr" -eq 1 ] && exit 2',
      },
    ],
  },
};

/**
 * The single assertion every check in this file goes through - positive
 * checks and the negative control alike, so the control exercises the SAME
 * code path it certifies.
 */
function assertContains(haystack: string, fragment: string): void {
  expect(haystack).toContain(fragment);
}

for (const [surface, { docPath, scriptPath, tokens }] of Object.entries(SURFACES)) {
  const doc = readFileSync(docPath, "utf-8");
  const source = readFileSync(scriptPath, "utf-8");
  const docName = basename(docPath);
  const scriptName = basename(scriptPath);
  describe(surface, () => {
    for (const token of tokens) {
      test(`${docName} still asserts ${JSON.stringify(token.doc)}`, () => {
        assertContains(doc, token.doc);
      });
      test(`${scriptName} still carries ${JSON.stringify(token.script)}`, () => {
        assertContains(source, token.script);
      });
    }
  });
}

// Negative control: prove the checker can fail, through the same helper the
// positive checks use, on every doc and script this gate reads. If the
// sentinel ever stops throwing here, the containment probe itself is broken
// and every green above is meaningless.
test("negative control: the shared assertion fails on an impossible token", () => {
  const impossible = "zzDocDriftImpossibleToken414";
  for (const { docPath, scriptPath } of Object.values(SURFACES)) {
    expect(() => assertContains(readFileSync(docPath, "utf-8"), impossible)).toThrow();
    expect(() => assertContains(readFileSync(scriptPath, "utf-8"), impossible)).toThrow();
  }
});
