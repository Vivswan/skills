// The say column: can a reader say the name one way from its spelling? Computed from the letters
// alone, no network. The cell is a note, never free or taken, so it carries no control.

import type { Cell } from "./cells.mts";

export type Note = Extract<Cell, { status: "note" }>;

/** Vowel groups, less a final silent e ("lume" is one syllable, "table" stays two). */
export function syllables(word: string): number {
  const groups = word.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = groups > 1 && /[^aeiouy]e$/.test(word) && !/[^aeiouy]le$/.test(word);
  return Math.max(1, groups - (silentE ? 1 : 0));
}

function longestConsonantRun(word: string): string {
  return (word.match(/[^aeiouy]+/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** Spellings a reader can sound two ways: ch (chip or chaos), gh (ghost or laugh), ough, ea
 * (bead or bread), a trailing e (said or silent), and c or g before e, i, or y (soft or hard). */
function twoReadings(word: string): string[] {
  const found: string[] = [];
  if (word.includes("ough")) found.push("ough");
  if (word.includes("ch")) found.push("ch");
  // The gh inside an ough is that reading, not a second one; the gap keeps the neighbours apart.
  if (word.replaceAll("ough", " ").includes("gh")) found.push("gh");
  if (word.includes("ea")) found.push("ea");
  if (word.endsWith("e") && !/[^aeiouy]le$/.test(word)) found.push("trailing e");
  for (const match of word.matchAll(/[cg](?=[eiy])/g)) {
    found.push(`${match[0]} before ${word[(match.index ?? 0) + 1]}`);
  }
  return found;
}

export function sayAsSpelled(name: string): Note {
  const parts = name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((part) => part.length > 0);
  const word = parts.join("");
  const reasons: string[] = [];
  const hard = [...new Set(word.match(/[xqzk]/g) ?? [])];
  if (hard.length > 0) reasons.push(`hard ${hard.join(",")}`);
  const doubled = [...new Set(parts.flatMap((part) => part.match(/([a-z])\1/g) ?? []))];
  if (doubled.length > 0) reasons.push(`doubled ${doubled.join(",")}`);
  const cluster = parts
    .map(longestConsonantRun)
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  if (cluster.length >= 3) reasons.push(`cluster ${cluster}`);
  const readings = parts.flatMap(twoReadings);
  if (readings.length > 0) reasons.push(`two readings ${readings.join(",")}`);
  const count = parts.reduce((sum, part) => sum + syllables(part), 0);
  const detail = `${count}s`;
  return {
    status: "note",
    detail: reasons.length === 0 ? `ok(${detail})` : `flag(${[detail, ...reasons].join("; ")})`,
  };
}
