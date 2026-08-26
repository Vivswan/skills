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
 * Tokens are kept specific (field names, bracketed CLI placeholders, quoted
 * schema literals) so they cannot self-match on unrelated prose. Where the
 * bare token would self-match trivially (CLI verbs like "count" or "state"),
 * the entry pins a longer distinctive form per side: the doc's usage-line
 * fragment and the script's dispatch literal.
 */

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const SCRIPTS_DIR = join(ROOT, "skills", "orchestrator-mode", "scripts");

const doc = readFileSync(DOC_PATH, "utf-8");

type CitedToken = string | { doc: string; script: string };

const CITED_TOKENS: Record<string, CitedToken[]> = {
  "sweep.mts": [
    "--transcripts",
    "headSha",
    "aheadBehind",
    "treeFileCount",
    "dirtyCount",
    "untrackedCount",
    "newestDirtyMtime",
    "statusHash",
    "defaultRef",
    "sizeBytes",
    "lastEventAgeSeconds",
    "lastEventType",
  ],
  "probe.mts": [
    "json-keys",
    "<base-ref>",
    "<table.json>",
    '"expect"',
    '">=1"',
    { doc: "probe.mts count", script: 'case "count":' },
    { doc: "probe.mts json-keys", script: 'case "json-keys":' },
    { doc: "probe.mts set", script: 'case "set":' },
    { doc: "probe.mts tokens", script: 'case "tokens":' },
  ],
  "ledger.mts": [
    "dormant-by-design",
    "landing-gate",
    "landed-swept",
    "retract",
    "grant",
    "lockfile",
    { doc: "ledger.json init", script: 'case "init":' },
    { doc: "state <worker> <state>", script: 'case "state":' },
    { doc: "flag <worker> <text>", script: 'case "flag":' },
    { doc: "retract <hash-prefix>", script: 'case "retract":' },
    { doc: "grant <worker> <wording>", script: 'case "grant":' },
    { doc: "show [worker]", script: 'case "show":' },
  ],
  "baseline.mts": [
    "<tree-root>",
    "<file...>",
    { doc: "baseline.mts pin", script: 'command === "pin"' },
    { doc: "baseline.mts check", script: 'command === "check"' },
  ],
};

for (const [script, tokens] of Object.entries(CITED_TOKENS)) {
  const source = readFileSync(join(SCRIPTS_DIR, script), "utf-8");
  describe(`fleet-monitor.md <-> ${script}`, () => {
    for (const token of tokens) {
      const docToken = typeof token === "string" ? token : token.doc;
      const scriptToken = typeof token === "string" ? token : token.script;
      test(`doc still asserts ${JSON.stringify(docToken)}`, () => {
        expect(doc).toContain(docToken);
      });
      test(`${script} still carries ${JSON.stringify(scriptToken)}`, () => {
        expect(source).toContain(scriptToken);
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
