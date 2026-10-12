import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Doc-drift gate for the doc-to-script surfaces in SURFACES below, exactly those: each contract the doc cites about its
 * script (usage shapes, flags, exit codes, output fields) is pinned on both sides, so a one-sided rename fails here until
 * both move. Non-contract citations (external commands, git idioms, path examples) stay unpinned; nothing here runs a script.
 *
 * A pin is a form distinctive on ITS side, never a bare word a stale comment could satisfy:
 *   doc side     -> the usage line, sample JSON, or rendered contract fragment as the doc prints it
 *   script side  -> a code-shaped fragment: an object-literal key at its emission site, a dispatch or usage-error literal, an echo or case literal
 */

const ROOT = join(import.meta.dir, "..");
const FLEET_DOC = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const FLEET_SCRIPTS = join(ROOT, "skills", "orchestrator-mode", "scripts");
const RUBBER_DUCK = join(ROOT, "skills", "rubber-duck-review");
const WATCH_PRS = join(ROOT, "skills", "watch-prs-and-ci");
const WORKTREE_HYGIENE = join(ROOT, "skills", "worktree-hygiene");
const CODEX_BROWSER_FIX = join(ROOT, "skills", "codex-browser-fix");

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
      { doc: "--full-tree", script: '"ls-tree", "-r", "-z", "--full-tree"' },
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
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the shell parameter-expansion fragment as the doc prints it
        doc: 'bun "<skill-dir>/scripts/run-review.mts" <reviewer> --extract --wait "$out" > "${out%/*}/verdict.out" 2>&1',
        script:
          '"       run-review.mts <codex|claude|copilot> --extract --wait <output-file> [--timeout <seconds>]"',
      },
      {
        doc: "collect the verdict with `--extract --wait`",
        script: 'if (arg === "--wait") wait = true;',
      },
      { doc: "polls the launch record every 2 s", script: "const WAIT_POLL_MS = 2000;" },
      {
        doc: "(`--timeout <seconds>`, default 3600)",
        script: "const DEFAULT_WAIT_TIMEOUT_SECONDS = 3600;",
      },
      {
        doc: "1: review failed or `--wait timed out` (relaunch)",
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
          "reason: `--wait timed out: no exit status recorded beside ${outputFile} after ${elapsed} s`,",
      },
      {
        doc: "2: wrong reviewer or file, or no launch record beside the output file",
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
          "`no launch record beside ${outputFile}: --wait needs the output-file a --background launch printed`,",
      },
      {
        doc: "exits 1 (`no exit status recorded`) while the reviewer is still running",
        script: 'reason: "no exit status recorded (reviewer still running?)"',
      },
      {
        doc: 'bun "<skill-dir>/scripts/run-review.mts" prepare api-gateway',
        script: '"       run-review.mts prepare <section>"',
      },
      { doc: "the script mints the path", script: 'argv[0] === "prepare"' },
      {
        doc: "A launch refuses any prompt file outside such a directory",
        script: "prompt file must live in a directory minted by",
      },
      {
        doc: "`codex`: runs `codex exec --json --sandbox read-only --output-schema <schema>`",
        script:
          'codex: (prompt, sandbox) => [\n    "exec",\n    "--json",\n    "--sandbox",\n    sandbox,\n    "--output-schema",\n    SCHEMA_FILE,\n    prompt,\n  ],',
      },
      {
        doc: "`codex sandbox -- true`",
        script: 'spawnSync("codex", ["sandbox", "--", "true"]',
      },
      {
        doc: "`bwrap: Failed to make / slave: Permission denied`",
        script: "const BWRAP_REFUSAL = /^bwrap: .*$/m;",
      },
      {
        doc: "`--sandbox danger-full-access` inside a snapshot copy",
        script: 'args = delivery.args("danger-full-access");',
      },
      {
        doc: "The reviewer runs under a scratch `CODEX_HOME`",
        script: "CODEX_HOME: codexHome",
      },
      {
        doc: "The scratch home's `sessions` directory is a link to the user's own",
        script: "symlinkSync(realSessions, join(home, CODEX_SESSIONS_DIR));",
      },
      {
        doc: 'the report and the launch record carry `sandbox: "copy"`',
        script: "...(sandbox === undefined ? {} : { sandbox }),",
      },
      {
        doc: "`claude`: runs `claude -p --permission-mode plan --verbose --output-format stream-json --json-schema <schema>`",
        script:
          '"-p",\n    "--permission-mode",\n    "plan",\n    "--verbose",\n    "--output-format",\n    "stream-json",\n    "--json-schema",\n    schemaText(),',
      },
      {
        doc: "`copilot`: runs `copilot -p <prompt> -s --available-tools=view,rg,glob --deny-tool=write --deny-tool=shell --disable-builtin-mcps`",
        script:
          'copilot: (prompt) => [\n    "-p",\n    prompt,\n    "-s",\n    "--available-tools=view,rg,glob",\n    "--deny-tool=write",\n    "--deny-tool=shell",\n    "--disable-builtin-mcps",',
      },
      {
        doc: "`--background` prints exactly two lines, `output-file: <path>` and `pid: <n>`",
        script: 'arg === "--background"',
      },
      {
        doc: "`--background` prints exactly two lines, `output-file: <path>` and `pid: <n>`",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
        script: "process.stdout.write(`output-file: ${scratch.outFile}\\npid: ${monitor.pid}\\n`);",
      },
      { doc: "`--stdin-prompt` (codex/claude only)", script: 'arg === "--stdin-prompt"' },
      {
        doc: "The prompt file itself is served as the reviewer's stdin",
        script: "stdinPrompt ? stdinDelivery(tool, promptSnapshot) : argvDelivery(tool, prompt)",
      },
      {
        doc: "0: verdict extracted and printed to stdout as the JSON report, or a `--background` launch started",
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
          "process.stdout.write(`${JSON.stringify(report, null, 2)}\\n`);\n    process.exitCode = 0;",
      },
      {
        doc: "1: `review FAILED - relaunch`.",
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the template-shaped source fragment
          "`review FAILED - relaunch (${extraction.reason}${kept})\\n`);\n  process.exitCode = 1;",
      },
      {
        doc: "2: usage error, reviewer binary not found, or codex's sandbox unavailable outside a git repository.",
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
  "watch-prs-and-ci/SKILL.md <-> pr-events.mts": {
    docPath: join(WATCH_PRS, "SKILL.md"),
    scriptPath: join(WATCH_PRS, "scripts", "pr-events.mts"),
    tokens: [
      {
        doc: "pr-events.mts daemon [--interval <s>] [--id <name>] [--pid <pid>]",
        script: '"  daemon [--interval <s>] [--id <name>] [--pid <pid>]"',
      },
      {
        doc: "pr-events.mts watch <owner/repo>#<n> [--head <sha>] [--expect-workflow <name>]... [--id <name>]",
        script:
          '"  watch <owner/repo>#<n> [--head <sha>] [--expect-workflow <name>]... [--id <name>]"',
      },
      {
        doc: "pr-events.mts watch-commit <owner/repo> <sha> [--expect-workflow <name>]... [--id <name>]",
        script: '"  watch-commit <owner/repo> <sha> [--expect-workflow <name>]... [--id <name>]"',
      },
      {
        doc: { text: "--expect-workflow", occurrences: ">=1" },
        script: 'usage("--expect-workflow needs a workflow name")',
      },
      {
        doc: { text: "--id codex-12", occurrences: ">=1" },
        script: 'const OWNER_OPTIONS = { id: { type: "string" } } as const;',
      },
      {
        doc: { text: "`CLAUDE_CODE_MESSAGING_SOCKET`", occurrences: ">=1" },
        script: "const inbox = env.CLAUDE_CODE_MESSAGING_SOCKET;",
      },
    ],
  },
  "watch-prs-and-ci/SKILL.md <-> state.mts": {
    docPath: join(WATCH_PRS, "SKILL.md"),
    scriptPath: join(WATCH_PRS, "scripts", "state.mts"),
    tokens: [
      { doc: "`<session-pid>.events.jsonl`", script: 'EVENTS_SUFFIX = ".events.jsonl"' },
      {
        doc: { text: "`<session-pid>.sock`", occurrences: ">=1" },
        script: 'SOCKET_SUFFIX = ".sock"',
      },
      {
        doc: { text: "`PR_EVENTS_DIR`", occurrences: ">=1" },
        script: "if (env.PR_EVENTS_DIR) candidates.push(resolve(env.PR_EVENTS_DIR));",
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
  "codex-browser-fix/SKILL.md <-> browser-plugin-preflight.mts": {
    docPath: join(CODEX_BROWSER_FIX, "SKILL.md"),
    scriptPath: join(CODEX_BROWSER_FIX, "scripts", "browser-plugin-preflight.mts"),
    tokens: [
      {
        doc: { text: "--check", occurrences: ">=1" },
        script: 'if (arg === "--check") checkOnly = true;',
      },
      {
        doc: "`--plugin-dir <dir>`",
        script: '"usage: browser-plugin-preflight.mts [--check] [--plugin-dir <dir>]"',
      },
      { doc: "a missing `--plugin-dir` value exits 2", script: "process.exit(2);" },
      { doc: { text: "`$CODEX_HOME`", occurrences: 1 }, script: "process.env.CODEX_HOME" },
      { doc: "`<home>/scripts/browser-codex`", script: '"scripts", "browser-codex"' },
      {
        doc: "under `[mcp_servers.node_repl.env]`",
        script: '"mcp_servers.node_repl.env.CODEX_CLI_PATH": launcherPath',
      },
      {
        doc: "Under `[shell_environment_policy.set]`",
        script:
          '"shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S": clientHash',
      },
      {
        doc: "`<home>/plugin-rollbacks/`",
        script: { text: '"plugin-rollbacks",', occurrences: 2 },
      },
    ],
  },
  "codex-browser-fix/SKILL.md <-> browser-auth-launcher.mts": {
    docPath: join(CODEX_BROWSER_FIX, "SKILL.md"),
    scriptPath: join(CODEX_BROWSER_FIX, "scripts", "browser-auth-launcher.mts"),
    tokens: [
      { doc: "`-c 'model_provider=\"openai\"'`", script: "-c 'model_provider=\"openai\"'" },
      { doc: "Only its `app-server` subcommand", script: "app-server)" },
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
