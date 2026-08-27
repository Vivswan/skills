/**
 * Listing assertions for the CLI discovery test, extracted from
 * cli-discovery-test.ts so they can be unit-tested without a network run
 * (importing cli-discovery-test.ts would execute the whole npx invocation).
 *
 * Incident class: the previous checks searched the CLI's whole output as free
 * text, and the listing prints every skill's full description, so a skill (or
 * the group heading) NAMED inside a description satisfied its check even when
 * the CLI had dropped it (reproduced: metadata.internal on a published skill
 * made the CLI silently omit it while every repo gate stayed green). The
 * reverse check had the mirrored flaw: a description mentioning the template
 * skill's name read as a leak. The listing is therefore parsed into ROWS -
 * a line whose entire content is one bare kebab-case name, tagged with the
 * nearest group heading above it - and every assertion runs against rows.
 */

import { fail, KEBAB_CASE } from "./lib";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// ECMA-48 shapes: CSI is parameter bytes 0x30-0x3F, intermediates 0x20-0x2F,
// one final byte 0x40-0x7E; OSC runs to BEL or the ESC \ string terminator.
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");

export function stripAnsi(text: string): string {
  return text.replace(CSI_SEQUENCE, "").replace(OSC_SEQUENCE, "");
}

export interface ListingRow {
  readonly name: string;
  /** The nearest group heading above the row ("" before any heading). */
  readonly group: string;
}

// KEBAB_CASE without its anchors, for embedding in the row pattern.
const KEBAB = KEBAB_CASE.source.replace(/^\^/, "").replace(/\$$/, "");
// The CLI's listing gutter: U+2502 (box drawings light vertical), built from
// the code point so no look-alike unicode lands in this file.
const GUTTER = String.fromCharCode(0x2502);
// A listing row exactly as the CLI prints one: the gutter glyph, the 4-space
// row indent (descriptions and their wrap continuations are indented
// deeper), then one bare kebab-case name and nothing else. The prefix is
// required, so neither a deeper-indented wrapped description line nor a
// chrome line holding a lone name can impersonate a row; a rendering change
// breaks this loudly (rows drop, assertions fail) instead of passing on
// free text.
const ROW = new RegExp(`^${GUTTER} {4}(${KEBAB}) *$`);
// An undecorated flush-left plain-ASCII line: how the CLI prints headings.
const HEADING = /^[!-~][ -~]*$/;

/**
 * Parse the CLI output into listing rows, each tagged with the nearest group
 * heading above it. Anything that is not a row or a heading - descriptions,
 * spinner transcript, npm chrome - contributes nothing, so free-text mentions
 * cannot satisfy or trip a check. An unrecognized future rendering drops rows
 * and fails the assertions loudly rather than passing on free text.
 */
export function listingRows(output: string): ListingRow[] {
  const rows: ListingRow[] = [];
  let group = "";
  for (const line of stripAnsi(output).split("\n")) {
    const row = ROW.exec(line);
    if (row?.[1] !== undefined) {
      rows.push({ name: row[1], group });
    } else if (HEADING.test(line)) {
      group = line.trim();
    }
  }
  return rows;
}

/**
 * The listing rows must be exactly the expected skills, one row each, every
 * one under the expected group heading, and none for the internal template
 * skill. Mentions inside descriptions count for nothing, in either direction.
 */
export function checkListing(
  expected: readonly string[],
  groupTitle: string,
  templateName: string,
  output: string,
): void {
  const expectedNames = new Set(expected);
  const listedGroups = new Map<string, string>();
  for (const row of listingRows(output)) {
    if (row.name === templateName) {
      fail(`internal template skill '${templateName}' leaked into the CLI listing:\n${output}`);
    }
    if (!expectedNames.has(row.name)) {
      fail(`unexpected skill row '${row.name}' in the CLI listing:\n${output}`);
    }
    if (listedGroups.has(row.name)) {
      fail(`duplicate listing row for skill '${row.name}':\n${output}`);
    }
    listedGroups.set(row.name, row.group);
  }
  for (const name of expected) {
    const group = listedGroups.get(name);
    if (group === undefined) {
      fail(`skill '${name}' missing from the CLI listing rows:\n${output}`);
    }
    if (group !== groupTitle) {
      fail(`skill '${name}' listed under '${group}', not '${groupTitle}':\n${output}`);
    }
  }
}
