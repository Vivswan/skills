// The table of registries check-name.mts reads. Adding a registry is adding one entry to
// REGISTRIES: its column, its control row, the TSV header, and `--list-registries` follow from
// the table. The readers live in readers.mts; the gaps between requests to one registry are here.

import type { Cell, Claimed, Io } from "../../core/cells.mts";
import { type Note, sayAsSpelled } from "../say.mts";
import { cratesQueue, typosquat } from "../typosquat.mts";
import {
  arxiv,
  bluesky,
  DNS_TAKEN_CONTROL,
  dockerHub,
  domain,
  GITHUB_STARS_TAKEN,
  githubRepo,
  githubUser,
  homebrew,
  huggingFace,
  lookup404,
  mavenCentral,
  urban,
  WIKTIONARY_FLAG,
  wiktionary,
} from "./readers.mts";

export type Registry = {
  kind: "registry";
  /** The column name, and the id `--registries` selects by. */
  id: string;
  label: string;
  /** A name known to be taken there: the row that proves the column reads before a free is trusted. */
  takenControl: string;
  /** What the control must read; any taken cell unless the column exists to see something finer. */
  controlHolds?: (cell: Cell) => boolean;
  /** Runs on every name whatever `--registries` selects: the page's gates read these columns. */
  gate?: true;
  lookup: (io: Io, name: string, claimed: Claimed) => Promise<Cell>;
};

/** One column per top-level domain the run asks for, each its own registry. */
export type DomainFamily = {
  kind: "domains";
  /** The id pattern, for `--list-registries`; each generated column is `dns-<tld>`. */
  id: string;
  label: string;
  takenControl: string;
  forTld: (tld: string) => Registry;
};

/** A column that reads the name itself and answers a note: no registry, so no control. */
export type NoteColumn = {
  kind: "note";
  id: string;
  label: string;
  gate?: true;
  lookup: (io: Io, name: string) => Promise<Note>;
};

export type Column = Registry | NoteColumn;

export type RegistryEntry = Registry | DomainFamily | NoteColumn;

export const ARXIV_GAP_MS = 3_000;
/** GitHub's search limit is 30 a minute with a token and 10 without. */
export const GITHUB_SEARCH_GAP_MS = 2_000;
export const GITHUB_SEARCH_GAP_ANONYMOUS_MS = 6_000;
/** crates.io's crawler policy: one request a second. */
export const CRATES_GAP_MS = 1_000;

function packageRegistry(
  id: string,
  label: string,
  takenControl: string,
  detail: string,
  url: (lower: string) => string,
): Registry {
  return {
    kind: "registry",
    id,
    label,
    takenControl,
    lookup: (io, name) => lookup404(io, url(name.toLowerCase()), detail),
  };
}

/** The taken controls are names that were taken on the day each entry was written; a registry that
 * drops one shows up as a failed instrument, and the entry gets a new control. */
export const REGISTRIES: readonly RegistryEntry[] = [
  packageRegistry(
    "pypi",
    "PyPI package",
    "requests",
    "pypi package",
    (lower) => `https://pypi.org/pypi/${lower}/json`,
  ),
  packageRegistry(
    "npm",
    "npm package",
    "react",
    "npm package",
    (lower) => `https://registry.npmjs.org/${lower}`,
  ),
  {
    kind: "registry",
    id: "crates",
    label: "crates.io crate",
    takenControl: "serde",
    // One request a second to crates.io, the typosquat ranking's pages in the same line.
    lookup: (io, name) =>
      cratesQueue(io.cratesGapMs, () =>
        lookup404(io, `https://crates.io/api/v1/crates/${name.toLowerCase()}`, "crate"),
      ),
  },
  {
    kind: "registry",
    id: "homebrew",
    label: "Homebrew formula or cask, aliases and old names included",
    // wget: a formula in the index on 2026-10-12.
    takenControl: "wget",
    lookup: homebrew,
  },
  {
    kind: "registry",
    id: "docker",
    label: "Docker Hub user or organization",
    // library: the official images organization, read 308 on 2026-10-12.
    takenControl: "library",
    lookup: dockerHub,
  },
  {
    kind: "registry",
    id: "maven",
    label: "Maven Central artifact id",
    // junit: 31 artifacts on 2026-10-12.
    takenControl: "junit",
    lookup: mavenCentral,
  },
  {
    kind: "registry",
    id: "hf",
    label: "Hugging Face user or organization",
    takenControl: "google",
    lookup: huggingFace,
  },
  {
    kind: "registry",
    id: "github-user",
    label: "GitHub handle",
    takenControl: "torvalds",
    lookup: githubUser,
  },
  {
    kind: "registry",
    id: "github-repo",
    label: `GitHub repository with ${GITHUB_STARS_TAKEN}+ stars`,
    takenControl: "linux",
    lookup: githubRepo,
  },
  {
    kind: "registry",
    id: "bluesky",
    label: "Bluesky handle under bsky.social",
    // jay.bsky.social: resolved on 2026-10-12.
    takenControl: "jay",
    lookup: bluesky,
  },
  {
    kind: "registry",
    id: "arxiv",
    label: "arXiv paper title",
    takenControl: "transformer",
    lookup: arxiv,
  },
  {
    kind: "domains",
    id: "dns-<tld>",
    label: "domain that resolves",
    takenControl: DNS_TAKEN_CONTROL,
    forTld: (tld) => ({
      kind: "registry",
      id: `dns-${tld}`,
      label: `${tld} domain that resolves`,
      takenControl: DNS_TAKEN_CONTROL,
      lookup: (io, name) => domain(io, name, tld),
    }),
  },
  {
    kind: "registry",
    id: "wiktionary",
    gate: true,
    label: "Wiktionary word, any language, offensive senses flagged",
    // The control word's offensive senses are what the column exists to see, so a label-less
    // reading of it is a failed instrument too.
    takenControl: "pajero",
    controlHolds: (cell) => cell.status === "taken" && cell.detail.startsWith(WIKTIONARY_FLAG),
    lookup: wiktionary,
  },
  {
    kind: "registry",
    id: "urban",
    gate: true,
    label: "Urban Dictionary exact entry",
    takenControl: "yeet",
    lookup: urban,
  },
  {
    kind: "registry",
    id: "typosquat",
    gate: true,
    label: "one edit from a popular package on PyPI, npm, or crates",
    // regex, popular on all three registries, with its last letter changed: a list that misses
    // it is a failed instrument, where a control on one list would pass with the other two blind.
    takenControl: "regez",
    controlHolds: (cell) =>
      cell.status === "taken" &&
      ["pypi", "npm", "crates"].every((registry) =>
        new RegExp(` on (?:un)?claimed ${registry} \\(`).test(cell.detail),
      ),
    lookup: typosquat,
  },
  {
    kind: "note",
    id: "say",
    gate: true,
    label:
      "said as spelled: syllables, hard letters, doubled letters, clusters, two readings, spoken digits",
    lookup: async (_io, name) => sayAsSpelled(name),
  },
];
