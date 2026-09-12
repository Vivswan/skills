#!/usr/bin/env bun
// Dependency-free (Bun + node builtins), so the action needs no install step; docs/validate-skills.md ("What each
// mode checks") is the user-facing contract. A link can point outside the checkout, so what ships would not be what was
// validated: symlinks are rejected anywhere on a validated path, ancestors included.
//   the one exception: a marketplace plugin's `source` may resolve through links while its physical path stays inside the repository

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Claude Code rejects skills whose frontmatter exceeds these limits.
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Thrown by fail() and collected per unit by the callers, so one broken file cannot hide another's diagnosis. */
export class CheckFailure extends Error {}

export function fail(message: string): never {
  throw new CheckFailure(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(errors: string[], run: () => void): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof CheckFailure)) throw error;
    errors.push(error.message);
  }
}

/** lstat that treats a missing path as undefined (never follows links, so
 *  the symlink policy above can see them). */
function lstatOf(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

/** The symlink-free check for a lexically-contained path, in one physical
 *  comparison instead of a component walk: realpath(resolved) must equal
 *  realpath(root) + the lexical relative path, so a symlink at ANY
 *  component (a linked ancestor like lib/ under skills_dir=lib/skills, or
 *  the leaf) is caught. An unresolvable path is "missing" only after an
 *  lstat walk proves every existing ancestor is symlink-free: a dangling
 *  ancestor link must not read as an absent starter dir. Returns the error,
 *  or undefined when clean or plain-missing (existence is the caller's). */
export function symlinkFreeError(root: string, resolved: string, what: string): string | undefined {
  let physical: string;
  try {
    physical = realpathSync(resolved);
  } catch {
    for (let at = resolved; at.length > root.length; at = dirname(at)) {
      if (lstatOf(at)?.isSymbolicLink()) {
        return (
          `${what}: ${relative(root, at)} is a symlink (dangling or diverted); symlinks ` +
          "are rejected on validated paths (a link can point outside the checkout, so " +
          "what ships would not be what was validated)"
        );
      }
    }
    return undefined;
  }
  const expected = join(realpathSync(root), relative(root, resolved));
  if (physical !== expected) {
    // Case-insensitive filesystems (macOS default) resolve a case-only
    // difference to the on-disk casing; that is not a symlink, so name it
    // honestly.
    if (physical.toLowerCase() === expected.toLowerCase()) {
      return `${what}: path casing differs from the on-disk casing (${physical}); match it exactly`;
    }
    return (
      `${what}: resolves through a symlink to ${physical}; symlinks are rejected ` +
      "on validated paths (a link can point outside the checkout, so what ships " +
      "would not be what was validated)"
    );
  }
  return undefined;
}

export function loadJson(path: string, where: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    fail(`${where}: cannot read file (${errorMessage(error)})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${where}: invalid JSON (${errorMessage(error)})`);
  }
}

export function loadJsonObject(path: string, where: string): Record<string, unknown> {
  const data = loadJson(path, where);
  if (!isRecord(data)) fail(`${where}: root must be an object`);
  return data;
}

export function parseFrontmatter(path: string, where: string): Record<string, unknown> {
  let text: string;
  try {
    // A checkout with autocrlf writes CRLF; Claude Code loads such a SKILL.md, so the markers match either ending.
    text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  } catch (error) {
    fail(`${where}: cannot read file (${errorMessage(error)})`);
  }
  if (!text.startsWith("---\n")) fail(`${where}: missing YAML frontmatter start`);
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) fail(`${where}: missing YAML frontmatter end`);
  let data: unknown;
  try {
    data = Bun.YAML.parse(text.slice(4, end));
  } catch (error) {
    fail(`${where}: invalid YAML frontmatter (${errorMessage(error)})`);
  }
  if (!isRecord(data)) fail(`${where}: frontmatter must be a YAML mapping`);
  return data;
}

export interface PluginManifest {
  readonly name: string;
  readonly skills: readonly string[];
}

