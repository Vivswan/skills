import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Doc-drift gate for skills/orchestrator-mode/references/fleet-monitor.md.
 * What it pins - exactly the map below, nothing broader: every CONTRACT the
 * doc cites about the four fleet scripts, namely CLI invocation shapes and
 * their arity/usage contracts, ledger worker states, sweep-row and diagnostic
 * output fields, transcript-report fields, and token-table schema keys.
 * Non-contract citations (external commands like pgrep/ps, git idioms, path
 * examples) are deliberately unpinned. Each entry must appear VERBATIM in
 * both the doc and its script source; a one-sided rename fails this test
 * until doc and script move together.
 *
 * Entries pin a distinctive form PER SIDE: the doc side is a usage-line or
 * sample-JSON fragment, and the script side is a CODE-SHAPED fragment (an
 * object-literal key at the emission site, a dispatch literal or usage-error
 * string, a declaration literal) - never a bare word that a stale comment
 * could satisfy. The gate's job is doc-to-source text pinning only; actually
 * executing the scripts is the per-script *.test.ts suites' job.
 */

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const SCRIPTS_DIR = join(ROOT, "skills", "orchestrator-mode", "scripts");

const doc = readFileSync(DOC_PATH, "utf-8");

type CitedToken = { doc: string; script: string };

const CITED_TOKENS: Record<string, CitedToken[]> = {
  "sweep.mts": [
    {
      doc: "sweep.mts <repo-root> [--transcripts <dir>]",
      script: 'console.error("usage: sweep.mts <repo-root> [--transcripts <dir>]")',
    },
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
  "probe.mts": [
    { doc: "probe.mts count", script: 'case "count":' },
    { doc: "probe.mts json-keys", script: 'case "json-keys":' },
    { doc: "probe.mts set", script: 'case "set":' },
    { doc: "probe.mts tokens", script: 'case "tokens":' },
    { doc: "count <file> <literal>", script: "count needs <file> <literal>" },
    { doc: "json-keys <file> [<file2>]", script: "json-keys needs <file> [<other-file>]" },
    { doc: "set <repo-root> <base-ref>", script: "set needs <repo-root> <base-ref>" },
    { doc: "tokens <table.json> <root>", script: "tokens needs <table.json> <tree-root>" },
    { doc: '"text":', script: "spec.text" },
    { doc: '"expect"', script: 'needs "expect" of ">=1"' },
    { doc: '"expect": 0', script: "expect >= 0" },
    { doc: '">=1"', script: 'expect === ">=1"' },
    { doc: "`endLine`", script: "endLine?: number" },
  ],
  "ledger.mts": [
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
  "baseline.mts": [
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
};

/**
 * The single assertion every check in this file goes through - positive
 * checks and the negative control alike, so the control exercises the SAME
 * code path it certifies.
 */
function assertContains(haystack: string, fragment: string): void {
  expect(haystack).toContain(fragment);
}

for (const [script, tokens] of Object.entries(CITED_TOKENS)) {
  const source = readFileSync(join(SCRIPTS_DIR, script), "utf-8");
  describe(`fleet-monitor.md <-> ${script}`, () => {
    for (const token of tokens) {
      test(`doc still asserts ${JSON.stringify(token.doc)}`, () => {
        assertContains(doc, token.doc);
      });
      test(`${script} still carries ${JSON.stringify(token.script)}`, () => {
        assertContains(source, token.script);
      });
    }
  });
}

// Negative control: prove the checker can fail, through the same helper the
// positive checks use. If the sentinel ever stops throwing here, the
// containment probe itself is broken and every green above is meaningless.
test("negative control: the shared assertion fails on an impossible token", () => {
  const impossible = "zzDocDriftImpossibleToken414";
  expect(() => assertContains(doc, impossible)).toThrow();
  for (const script of Object.keys(CITED_TOKENS)) {
    const source = readFileSync(join(SCRIPTS_DIR, script), "utf-8");
    expect(() => assertContains(source, impossible)).toThrow();
  }
});
