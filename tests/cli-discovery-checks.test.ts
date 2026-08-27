import { describe, expect, test } from "bun:test";
import { checkListing, listingRows, stripAnsi } from "../scripts/cli-discovery-checks";
import { CheckFailure } from "../scripts/lib";

// Incident-class tests for the CLI discovery checks. The old checks searched
// the CLI's whole output as free text, and the listing prints full skill
// descriptions, so a skill NAMED in another skill's description passed the
// presence check even when the CLI had silently dropped it (reproduced with
// metadata.internal on a published skill), a description mentioning the
// template skill's name read as a leak, and the group heading was satisfied
// by any mention. These fixtures replay each flaw against the row-based
// checks.

const ESC = String.fromCharCode(27);
// The CLI draws its listing gutter with U+2502 (box drawings light vertical);
// built from the code point so no look-alike unicode lands in this file.
const GUTTER = String.fromCharCode(0x2502);

const GROUP = "Vivswan Skills";
const TEMPLATE = "template-skill";

interface Entry {
  readonly name: string;
  readonly description: string;
}

// Mimics the real `npx skills add <path> --list` output shape: spinner
// transcript, a flush-left group heading, then per skill a gutter-decorated
// bare-name row followed by an indented full-description line.
function listing(entries: readonly Entry[], group = GROUP): string {
  const lines = ["npm notice run npx", GUTTER, `   Found ${entries.length} skills`, group, GUTTER];
  for (const { name, description } of entries) {
    lines.push(`${GUTTER}    ${name}`, GUTTER, `${GUTTER}      ${description}`, GUTTER);
  }
  return lines.join("\n");
}

// watch-ci-after-push has NO row here, but no-sleep's description names it -
// the exact shape of the reproduced silent vanish.
const VANISHED = listing([
  { name: "code-standards", description: "Use when writing code changes." },
  {
    name: "no-sleep-waiting-on-subagents",
    description: "Use when waiting (CI runs belong to /watch-ci-after-push).",
  },
]);
const VANISHED_EXPECTED = ["code-standards", "no-sleep-waiting-on-subagents"];

describe("listingRows", () => {
  test("collects bare-name rows under their group heading, ignoring mentions", () => {
    expect(listingRows(VANISHED)).toEqual([
      { name: "code-standards", group: GROUP },
      { name: "no-sleep-waiting-on-subagents", group: GROUP },
    ]);
  });

  test("parses through ANSI decoration without a separate strip step", () => {
    const decorated = `${GROUP}\n${GUTTER}    ${ESC}[36mcode-standards${ESC}[39m\n`;
    expect(listingRows(decorated)).toEqual([{ name: "code-standards", group: GROUP }]);
    expect(listingRows(stripAnsi(decorated))).toEqual(listingRows(decorated));
  });

  test("a hyperlinked row name (OSC 8, BEL- or ESC-backslash-terminated) still parses", () => {
    const bel = String.fromCharCode(7);
    const linkBel = `${ESC}]8;;https://example.test${bel}code-standards${ESC}]8;;${bel}`;
    const linkSt = `${ESC}]8;;https://example.test${ESC}\\never-twice${ESC}]8;;${ESC}\\`;
    const output = `${GROUP}\n${GUTTER}    ${linkBel}\n${GUTTER}    ${linkSt}\n`;
    expect(listingRows(output)).toEqual([
      { name: "code-standards", group: GROUP },
      { name: "never-twice", group: GROUP },
    ]);
  });

  test("a wrapped description line holding only a skill name is not a row", () => {
    // A description continuation keeps the description indent (deeper than a
    // name row's); a lone name there must not impersonate a listing row.
    const wrapped = [
      GROUP,
      `${GUTTER}    no-sleep-waiting-on-subagents`,
      `${GUTTER}      Use when waiting (CI runs belong to`,
      `${GUTTER}      watch-ci-after-push`,
      `${GUTTER}      instead).`,
    ].join("\n");
    expect(listingRows(wrapped)).toEqual([{ name: "no-sleep-waiting-on-subagents", group: GROUP }]);
    expect(() =>
      checkListing(
        ["no-sleep-waiting-on-subagents", "watch-ci-after-push"],
        GROUP,
        TEMPLATE,
        wrapped,
      ),
    ).toThrow(/skill 'watch-ci-after-push' missing from the CLI listing rows/);
  });

  test("a bare name without the exact gutter-plus-indent row prefix is not a row", () => {
    // Flush-left chrome, shallow indents without the gutter, a gutter with
    // the wrong indent, and a wrong glyph with the right indent must all
    // fail to impersonate a row.
    const bullet = String.fromCharCode(0x2022); // U+2022 bullet
    const impostors = [
      "watch-ci-after-push",
      " watch-ci-after-push",
      "    watch-ci-after-push",
      `${GUTTER}watch-ci-after-push`,
      `${GUTTER}   watch-ci-after-push`,
      `${bullet}    watch-ci-after-push`,
    ].join("\n");
    expect(listingRows(impostors)).toEqual([]);
  });
});