export function loadPluginManifest(path: string, where: string): PluginManifest {
  const raw = loadJsonObject(path, where);
  const name = raw.name;
  if (typeof name !== "string" || !KEBAB_CASE.test(name)) {
    fail(`${where}: name ${JSON.stringify(name)} must be kebab-case`);
  }
  const skills = raw.skills;
  if (!Array.isArray(skills)) {
    fail(
      `${where}: skills must be an array of skill directory paths (empty until the repo publishes one)`,
    );
  }
  const paths: string[] = [];
  for (const skillPath of skills) {
    if (typeof skillPath !== "string") fail(`${where}: skill paths must be strings`);
    paths.push(skillPath);
  }
  return { name, skills: paths };
}

/** resolve() collapses ../ segments before the containment check, so a traversing or out-of-tree path cannot bypass
 *  the per-folder validation. Shared by both manifests, so plugin.json and marketplace.json confine paths identically. */
export function checkSkillPath(
  where: string,
  skillPath: string,
  root: string,
  skillsRoot: string,
  skillsDir: string,
): void {
  const resolved = resolve(root, skillPath);
  if (dirname(resolved) !== skillsRoot) {
    fail(`${where}: skill path ${skillPath} must be a direct child of ${skillsDir}/`);
  }
  if (lstatOf(resolved)?.isSymbolicLink()) {
    fail(`${where}: skill path ${skillPath} is a symlink; publish the real directory`);
  }
  const skillMd = lstatOf(join(resolved, "SKILL.md"));
  if (skillMd?.isSymbolicLink()) {
    fail(`${where}: ${skillPath}/SKILL.md is a symlink; commit the real file`);
  }
  if (!skillMd?.isFile()) {
    fail(`${where}: referenced skill ${skillPath} has no SKILL.md`);
  }
}

/** A sub-plugin's `skills` entries are custom skill directories added to its default skills/ scan, so they resolve
 *  under the plugin's source and may sit anywhere inside it. The source may itself be an in-repo symlink (allowed
 *  for existence), but a skill path is validated content, so the walk from the repository root to SKILL.md must be
 *  symlink-free like every other validated path. */
export function checkPluginSkillPath(
  where: string,
  skillPath: string,
  root: string,
  pluginSource: string,
): void {
  const resolved = resolve(pluginSource, skillPath);
  if (!resolved.startsWith(`${pluginSource}/`)) {
    fail(`${where}: skill path ${skillPath} escapes the plugin source`);
  }
  const at = `${where}: skill path ${skillPath} (${relative(root, resolved)})`;
  const skillMd = join(resolved, "SKILL.md");
  const linkError = symlinkFreeError(root, skillMd, at);
  if (linkError) fail(linkError);
  const leaf = basename(resolved);
  if (!KEBAB_CASE.test(leaf)) fail(`${at}: skill folder name '${leaf}' must be kebab-case`);
  if (!lstatOf(skillMd)?.isFile()) fail(`${at}: has no SKILL.md`);
}

