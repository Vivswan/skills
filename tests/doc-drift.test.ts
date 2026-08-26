import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Doc-drift gate: skills/orchestrator-mode/references/fleet-monitor.md cites
 * exact CLI verbs, flags, JSON field names, and schema strings of the fleet
 * scripts. Nothing else binds those citations to the sources, so a rename in
 * either place would leave every gate green while the doc lies. Each entry
 * below must appear VERBATIM in both the doc and its script source; a
 * one-sided rename fails this test until doc and script move together.
 *
 * Entries pin a distinctive form PER SIDE: the doc side is a usage-line or
 * sample-JSON fragment, and the script side is a CODE-SHAPED fragment (an
 * object-literal key at the emission site, a dispatch literal, a quoted
 * string) - never a bare word that a stale comment could satisfy. The gate's
 * job is doc-to-source text pinning only; actually executing the scripts is
 * the per-script *.test.ts suites' job.
 */

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const SCRIPTS_DIR = join(ROOT, "skills", "orchestrator-mode", "scripts");

const doc = readFileSync(DOC_PATH, "utf-8");

type CitedToken = { doc: string; script: string };

const CITED_TOKENS: Record<string, CitedToken[]> = {
  "sweep.mts": [
    { doc: "--transcripts", script: '"--transcripts"' },
    { doc: "headSha", script: "headSha," },
    { doc: "aheadBehind", script: "aheadBehind," },
    { doc: "treeFileCount", script: "treeFileCount," },
    { doc: "dirtyCount", script: "dirtyCount: dirtyPaths.length" },
    { doc: "untrackedCount", script: "untrackedCount: untrackedPaths.length" },
    { doc: "newestDirtyMtime", script: "newestDirtyMtime: newestDirtyMtime(" },
    { doc: "statusHash", script: "statusHash," },
    { doc: '"defaultRef":{"ok":false', script: "defaultRef: { ok: false" },
    { doc: '"lsof":{"ok":false', script: "lsof: { ok: false" },
    { doc: '"control":"FAILED"', script: 'control: "FAILED"' },
    { doc: "sizeBytes", script: "sizeBytes: stat.size" },
    { doc: "lastEventAgeSeconds", script: "lastEventAgeSeconds:" },
    { doc: "lastEventType", script: "lastEventType: lastEventType(" },
    { doc: "processes", script: "processes," },
    { doc: '"pid"', script: "pid: entry.pid" },
    { doc: '"command"', script: "command: entry.command" },
    { doc: '"state"', script: "state: states.get(" },
  ],
  "probe.mts": [
    { doc: "probe.mts count", script: 'case "count":' },
    { doc: "probe.mts json-keys", script: 'case "json-keys":' },
    { doc: "probe.mts set", script: 'case "set":' },
    { doc: "probe.mts tokens", script: 'case "tokens":' },
    { doc: "set <repo-root> <base-ref>", script: "set needs <repo-root> <base-ref>" },
    { doc: "tokens <table.json>", script: "tokens needs <table.json> <tree-root>" },
    { doc: '"expect"', script: 'needs "expect" of ">=1"' },
    { doc: '">=1"', script: 'expect === ">=1"' },
  ],
  "ledger.mts": [
    { doc: "dormant-by-design", script: '"dormant-by-design"' },
    { doc: "landing-gate", script: '"landing-gate"' },
    { doc: "landed-swept", script: '"landed-swept"' },
    { doc: "lockfile", script: "${file}.lock" },
    { doc: "ledger.json init", script: 'case "init":' },
    { doc: "state <worker> <state>", script: 'case "state":' },
    { doc: "flag <worker> <text>", script: 'case "flag":' },
    { doc: "retract <hash-prefix>", script: 'case "retract":' },
    { doc: 'grant <worker> "<wording>"', script: 'case "grant":' },
    { doc: "show [worker]", script: 'case "show":' },
  ],
  "baseline.mts": [
    { doc: "baseline.mts pin", script: 'command === "pin"' },
    { doc: "baseline.mts check", script: 'command === "check"' },
    { doc: "<tree-root> <file...>", script: '<tree-root> <file...>",' },
  ],
};

for (const [script, tokens] of Object.entries(CITED_TOKENS)) {
  const source = readFileSync(join(SCRIPTS_DIR, script), "utf-8");
  describe(`fleet-monitor.md <-> ${script}`, () => {
    for (const token of tokens) {
      test(`doc still asserts ${JSON.stringify(token.doc)}`, () => {
        expect(doc).toContain(token.doc);
      });
      test(`${script} still carries ${JSON.stringify(token.script)}`, () => {
        expect(source).toContain(token.script);
      });
    }
  });
}

// Negative control: prove the checker can fail. A token that exists nowhere
// must read as absent on both sides; if this ever passes as present, the
// containment probe itself is broken and every green above is meaningless.
test("negative control: an impossible token matches neither side", () => {
  const impossible = "zzDocDriftImpossibleToken414";
  expect(doc.includes(impossible)).toBe(false);
  for (const script of Object.keys(CITED_TOKENS)) {
    expect(readFileSync(join(SCRIPTS_DIR, script), "utf-8").includes(impossible)).toBe(false);
  }
});
