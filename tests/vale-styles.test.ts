import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, walkFiles } from "../scripts/lib";

/** Vale reads every *.yml under the two folders a consumer names as styles, so every one of them must be a rule. */
const STYLE_ROOTS = ["skills", "xeno"];

type Rule = {
  extends: string;
  message: string;
  level: string;
  tokens?: string[];
  swap?: Record<string, string>;
};

function ruleFiles(): string[] {
  return STYLE_ROOTS.flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const dir = join(ROOT, top, entry.name, "vale");
        return statSync(dir, { throwIfNoEntry: false })?.isDirectory()
          ? readdirSync(dir)
              .filter((file) => file.endsWith(".yml"))
              .map((file) => join(dir, file))
          : [];
      }),
  ).sort();
}

/** The id Vale gives a rule: the path from the styles root with slashes as dots and no extension. */
const ruleId = (file: string) =>
  relative(ROOT, file)
    .replace(/\.yml$/, "")
    .replaceAll("/", ".");

function rules(): { id: string; skill: string; rule: Rule }[] {
  return ruleFiles().map((file) => ({
    id: ruleId(file),
    skill: relative(ROOT, file).split("/")[1] ?? "",
    rule: Bun.YAML.parse(readFileSync(file, "utf8")) as Rule,
  }));
}

const lower = (text: string) => text.toLowerCase();

describe("vale styles", () => {
  // Vale parses every .yml under a style folder as a rule; a stray one (a registry, a config) breaks every consumer.
  test("the only .yml files under skills/ and xeno/ are Vale rules in a vale/ folder", () => {
    const stray = STYLE_ROOTS.flatMap((top) => walkFiles(join(ROOT, top)))
      .filter((file) => file.endsWith(".yml"))
      .map((file) => relative(ROOT, file))
      .filter((file) => !/^(skills|xeno)\/[^/]+\/vale\/[^/]+\.yml$/.test(file));
    expect(stray).toEqual([]);
  });

  // Two rules naming one word report every hit twice; nothing in Vale forbids it.
  test("one owner per word across the existence rules", () => {
    const owners = new Map<string, string[]>();
    for (const { id, rule } of rules()) {
      if (rule.extends !== "existence") continue;
      for (const token of rule.tokens ?? []) {
        const key = lower(token);
        owners.set(key, [...(owners.get(key) ?? []), id]);
      }
    }
    const shared = [...owners].filter(([, where]) => where.length > 1);
    expect(shared).toEqual([]);
  });

  // The rules are derived from skill text; a word the skill drops must leave the rule too.
  test("every natural-writing and unslop token appears in the skill text it comes from", () => {
    const sources: Record<string, string> = {
      "natural-writing": lower(
        readFileSync(
          join(ROOT, "skills", "natural-writing", "references", "words-to-avoid.md"),
          "utf8",
        ),
      ),
      unslop: lower(readFileSync(join(ROOT, "xeno", "unslop", "SKILL.md"), "utf8")),
    };
    const missing: string[] = [];
    for (const { id, skill, rule } of rules()) {
      const source = sources[skill];
      if (source === undefined) continue;
      const entries = id.endsWith(".TrailingParticiple")
        ? participles(rule.tokens ?? [])
        : (rule.tokens ?? Object.keys(rule.swap ?? {}));
      for (const entry of entries) if (!listsEntry(source, entry)) missing.push(`${id}: ${entry}`);
    }
    expect(missing).toEqual([]);
  });
});

/** True when the skill text lists `entry` as a whole word or phrase, so `bust` does not ride on `robust`. */
function listsEntry(source: string, entry: string): boolean {
  const escaped = lower(entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(source);
}

/** The trailing-participle rule is one alternation; its members are the words the skill lists. */
function participles(tokens: string[]): string[] {
  return tokens.flatMap((token) => {
    const group = /\(([^)]*)\)/.exec(token)?.[1] ?? "";
    return group.split("|").map((word) => `, ${word}`);
  });
}
