import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

const STYLES = join(ROOT, "vale", "styles");

type Rule = {
  extends: string;
  message: string;
  level: string;
  tokens?: string[];
  swap?: Record<string, string>;
};

function rules(): { style: string; name: string; rule: Rule }[] {
  const out: { style: string; name: string; rule: Rule }[] = [];
  for (const style of readdirSync(STYLES).sort()) {
    for (const file of readdirSync(join(STYLES, style)).sort()) {
      const rule = Bun.YAML.parse(readFileSync(join(STYLES, style, file), "utf8")) as Rule;
      out.push({ style, name: file.replace(/\.yml$/, ""), rule });
    }
  }
  return out;
}

const lower = (text: string) => text.toLowerCase();

describe("vale styles", () => {
  // Two styles naming one word report every hit twice; nothing in Vale forbids it.
  test("one owner per word across the existence rules", () => {
    const owners = new Map<string, string[]>();
    for (const { style, name, rule } of rules()) {
      if (rule.extends !== "existence") continue;
      for (const token of rule.tokens ?? []) {
        const key = lower(token);
        owners.set(key, [...(owners.get(key) ?? []), `${style}.${name}`]);
      }
    }
    const shared = [...owners].filter(([, where]) => where.length > 1);
    expect(shared).toEqual([]);
  });

  // The styles are derived from skill text; a word the skill drops must leave the style too.
  test("every natural-writing and unslop token appears in the skill text it comes from", () => {
    const wordsToAvoid = lower(
      readFileSync(
        join(ROOT, "skills", "natural-writing", "references", "words-to-avoid.md"),
        "utf8",
      ),
    );
    const unslop = lower(readFileSync(join(ROOT, "xeno", "unslop", "SKILL.md"), "utf8"));
    const missing: string[] = [];
    for (const { style, name, rule } of rules()) {
      const source = style === "Unslop" ? unslop : style === "NaturalWriting" ? wordsToAvoid : null;
      if (source === null) continue;
      const entries =
        name === "TrailingParticiple"
          ? participles(rule.tokens ?? [])
          : (rule.tokens ?? Object.keys(rule.swap ?? {}));
      for (const entry of entries)
        if (!source.includes(lower(entry))) missing.push(`${style}.${name}: ${entry}`);
    }
    expect(missing).toEqual([]);
  });
});

/** The trailing-participle rule is one alternation; its members are the words the skill lists. */
function participles(tokens: string[]): string[] {
  return tokens.flatMap((token) => {
    const group = /\(([^)]*)\)/.exec(token)?.[1] ?? "";
    return group.split("|").map((word) => `, ${word}`);
  });
}