describe("checkListing", () => {
  test("passes when every expected skill has its own row under the group", () => {
    expect(() => checkListing(VANISHED_EXPECTED, GROUP, TEMPLATE, VANISHED)).not.toThrow();
  });

  test("negative control: a skill named only inside another description fails", () => {
    // The fixture reproduces the old pass condition: the whole-output
    // boundary regex the previous check used does match the mention.
    expect(/(^|[^a-z0-9-])watch-ci-after-push([^a-z0-9-]|$)/.test(VANISHED)).toBe(true);
    const expected = [...VANISHED_EXPECTED, "watch-ci-after-push"];
    expect(() => checkListing(expected, GROUP, TEMPLATE, VANISHED)).toThrow(CheckFailure);
    expect(() => checkListing(expected, GROUP, TEMPLATE, VANISHED)).toThrow(
      /skill 'watch-ci-after-push' missing from the CLI listing rows/,
    );
  });

  test("negative control: an absent never-mentioned skill still fails", () => {
    const expected = [...VANISHED_EXPECTED, "ghost-skill"];
    expect(() => checkListing(expected, GROUP, TEMPLATE, VANISHED)).toThrow(
      /skill 'ghost-skill' missing from the CLI listing rows/,
    );
  });

  test("skills under the wrong group heading fail even when a description mentions the title", () => {
    const misgrouped = listing(
      [{ name: "code-standards", description: `Use when grouped under ${GROUP}.` }],
      "General",
    );
    expect(misgrouped).toContain(GROUP); // the old includes() check would pass
    expect(() => checkListing(["code-standards"], GROUP, TEMPLATE, misgrouped)).toThrow(
      /skill 'code-standards' listed under 'General', not 'Vivswan Skills'/,
    );
  });

  test("an unexpected extra skill row fails instead of passing as a superset", () => {
    const extra = listing([
      { name: "code-standards", description: "Use when writing code changes." },
      { name: "stowaway-skill", description: "Use when something leaks." },
    ]);
    expect(() => checkListing(["code-standards"], GROUP, TEMPLATE, extra)).toThrow(
      /unexpected skill row 'stowaway-skill'/,
    );
  });

  test("a duplicate row never passes, even when the later copy sits in the right group", () => {
    const duplicated = [
      "General",
      `${GUTTER}    code-standards`,
      GROUP,
      `${GUTTER}    code-standards`,
    ].join("\n");
    expect(() => checkListing(["code-standards"], GROUP, TEMPLATE, duplicated)).toThrow(
      /duplicate listing row for skill 'code-standards'/,
    );
  });

  test("a row for a longer name never satisfies a shorter one, or vice versa", () => {
    const longer = listing([{ name: "foo-bar", description: "Use when foo." }]);
    expect(() => checkListing(["foo", "foo-bar"], GROUP, TEMPLATE, longer)).toThrow(
      /skill 'foo' missing/,
    );
    const shorter = listing([{ name: "foo", description: "Use when foo." }]);
    expect(() => checkListing(["foo", "foo-bar"], GROUP, TEMPLATE, shorter)).toThrow(
      /skill 'foo-bar' missing/,
    );
  });

  test("a listing row for the template skill is a leak", () => {
    const leaked = listing([{ name: TEMPLATE, description: "Placeholder trigger." }]);
    expect(() => checkListing([TEMPLATE], GROUP, TEMPLATE, leaked)).toThrow(
      /internal template skill 'template-skill' leaked/,
    );
  });

  test("a description mentioning the template name is not a leak", () => {
    const mentionOnly = listing([
      { name: "code-standards", description: `Use when a file looks copied from ${TEMPLATE}.` },
    ]);
    expect(() => checkListing(["code-standards"], GROUP, TEMPLATE, mentionOnly)).not.toThrow();
  });
});