export function validateSkillDir(skillDir: string, where: string): string[] {
  const errors: string[] = [];
  const folder = basename(skillDir);
  const skillMd = join(skillDir, "SKILL.md");
  const at = `${where}/SKILL.md`;
  if (lstatOf(skillMd)?.isSymbolicLink()) {
    return [`${at}: must be a real file, not a symlink (a link can point outside the checkout)`];
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(skillMd, at);
  } catch (error) {
    if (!(error instanceof CheckFailure)) throw error;
    return [error.message];
  }
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string" || !name) {
    errors.push(`${at}: missing frontmatter name`);
  } else {
    if (name !== folder) {
      errors.push(`${at}: frontmatter name '${name}' does not match folder '${folder}'`);
    }
    if (!KEBAB_CASE.test(name)) errors.push(`${at}: name '${name}' must be kebab-case`);
    if (name.length > MAX_NAME_LENGTH) {
      errors.push(`${at}: name exceeds ${MAX_NAME_LENGTH} characters`);
    }
  }
  if (typeof description !== "string" || description.trim() === "") {
    errors.push(`${at}: missing frontmatter description`);
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`${at}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const mcpJson = join(skillDir, ".mcp.json");
  const mcpStat = lstatOf(mcpJson);
  if (mcpStat?.isSymbolicLink()) {
    errors.push(
      `${where}/.mcp.json: must be a real file, not a symlink (a link can point outside the checkout)`,
    );
  } else if (mcpStat?.isFile()) {
    collect(errors, () => void loadJson(mcpJson, `${where}/.mcp.json`));
  }
  return errors;
}

export function validateMarketplace(
  path: string,
  where: string,
  root: string,
  skillsRoot: string,
  skillsDir: string,
  rootPlugin: PluginManifest | undefined,
): string[] {
  const errors: string[] = [];
  let plugins: unknown[] = [];
  collect(errors, () => {
    const raw = loadJsonObject(path, where);
    const name = raw.name;
    if (typeof name !== "string" || !KEBAB_CASE.test(name)) {
      fail(`${where}: name ${JSON.stringify(name)} must be kebab-case`);
    }
    if (!Array.isArray(raw.plugins) || raw.plugins.length === 0) {
      fail(`${where}: missing plugins array`);
    }
    plugins = raw.plugins;
  });
  for (const [index, plugin] of plugins.entries()) {
    collect(errors, () => {
      if (!isRecord(plugin)) fail(`${where}: plugins[${index}] must be an object`);
      const name = plugin.name;
      if (typeof name !== "string" || !KEBAB_CASE.test(name)) {
        fail(`${where}: plugin name ${JSON.stringify(name)} must be kebab-case`);
      }
      const source = plugin.source;
      if (typeof source !== "string" || source === "") {
        fail(`${where}: plugin '${name}' needs a source path (the starter seeds "./")`);
      }
      const resolvedSource = resolve(root, source);
      if (resolvedSource !== root && !resolvedSource.startsWith(`${root}/`)) {
        fail(`${where}: plugin '${name}' source ${source} escapes the repository`);
      }
      // statSync (following links) for existence: a source may legitimately
      // sit behind an in-repo symlink; the physical-containment check below
      // is what keeps any link from redirecting it outside the repository.
      if (
        resolvedSource !== root &&
        !statSync(resolvedSource, { throwIfNoEntry: false })?.isDirectory()
      ) {
        fail(`${where}: plugin '${name}' source ${source} is not a directory in the repository`);
      }
      const physicalRoot = realpathSync(root);
      const physicalSource = realpathSync(resolvedSource);
      if (physicalSource !== physicalRoot && !physicalSource.startsWith(`${physicalRoot}/`)) {
        fail(
          `${where}: plugin '${name}' source ${source} resolves through a symlink to ` +
            `${physicalSource}, outside the repository`,
        );
      }
      // PHYSICAL equality with the root, not lexical: a self-link source
      // ("./self-link" -> .) publishes the repository root all the same
      // and must not slip past the name-consistency check.
      if (physicalSource === physicalRoot && rootPlugin && name !== rootPlugin.name) {
        fail(
          `${where}: plugin '${name}' publishes the repository root but the plugin ` +
            `manifest names it '${rootPlugin.name}' - the two manifests must agree`,
        );
      }
      // Claude Code's marketplace schema types `skills` as string|array.
      const skills = typeof plugin.skills === "string" ? [plugin.skills] : plugin.skills;
      if (skills !== undefined) {
        if (!Array.isArray(skills)) fail(`${where}: plugin '${name}' skills must be a list`);
        // The root plugin publishes the repository's own skills directory, so its entries keep plugin.json's
        // direct-child rule; any other plugin's entries resolve under that plugin's source.
        for (const skillPath of skills) {
          if (typeof skillPath !== "string") fail(`${where}: skill paths must be strings`);
          if (resolvedSource === root) {
            checkSkillPath(where, skillPath, root, skillsRoot, skillsDir);
          } else {
            checkPluginSkillPath(`${where}: plugin '${name}'`, skillPath, root, resolvedSource);
          }
        }
      }
    });
  }
  return errors;
}

/** A missing skills dir is the starter state (nothing published yet), not an error: a manifest path pointing into it
 *  still fails its own check. */
export function skillDirs(skillsRoot: string, where: string): { dirs: string[]; errors: string[] } {
  const stat = lstatOf(skillsRoot);
  if (stat?.isSymbolicLink()) {
    return {
      dirs: [],
      errors: [
        `${where}: the skills directory must be a real directory, not a symlink ` +
          "(a link can point outside the checkout)",
      ],
    };
  }
  if (!stat?.isDirectory()) return { dirs: [], errors: [] };
  const dirs: string[] = [];
  const errors: string[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isSymbolicLink()) {
      errors.push(
        `${where}/${entry.name}: symlinked entries are not validated and must not ship; ` +
          "publish a real directory",
      );
    } else if (entry.isDirectory()) {
      dirs.push(entry.name);
    }
  }
  return { dirs, errors };
}

export function validateStructure(root: string, skillsDir: string, manifestRel: string): string[] {
  const errors: string[] = [];
  const skillsRoot = resolve(root, skillsDir);
  const manifestPath = resolve(root, manifestRel);
  let manifest: PluginManifest | undefined;
  const manifestLinkError = symlinkFreeError(root, manifestPath, manifestRel);
  if (manifestLinkError) {
    // Reading through the link would validate out-of-tree content.
    errors.push(manifestLinkError);
  } else {
    collect(errors, () => {
      manifest = loadPluginManifest(manifestPath, manifestRel);
    });
  }
  // One physical check closes every ancestor-component shape (a symlinked
  // lib/ under skills_dir=lib/skills included); nothing beneath a diverted
  // skills root is worth validating, so stop here when it fires.
  const rootLinkError = symlinkFreeError(root, skillsRoot, skillsDir);
  if (rootLinkError) {
    errors.push(rootLinkError);
    return errors;
  }
  // Absence is the one valid non-directory state (the starter publishes
  // nothing yet); anything else at the path is not a skills directory,
  // and nothing beneath it is worth validating either.
  const rootStat = lstatOf(skillsRoot);
  if (rootStat && !rootStat.isDirectory()) {
    errors.push(
      `${skillsDir}: exists but is ${rootStat.isFile() ? "a regular file" : "not a directory"}; ` +
        "the skills directory must be a directory (or absent until the repository publishes a skill)",
    );
    return errors;
  }
  for (const skillPath of manifest?.skills ?? []) {
    collect(errors, () => checkSkillPath(manifestRel, skillPath, root, skillsRoot, skillsDir));
  }
  const walked = skillDirs(skillsRoot, skillsDir);
  let walkErrors = walked.errors;
  // An existing skills directory must carry an index README.md at its
  // root, so installers browsing the directory see what the catalog
  // holds. A missing skills directory is the starter state (nothing
  // published yet), so there is nothing to index.
  if (rootStat) {
    const readmeRel = `${skillsDir}/README.md`;
    const readme = lstatOf(join(skillsRoot, "README.md"));
    if (readme?.isSymbolicLink()) {
      // One error with the right remediation: the directory walk's generic
      // symlinked-entry message says "publish a real directory", which is
      // wrong for the root README, so the file-specific message replaces it.
      walkErrors = walkErrors.filter((error) => !error.startsWith(`${readmeRel}:`));
      errors.push(
        `${readmeRel}: must be a real file, not a symlink (a link can point outside the checkout)`,
      );
    } else if (!readme?.isFile()) {
      errors.push(
        `${readmeRel}: missing; a skills directory must carry an index README.md at its root`,
      );
    }
  }
  errors.push(...walkErrors);
  for (const name of walked.dirs) {
    errors.push(...validateSkillDir(join(skillsRoot, name), `${skillsDir}/${name}`));
  }
  const marketplaceRel = join(dirname(manifestRel), "marketplace.json");
  const marketplacePath = resolve(root, marketplaceRel);
  if (lstatOf(marketplacePath)) {
    const marketplaceLinkError = symlinkFreeError(root, marketplacePath, marketplaceRel);
    if (marketplaceLinkError) {
      errors.push(marketplaceLinkError);
    } else {
      errors.push(
        ...validateMarketplace(
          marketplacePath,
          marketplaceRel,
          root,
          skillsRoot,
          skillsDir,
          manifest,
        ),
      );
    }
  }
  return errors;
}

// --- discovery mode ----------------------------------------------------------

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");

export function stripAnsi(text: string): string {
  return text.replace(CSI_SEQUENCE, "").replace(OSC_SEQUENCE, "");
}

/** Boundary match: a listing for `foo-bar` must not satisfy `foo`, and a
 *  short name like `foo` must not match inside `foo-bar`. */
export function listedInOutput(name: string, output: string): boolean {
  // A skill folder name already checked as kebab-case above; the rest of the pattern is literal.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`).test(output);
}

