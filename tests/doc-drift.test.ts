import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Doc-drift gate: skills/orchestrator-mode/references/fleet-monitor.md cites
 * exact CLI flags, JSON field names, and schema strings of the fleet scripts.
 * Nothing else binds those citations to the sources, so a rename in either
 * place would leave every gate green while the doc lies. Each token below
 * must appear VERBATIM in both the doc and its script source; a one-sided
 * rename fails this test until doc and script move together.
 *
 * Tokens are kept specific (field names, bracketed CLI placeholders, quoted
 * schema literals) so they cannot self-match on unrelated prose.
 */

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "skills", "orchestrator-mode", "references", "fleet-monitor.md");
const SCRIPTS_DIR = join(ROOT, "skills", "orchestrator-mode", "scripts");

const doc = readFileSync(DOC_PATH, "utf-8");

const CITED_TOKENS: Record<string, string[]> = {
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
  "probe.mts": ["json-keys", "<base-ref>", "<table.json>", '"expect"', '">=1"'],
  "ledger.mts": [
    "dormant-by-design",
    "landing-gate",
    "landed-swept",
    "retract",
    "grant",
    "lockfile",
  ],
  "baseline.mts": ["<tree-root>", "<file...>"],
};

for (const [script, tokens] of Object.entries(CITED_TOKENS)) {
  const source = readFileSync(join(SCRIPTS_DIR, script), "utf-8");
  describe(`fleet-monitor.md <-> ${script}`, () => {
    for (const token of tokens) {
      test(`doc still asserts ${JSON.stringify(token)}`, () => {
        expect(doc).toContain(token);
      });
      test(`${script} still carries ${JSON.stringify(token)}`, () => {
        expect(source).toContain(token);
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
