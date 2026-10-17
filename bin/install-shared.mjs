// What the two install commands share: the catalog as they read it (this repository's coordinate from the plugin
// manifest, the upstream skills from the marketplace, each a git-subdir entry whose fetched folder is the skill
// itself) and the flags every `skills add` call carries. bin/install.mjs (the consumer's
// `npx -y github:Vivswan/skills`) and scripts/link-agents.mts (`bun run add`) both import it, so one edit here
// changes both. Dependency-free node, since the bin runs before anything is installed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST = new URL("../.claude-plugin/plugin.json", import.meta.url);
const MARKETPLACE = new URL("../.claude-plugin/marketplace.json", import.meta.url);

/** A catalog file that does not read, parse, or hold what the commands need; the message names the file. */
export class CatalogError extends Error {}

/**
 * @typedef {object} UpstreamSkill
 * @property {string} name the marketplace entry's name, which is the skill's install name, lowercased as the
 *   skills CLI compares names
 * @property {string} target the `skills add` target, `<owner/repo>/<path>`
 */

/** The JSON object in one catalog file. */
function loadObject(url) {
  const path = fileURLToPath(url);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CatalogError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CatalogError(`${path}: the root must be an object`);
  }
  return data;
}

/**
 * The flags with `-y` appended unless they already say yes (`-y`, `--yes`, `--all`): the skills CLI otherwise
 * asks "Proceed with installation?" before it overwrites an installed copy, and both commands run unattended.
 * @param {readonly string[]} flags
 * @returns {string[]}
 */
export function withYes(flags) {
  const yes = flags.some((flag) => flag === "-y" || flag === "--yes" || flag === "--all");
  return yes ? [...flags] : [...flags, "-y"];
}

/** This catalog as GitHub owner/repo, read from the plugin manifest's repository URL. */
export function repoCoordinate() {
  const path = fileURLToPath(MANIFEST);
  const { repository } = loadObject(MANIFEST);
  if (typeof repository !== "string")
    throw new CatalogError(`${path}: repository must be a URL string`);
  if (!URL.canParse(repository)) {
    throw new CatalogError(`${path}: repository is not a URL: ${repository}`);
  }
  return new URL(repository).pathname.replace(/^\/|\.git$/g, "");
}

/**
 * The upstream skills, in marketplace order.
 * @returns {UpstreamSkill[]}
 */
export function upstreamSkills() {
  const path = fileURLToPath(MARKETPLACE);
  const { plugins } = loadObject(MARKETPLACE);
  if (!Array.isArray(plugins)) throw new CatalogError(`${path}: plugins must be an array`);
  return plugins
    .filter((plugin) => plugin.source?.source === "git-subdir")
    .map(({ name, source }) => {
      if (typeof source.url !== "string" || typeof source.path !== "string") {
        throw new CatalogError(
          `${path}: plugin '${name}' git-subdir source needs url and path strings`,
        );
      }
      return { name: String(name).toLowerCase(), target: `${source.url}/${source.path}` };
    });
}