/** Mirrors the CLI's kebabToTitle: capitalize each dash-separated word. */
export function kebabToTitle(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** An exact version, so a CLI release cannot red discovery on a green catalog; bump by hand (`npm view skills version`). */
export const SKILLS_CLI_VERSION = "1.5.26";

const DISCOVERY_ATTEMPTS = 3;
const DISCOVERY_RETRY_DELAY_MS = 5_000;

function runDiscovery(root: string, manifestRel: string): string[] {
  const manifest = loadPluginManifest(resolve(root, manifestRel), manifestRel);
  const expected = manifest.skills.map((skillPath) => basename(skillPath));
  // Kebab-case keeps each name safe to embed in the boundary-match regex
  // (this mode runs on its own job, without structure mode before it).
  for (const name of expected) {
    if (!KEBAB_CASE.test(name))
      fail(`${manifestRel}: skill folder name '${name}' must be kebab-case`);
  }
  if (expected.length === 0) {
    console.log(`discovery: ${manifestRel} publishes no skills yet; the CLI has nothing to list.`);
    return [];
  }
  // Bounded retries: the npx download can flake on registry hiccups, and a
  // launch/exit failure says nothing about the catalog. Note npx resolves
  // node_modules/.bin first, so a local dependency named `skills` would
  // shadow the CLI.
  let proc: SpawnSyncReturns<string> | undefined;
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
    proc = spawnSync("npx", ["-y", `skills@${SKILLS_CLI_VERSION}`, "add", root, "--list"], {
      encoding: "utf-8",
      timeout: 300_000,
    });
    if (!proc.error && proc.status === 0) break;
    if (attempt < DISCOVERY_ATTEMPTS) {
      console.log(`npx skills attempt ${attempt} failed; retrying...`);
      Bun.sleepSync(DISCOVERY_RETRY_DELAY_MS);
    }
  }
  if (!proc || proc.error) {
    fail(`npx skills failed to launch: ${proc?.error?.message ?? "no attempt ran"}`);
  }
  const output = stripAnsi(`${proc.stdout ?? ""}\n${proc.stderr ?? ""}`);
  if (proc.status !== 0) {
    fail(`npx skills exited with ${proc.status} after ${DISCOVERY_ATTEMPTS} attempts:\n${output}`);
  }
  const errors: string[] = [];
  for (const name of expected) {
    if (!listedInOutput(name, output)) {
      errors.push(`skill '${name}' missing from the CLI listing:\n${output}`);
    }
  }
  // Advisory only: the heading mirrors the CLI's own private name-to-title
  // formatting, so a CLI format change must not redden every skills repo.
  const groupTitle = kebabToTitle(manifest.name);
  if (!output.includes(groupTitle)) {
    console.log(
      `notice: plugin group heading '${groupTitle}' not found in the CLI listing ` +
        "(the CLI's title formatting may have changed)",
    );
  }
  if (errors.length === 0) {
    console.log(`CLI discovery passed (${expected.length} skill(s), plugin '${manifest.name}').`);
  }
  return errors;
}

// --- entry point ---------------------------------------------------------------

function main(): number {
  const skillsDir = process.env.SKILLS_DIR || "skills";
  const manifestRel = process.env.PLUGIN_MANIFEST || ".claude-plugin/plugin.json";
  const mode = process.env.MODE || "structure";
  const root = process.cwd();

  let errors: string[];
  try {
    // The same containment the registration's skills_dir enforces fleet-wide, for
    // direct callers: a traversing or absolute input would validate (or
    // list) a tree outside the checkout.
    for (const [what, value] of [
      ["skills-dir", skillsDir],
      ["plugin-manifest", manifestRel],
    ] as const) {
      const parts = value.split("/");
      if (isAbsolute(value) || parts.includes("") || parts.includes(".") || parts.includes("..")) {
        fail(`${what} '${value}' must be a plain relative path inside the repository`);
      }
    }
    if (mode === "structure") {
      errors = validateStructure(root, skillsDir, manifestRel);
    } else if (mode === "discovery") {
      errors = runDiscovery(root, manifestRel);
    } else {
      console.error(`error: unknown mode '${mode}' (expected structure or discovery)`);
      return 2;
    }
  } catch (error) {
    if (!(error instanceof CheckFailure)) throw error;
    errors = [error.message];
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    console.error(`\n${errors.length} error(s).`);
    return 1;
  }
  if (mode === "structure") {
    const count = skillDirs(resolve(root, skillsDir), skillsDir).dirs.length;
    console.log(`Skill validation passed (${count} skill folder(s) checked).`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
