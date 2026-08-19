#!/usr/bin/env bun

/**
 * Consistency checks for the skills collection. Complements
 * scripts/validate-skills.ts (per-file structure) by catching drift across
 * files that still passes structural validation:
 *
 *   - template placeholders left behind in a published skill
 *   - version fields anywhere but marketplace.json metadata.version, the
 *     catalog's single source of truth
 *   - catalog drift: a skill folder missing from the root plugin manifest, a
 *     marketplace entry disagreeing with the plugin manifest, or a strict:false
 *     entry that would make Claude Code refuse to load the plugin
 *   - files named metadata.json inside a skill (npx skills drops them at install)
 *   - listing drift: plugin.json skills[] entries without a skill folder, and
 *     README skill-list entries and bug-form dropdown options kept in exact
 *     correspondence with the skill folders (stale and missing both fail)
 *   - author, license, and homepage copies disagreeing with their canonical
 *     .claude-plugin/plugin.json fields
 *   - interface drift: the SKILL.md H1 title, the codex manifest's
 *     interface.displayName, and agents/openai.yaml (when present)
 *     disagreeing on display name, short description, or brand color
 *   - explicit-invocation drift: disable-model-invocation in SKILL.md
 *     frontmatter set without agents/openai.yaml's
 *     policy.allow_implicit_invocation:false, or vice versa
 *   - descriptions that are summaries instead of "Use when ..." triggers
 *   - self-guarding of the placeholder markers against template/ rewording
 *   - skill-content cross-references: review-criteria auto-discovery (the rule
 *     stated, declared sections non-empty), the pinned Wikipedia revision,
 *     grep terms vs the word list, the reviewer preamble
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Frontmatter, Marketplace, RootManifest } from "./lib";
import {
  errorMessage,
  fail,
  isRecord,
  isUnknownArray,
  KEBAB_CASE,
  loadJsonObject,
  loadMarketplace,
  loadRootManifest,
  parseFrontmatter,
  ROOT,
  readTextFile,
  rel,
  requireFile,
  runChecks,
  SKILLS_DIR,
  skillDirs,
  walkFiles,
} from "./lib";
import {
  checkDescriptionTriggerForm,
  checkExplicitInvocationPairing,
  checkReadmeInvocationGrouping,
  checkReadmeSkillList,
} from "./smoke-checks";

// Strings that should only ever appear in template/, never in a published skill.
const PLACEHOLDER_MARKERS = ["Replace with", "Replace this", "template-skill", "Template Skill"];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// Component-declaring plugin.json fields. A marketplace entry with
// strict:false conflicts with any of these and the plugin fails to load.
const COMPONENT_FIELDS = ["skills", "commands", "agents", "hooks", "mcpServers", "lspServers"];

// Marketplace-entry fields that have no counterpart in the plugin manifest, so
// they are exempt from the entry-vs-manifest equality check.
const MARKETPLACE_ONLY_FIELDS = new Set([
  "source",
  "category",
  "tags",
  "strict",
  "relevance",
  "defaultEnabled",
]);

function checkNoPlaceholders(skillDir: string): void {
  for (const path of walkFiles(skillDir)) {
    if (!/\.(md|json|ya?ml)$/.test(path)) continue;
    const text = readFileSync(path, "utf-8");
    for (const marker of PLACEHOLDER_MARKERS) {
      if (text.includes(marker)) {
        fail(
          `${rel(path)}: leftover template placeholder ${JSON.stringify(marker)}` +
            " -- looks copied from template/ but not filled in",
        );
      }
    }
  }
}

function checkNoInstallDroppedFiles(skillDir: string): void {
  for (const path of walkFiles(skillDir)) {
    if (basename(path) === "metadata.json") {
      fail(
        `${rel(path)}: 'metadata.json' is a reserved filename that npx skills silently drops at install -- rename it`,
      );
    }
  }
}

interface CodexManifest {
  readonly path: string;
  readonly plugin: Record<string, unknown>;
}

function loadCodexManifest(skillDir: string): CodexManifest {
  const path = join(skillDir, ".codex-plugin", "plugin.json");
  return { path, plugin: loadJsonObject(path) };
}

// A published skill's SKILL.md frontmatter, parsed once in main()'s per-skill
// loop and threaded into every guard that reads it.
interface SkillFrontmatter {
  readonly path: string;
  readonly frontmatter: Frontmatter;
}

function loadSkillFrontmatter(skillDir: string): SkillFrontmatter {
  const path = join(skillDir, "SKILL.md");
  return { path, frontmatter: parseFrontmatter(path) };
}

// No codex manifest (published or template) may carry a version field; the
// single source of truth is marketplace.json metadata.version.
function checkCodexManifestVersionBan(codex: CodexManifest): void {
  if ("version" in codex.plugin) {
    fail(
      `${rel(codex.path)}: unexpected 'version' field -- the single source of truth is` +
        " marketplace.json metadata.version (see AGENTS.md > Releases)",
    );
  }
}

// No SKILL.md frontmatter (published or template) may carry a version field
// either, top-level or under metadata.
function checkFrontmatterVersionBan(skillMd: SkillFrontmatter): void {
  const { frontmatter } = skillMd;
  const metadata = frontmatter.metadata;
  if ("version" in frontmatter || (isRecord(metadata) && "version" in metadata)) {
    fail(
      `${rel(skillMd.path)}: unexpected version in frontmatter -- the single source of truth is` +
        " marketplace.json metadata.version",
    );
  }
}

function checkSingleSourceVersion(codex: CodexManifest, skillMd: SkillFrontmatter): void {
  checkCodexManifestVersionBan(codex);
  checkFrontmatterVersionBan(skillMd);
}

// Every published skill's codex manifest points its homepage at the skill's
// own folder and carries discovery keywords; skills copied from template/
// tend to miss both, so enforce the convention here.
function checkManifestConventions(skillDir: string, codex: CodexManifest): void {
  const { path, plugin } = codex;
  const folder = basename(skillDir);
  if (typeof plugin.repository !== "string") fail(`${rel(path)}: missing repository URL`);
  const expectedHomepage = `${plugin.repository}/tree/main/skills/${folder}`;
  if (plugin.homepage !== expectedHomepage) {
    fail(`${rel(path)}: homepage must be ${expectedHomepage}`);
  }
  const keywords = plugin.keywords;
  if (
    !isUnknownArray(keywords) ||
    keywords.length === 0 ||
    !keywords.every((keyword) => typeof keyword === "string" && keyword.trim() !== "")
  ) {
    fail(`${rel(path)}: keywords must be a non-empty array of non-empty strings`);
  }
}

function checkCatalogVersion(marketplace: Marketplace): void {
  const metadata = marketplace.raw.metadata;
  const version = isRecord(metadata) ? metadata.version : undefined;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    fail(
      `.claude-plugin/marketplace.json: metadata.version ${JSON.stringify(version)} is not valid semver`,
    );
  }
}

function checkRootManifestVersion(manifest: RootManifest): void {
  if ("version" in manifest.raw) {
    fail(
      ".claude-plugin/plugin.json: unexpected 'version' field -- the single source of truth is" +
        " marketplace.json metadata.version (see AGENTS.md > Releases)",
    );
  }
}

function checkCatalogCoverage(manifest: RootManifest, dirs: readonly string[]): void {
  const listed = new Set(manifest.skills.map((skillPath) => join(ROOT, skillPath)));
  for (const skillDir of dirs) {
    if (!listed.has(skillDir)) {
      fail(
        `${rel(skillDir)}: skill folder is not listed in .claude-plugin/plugin.json skills --` +
          " it would be excluded from plugin installs and CLI grouping",
      );
    }
  }
}

function checkMarketplaceAgainstManifest(marketplace: Marketplace, manifest: RootManifest): void {
  for (const plugin of marketplace.plugins) {
    // strict defaults to true (plugin.json is the authority). strict:false
    // alongside a component-declaring plugin.json is a load-time conflict.
    if (plugin.strict === false && COMPONENT_FIELDS.some((field) => field in manifest.raw)) {
      fail(
        `.claude-plugin/marketplace.json: plugin '${plugin.name}' sets strict:false while` +
          " .claude-plugin/plugin.json declares components -- Claude Code refuses to load this",
      );
    }

    // Any manifest field repeated on the marketplace entry must agree with the
    // manifest, otherwise the two files drift apart silently.
    for (const [key, value] of Object.entries(plugin)) {
      if (MARKETPLACE_ONLY_FIELDS.has(key) || !(key in manifest.raw)) continue;
      if (JSON.stringify(value) !== JSON.stringify(manifest.raw[key])) {
        fail(
          `.claude-plugin/marketplace.json: plugin '${plugin.name}' field '${key}' disagrees` +
            " with .claude-plugin/plugin.json -- keep them identical or drop the duplicate",
        );
      }
    }
  }
}

// Reverse of checkCatalogCoverage: a skills[] entry whose folder is gone
// would otherwise sit in the manifest forever.
function checkManifestEntriesHaveFolders(
  manifest: RootManifest,
  skillNames: ReadonlySet<string>,
): void {
  for (const entry of manifest.skills) {
    const name = basename(entry);
    if (entry !== `./skills/${name}`) {
      fail(`${rel(manifest.path)}: skills entry '${entry}' must be written as './skills/${name}'`);
    }
    if (!skillNames.has(name)) {
      fail(
        `${rel(manifest.path)}: skills entry '${entry}' has no matching skills/${name}/` +
          " folder -- remove the stale entry or restore the folder",
      );
    }
  }
}

// Bijection between the bug form's skill dropdown and skill folders: every
// published skill must be offered, a skill-name-shaped option whose folder is
// gone is stale, and the dropdown itself must exist. Free-form options such
// as "Not skill-specific (...)" are not kebab-case and are left alone.
function checkIssueTemplateOptionsMatchFolders(skillNames: ReadonlySet<string>): void {
  const bugForm = join(ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.yml");
  requireFile(bugForm);
  let form: unknown;
  try {
    form = Bun.YAML.parse(readFileSync(bugForm, "utf-8"));
  } catch (error) {
    fail(`${rel(bugForm)}: invalid YAML (${errorMessage(error)})`);
  }
  const body = isRecord(form) ? form.body : undefined;
  if (!isUnknownArray(body)) fail(`${rel(bugForm)}: missing form body`);
  const dropdown = body.find((entry) => isRecord(entry) && entry.id === "skill");
  if (dropdown === undefined) fail(`${rel(bugForm)}: missing the dropdown with id 'skill'`);
  const attributes =
    isRecord(dropdown) && isRecord(dropdown.attributes) ? dropdown.attributes : undefined;
  const options = attributes === undefined ? undefined : attributes.options;
  if (!isUnknownArray(options)) {
    fail(`${rel(bugForm)}: cannot find the options of the dropdown with id 'skill'`);
  }
  const offered = new Set<string>();
  for (const option of options) {
    if (typeof option === "string" && KEBAB_CASE.test(option)) offered.add(option);
  }
  for (const option of offered) {
    if (!skillNames.has(option)) {
      fail(
        `${rel(bugForm)}: skill dropdown option '${option}' has no matching` +
          ` skills/${option}/ folder -- remove the stale option or restore the folder`,
      );
    }
  }
  for (const name of skillNames) {
    if (!offered.has(name)) {
      fail(`${rel(bugForm)}: the skill dropdown is missing an option for '${name}'`);
    }
  }
}

// Every place that repeats the author's name or email must agree with the
// canonical copy in .claude-plugin/plugin.json author.
function checkAuthorIdentity(
  marketplace: Marketplace,
  manifest: RootManifest,
  codexManifests: readonly CodexManifest[],
  skillFrontmatters: readonly SkillFrontmatter[],
): void {
  const author = isRecord(manifest.raw.author) ? manifest.raw.author : undefined;
  const authorName = author === undefined ? undefined : author.name;
  const authorEmail = author === undefined ? undefined : author.email;
  if (
    typeof authorName !== "string" ||
    authorName.trim() === "" ||
    typeof authorEmail !== "string" ||
    authorEmail.trim() === ""
  ) {
    fail(`${rel(manifest.path)}: author must have non-empty string 'name' and 'email' fields`);
  }
  const shortName = authorName.trim().split(/\s+/)[0] ?? "";

  const owner = isRecord(marketplace.raw.owner) ? marketplace.raw.owner : undefined;
  if (owner === undefined || owner.name !== authorName || owner.email !== authorEmail) {
    fail(
      `${rel(marketplace.path)}: owner name/email must match the` +
        " .claude-plugin/plugin.json author",
    );
  }

  for (const codex of codexManifests) {
    const codexAuthor = isRecord(codex.plugin.author) ? codex.plugin.author : undefined;
    if (
      codexAuthor === undefined ||
      codexAuthor.name !== authorName ||
      codexAuthor.email !== authorEmail
    ) {
      fail(`${rel(codex.path)}: author name/email must match .claude-plugin/plugin.json author`);
    }
  }

  for (const { path, frontmatter } of skillFrontmatters) {
    const metadata = frontmatter.metadata;
    const skillAuthor = isRecord(metadata) ? metadata.author : undefined;
    if (skillAuthor !== shortName) {
      fail(
        `${rel(path)}: frontmatter metadata.author must be '${shortName}'` +
          " (first name of the .claude-plugin/plugin.json author)",
      );
    }
  }

  const licenseText = readTextFile(join(ROOT, "LICENSE.md"));
  const copyright = licenseText
    .split("\n")
    .find((line) => line.includes("Copyright") && line.includes(authorName));
  if (copyright === undefined) {
    fail(`LICENSE.md: copyright line must name '${authorName}'`);
  }

  const agents = readTextFile(join(ROOT, "AGENTS.md"));
  const commitRulesHeading = "### Commit rules";
  const headingIndex = agents.indexOf(commitRulesHeading);
  if (headingIndex === -1) fail("AGENTS.md: missing the '### Commit rules' section");
  const afterHeading = agents.slice(headingIndex + commitRulesHeading.length);
  const nextHeading = afterHeading.search(/^#{1,3} /m);
  const commitRules = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  if (!commitRules.includes(authorEmail)) {
    fail(`AGENTS.md: Commit rules section must state the Git author email '${authorEmail}'`);
  }
}

// Every manifest and SKILL.md frontmatter defers to the repository
// LICENSE.md file (npm's "SEE LICENSE IN <file>" convention); keep the
// copies in lockstep with the root plugin manifest, and the README and
// LICENSE.md naming the same license.
const LICENSE_DEFERRAL = "SEE LICENSE IN LICENSE.md";
const LICENSE_TITLE = "Individual and Small Organization License 1.0.0";

function checkLicenseIdentity(
  manifest: RootManifest,
  codexManifests: readonly CodexManifest[],
  skillFrontmatters: readonly SkillFrontmatter[],
): void {
  const license = manifest.raw.license;
  if (license !== LICENSE_DEFERRAL) {
    fail(`${rel(manifest.path)}: license must be '${LICENSE_DEFERRAL}'`);
  }

  const packageJson = loadJsonObject(join(ROOT, "package.json"));
  if (packageJson.license !== license) {
    fail(`package.json: license must be '${license}' like .claude-plugin/plugin.json`);
  }

  for (const codex of codexManifests) {
    if (codex.plugin.license !== license) {
      fail(`${rel(codex.path)}: license must be '${license}' like .claude-plugin/plugin.json`);
    }
  }
  for (const { path, frontmatter } of skillFrontmatters) {
    if (frontmatter.license !== license) {
      fail(`${rel(path)}: frontmatter license must be '${license}'`);
    }
  }

  // template/ is excluded from the identity checks above (its author and
  // placeholders are unfilled), but its license field seeds every future
  // skill, so pin it here.
  const templateSkill = join(ROOT, "template", "SKILL.md");
  if (parseFrontmatter(templateSkill).license !== license) {
    fail(`${rel(templateSkill)}: frontmatter license must be '${license}'`);
  }

  const rootLicense = readTextFile(join(ROOT, "LICENSE.md"));

  // `npx skills add --skill <name>` copies just the skill folder, so the
  // LICENSE.md the manifests refer to must travel inside each skill;
  // template/ seeds the next skill with its copy.
  for (const dir of [...skillDirs(), join(ROOT, "template")]) {
    const path = join(dir, "LICENSE.md");
    if (!existsSync(path) || readTextFile(path) !== rootLicense) {
      fail(`${rel(path)}: must be a byte-identical copy of the root LICENSE.md`);
    }
  }

  // The license file was renamed from LICENSE; a stale extensionless copy
  // would ship alongside the real one and contradict the manifests.
  for (const dir of [ROOT, ...skillDirs(), join(ROOT, "template")]) {
    const stale = join(dir, "LICENSE");
    if (existsSync(stale)) {
      fail(`${rel(stale)}: stale extensionless license file; LICENSE.md is the license file`);
    }
  }

  const readme = readTextFile(join(ROOT, "README.md"));
  const licenseHeading = "\n## License\n";
  const headingIndex = readme.indexOf(licenseHeading);
  if (headingIndex === -1) fail("README.md: missing the '## License' section");
  const afterHeading = readme.slice(headingIndex + licenseHeading.length);
  const nextHeading = afterHeading.search(/^## /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  if (!section.includes(LICENSE_TITLE)) {
    fail(`README.md: License section must mention ${LICENSE_TITLE}`);
  }

  if (!rootLicense.includes(LICENSE_TITLE)) {
    fail(`LICENSE.md: text must contain the literal '${LICENSE_TITLE}'`);
  }
}

// Homepage copies across the catalog. The canonical value is the root
// plugin.json homepage; each codex manifest additionally duplicates its own
// homepage into interface.websiteURL.
function checkHomepageIdentity(
  marketplace: Marketplace,
  manifest: RootManifest,
  codexManifests: readonly CodexManifest[],
): void {
  const homepage = manifest.raw.homepage;
  if (typeof homepage !== "string" || homepage === "") {
    fail(`${rel(manifest.path)}: missing homepage URL`);
  }

  const owner = isRecord(marketplace.raw.owner) ? marketplace.raw.owner : undefined;
  if (owner !== undefined && "url" in owner && owner.url !== homepage) {
    fail(`${rel(marketplace.path)}: owner.url must match the .claude-plugin/plugin.json homepage`);
  }

  for (const codex of codexManifests) {
    const codexAuthor = isRecord(codex.plugin.author) ? codex.plugin.author : undefined;
    if (codexAuthor === undefined || codexAuthor.url !== homepage) {
      fail(`${rel(codex.path)}: author.url must be ${homepage} (root plugin.json homepage)`);
    }
    const interfaceBlock = isRecord(codex.plugin.interface) ? codex.plugin.interface : undefined;
    const websiteURL = interfaceBlock === undefined ? undefined : interfaceBlock.websiteURL;
    if (typeof codex.plugin.homepage !== "string" || websiteURL !== codex.plugin.homepage) {
      fail(`${rel(codex.path)}: interface.websiteURL must equal the manifest's own homepage`);
    }
  }
}

// The SKILL.md H1 is the display-name authority; the codex manifest's
// interface.displayName must equal it, and agents/openai.yaml (required in
// every published skill) must repeat the codex manifest's display name, short
// description, and brand color exactly. openai.yaml's short_description is
// additionally held to the documented 25-64 character UI limit.
function checkInterfaceIdentity(skillDir: string, codex: CodexManifest): void {
  const codexIface = isRecord(codex.plugin.interface) ? codex.plugin.interface : undefined;
  if (codexIface === undefined) fail(`${rel(codex.path)}: missing the interface block`);

  const skillMd = join(skillDir, "SKILL.md");
  const title = /^# (.+)$/m.exec(readTextFile(skillMd))?.[1]?.trim();
  if (title === undefined || title === "") {
    fail(`${rel(skillMd)}: cannot find the '# <title>' heading`);
  }
  if (codexIface.displayName !== title) {
    fail(
      `${rel(codex.path)}: interface.displayName ${JSON.stringify(codexIface.displayName)}` +
        ` must equal the ${rel(skillMd)} H1 title ${JSON.stringify(title)}`,
    );
  }

  const openaiYaml = join(skillDir, "agents", "openai.yaml");
  if (!existsSync(openaiYaml)) {
    fail(
      `${rel(openaiYaml)}: missing -- every published skill ships agents/openai.yaml with an` +
        " interface block mirroring the codex manifest",
    );
  }
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(readTextFile(openaiYaml));
  } catch (error) {
    fail(`${rel(openaiYaml)}: invalid YAML (${errorMessage(error)})`);
  }
  const iface = isRecord(doc) && isRecord(doc.interface) ? doc.interface : undefined;
  if (iface === undefined) fail(`${rel(openaiYaml)}: missing the interface section`);
  const pairs: ReadonlyArray<[string, string]> = [
    ["display_name", "displayName"],
    ["short_description", "shortDescription"],
    ["brand_color", "brandColor"],
  ];
  for (const [yamlKey, jsonKey] of pairs) {
    if (iface[yamlKey] !== codexIface[jsonKey]) {
      fail(
        `${rel(openaiYaml)}: interface.${yamlKey} must equal interface.${jsonKey}` +
          ` in ${rel(codex.path)}`,
      );
    }
  }
  const short = iface.short_description;
  if (typeof short !== "string" || short.length < 25 || short.length > 64) {
    fail(`${rel(openaiYaml)}: interface.short_description must be 25-64 characters`);
  }
}

// Guard the placeholder-leak detector itself: if template/ stops containing
// one of the marker strings (or the marker list is emptied), the leak
// detector for published skills has silently gone stale.
function checkPlaceholderMarkersStillInTemplate(): void {
  if (PLACEHOLDER_MARKERS.length === 0) {
    fail(
      "scripts/smoke-test.ts: PLACEHOLDER_MARKERS is empty -- the placeholder" +
        " leak detector is disabled",
    );
  }
  const templateDir = join(ROOT, "template");
  if (!existsSync(templateDir)) fail("template/: missing template directory");
  const texts = walkFiles(templateDir).map((path) => readFileSync(path, "utf-8"));
  for (const marker of PLACEHOLDER_MARKERS) {
    if (!texts.some((text) => text.includes(marker))) {
      fail(
        `template/: placeholder marker ${JSON.stringify(marker)} no longer occurs in any` +
          " template file -- update PLACEHOLDER_MARKERS in scripts/smoke-test.ts to match",
      );
    }
  }
}

// rubber-duck-review auto-discovers companions: every installed skill that
// declares a '## Review Criteria' section joins the reviewer prompt, no
// registry. Guard both halves: the SKILL.md must still state that rule, and
// every declared section must actually contain criteria (an empty section
// silently contributes nothing). Context-scoped criteria use a different
// heading (e.g. '## Orchestration Review Criteria') and are exempt.
function checkReviewCriteriaAutoDiscovery(dirs: readonly string[]): void {
  const skillMd = join(SKILLS_DIR, "rubber-duck-review", "SKILL.md");
  requireFile(skillMd);
  const anchor = "for EVERY installed skill that declares a `## Review Criteria` section";
  if (!readFileSync(skillMd, "utf-8").includes(anchor)) {
    fail(
      `${rel(skillMd)}: missing the companion auto-discovery rule` +
        ` (expected the phrase ${JSON.stringify(anchor)})`,
    );
  }
  const declaring = new Set<string>();
  for (const dir of dirs) {
    const path = join(dir, "SKILL.md");
    const text = readFileSync(path, "utf-8");
    for (const match of text.matchAll(/^## Review Criteria[^\S\n]*$/gm)) {
      declaring.add(basename(dir));
      const body = text.slice((match.index ?? 0) + match[0].length);
      const nextHeading = body.search(/^## /m);
      const section = nextHeading === -1 ? body : body.slice(0, nextHeading);
      if (!/^\s*(?:[-*]|\d+\.) \S/m.test(section)) {
        fail(
          `${rel(path)}: '## Review Criteria' declares review participation but contains no` +
            " criteria bullets -- fill it in or rename the heading to a context-scoped one",
        );
      }
    }
  }
  // The named in-collection participants keep the guard from passing
  // vacuously: rubber-duck-review's SKILL.md names both as examples.
  for (const name of ["no-invalid-states", "code-standards"]) {
    if (!declaring.has(name)) {
      fail(
        `skills/${name}/SKILL.md: must declare a '## Review Criteria' section --` +
          " rubber-duck-review names it as an in-collection participant",
      );
    }
  }
}

// natural-writing pins a Wikipedia revision in two places and its SKILL.md
// says the two pins must match; enforce that instead of trusting the note.
function checkPinnedSnapshotRevision(): void {
  const skillMd = join(SKILLS_DIR, "natural-writing", "SKILL.md");
  const catalogMd = join(SKILLS_DIR, "natural-writing", "references", "signs-catalog.md");
  requireFile(skillMd);
  requireFile(catalogMd);
  const skillPin = /Snapshot last synced: (\d{4}-\d{2}-\d{2}), from page revision (\d+)/.exec(
    readFileSync(skillMd, "utf-8"),
  );
  if (skillPin === null) {
    fail(`${rel(skillMd)}: cannot find 'Snapshot last synced: <date>, from page revision <id>'`);
  }
  const catalogPin = /Snapshot synced (\d{4}-\d{2}-\d{2}) from page revision (\d+)/.exec(
    readFileSync(catalogMd, "utf-8"),
  );
  if (catalogPin === null) {
    fail(`${rel(catalogMd)}: cannot find 'Snapshot synced <date> from page revision <id>'`);
  }
  if (skillPin[1] !== catalogPin[1] || skillPin[2] !== catalogPin[2]) {
    fail(
      `${rel(skillMd)} pins revision ${skillPin[2]} synced ${skillPin[1]} but` +
        ` ${rel(catalogMd)} pins revision ${catalogPin[2]} synced ${catalogPin[1]}` +
        " -- update both places together",
    );
  }
}

// Split a POSIX ERE on top-level '|', ignoring '|' inside groups and classes.
function splitAlternation(pattern: string): string[] {
  const terms: string[] = [];
  let current = "";
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? "";
    if (char === "\\") {
      current += char + (pattern[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (inClass) {
      current += char;
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "|" && depth === 0) {
      terms.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  terms.push(current);
  return terms;
}

// Expand a character class body into its member characters ('0-9' ranges and
// literal members; a trailing '-' is literal, as in grep).
function expandClass(content: string): string[] {
  const members: string[] = [];
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i] ?? "";
    const upper = content[i + 2];
    if (content[i + 1] === "-" && upper !== undefined) {
      for (let code = char.charCodeAt(0); code <= upper.charCodeAt(0); code += 1) {
        members.push(String.fromCharCode(code));
      }
      i += 2;
      continue;
    }
    members.push(char);
  }
  return members;
}

// Expand one alternation term into the literal strings it can match,
// resolving '\x' escapes, one level of '(a|b)' groups, and '[x-y]' classes.
// sourceRel names the file the pattern came from in failure messages.
function expandTermCandidates(term: string, sourceRel: string): string[] {
  let results = [""];
  let i = 0;
  while (i < term.length) {
    const char = term[i] ?? "";
    if (char === "\\") {
      const literal = term[i + 1] ?? "";
      results = results.map((prefix) => prefix + literal);
      i += 2;
      continue;
    }
    if (char === "[") {
      const end = term.indexOf("]", i + 1);
      if (end === -1) fail(`${sourceRel}: unbalanced character class in grep term '${term}'`);
      // The word list documents tokens like '[web:' without spelling out every
      // class member, so a class also counts as matched when its surrounding
      // literals appear ("" member).
      const members = [...expandClass(term.slice(i + 1, end)), ""];
      results = results.flatMap((prefix) => members.map((member) => prefix + member));
      i = end + 1;
      continue;
    }
    if (char === "(") {
      const end = term.indexOf(")", i + 1);
      if (end === -1) fail(`${sourceRel}: unbalanced group in grep term '${term}'`);
      const branches = term.slice(i + 1, end).split("|");
      for (const branch of branches) {
        if (branch.trim() === "") {
          fail(`${sourceRel}: empty alternation branch inside a group in grep term '${term}'`);
        }
      }
      results = results.flatMap((prefix) =>
        branches.flatMap((branch) =>
          expandTermCandidates(branch, sourceRel).map((tail) => prefix + tail),
        ),
      );
      i = end + 1;
      continue;
    }
    results = results.map((prefix) => prefix + char);
    i += 1;
  }
  return results;
}

// The two self-review grep commands in natural-writing's SKILL.md must stay a
// subset of the documented word list, or the list stops explaining what the
// mechanical checks actually flag.
function checkGrepTermsCoveredByWordList(): void {
  const skillMd = join(SKILLS_DIR, "natural-writing", "SKILL.md");
  const wordsMd = join(SKILLS_DIR, "natural-writing", "references", "words-to-avoid.md");
  requireFile(skillMd);
  requireFile(wordsMd);
  const commands = [
    ...readFileSync(skillMd, "utf-8").matchAll(/^grep -i?nE '([^']*)' draft\.md$/gm),
  ];
  if (commands.length !== 2) {
    fail(
      `${rel(skillMd)}: expected exactly 2 'grep ... draft.md' self-review commands,` +
        ` found ${commands.length}`,
    );
  }
  const words = readFileSync(wordsMd, "utf-8").toLowerCase();
  for (const command of commands) {
    for (const term of splitAlternation(command[1] ?? "")) {
      if (term.trim() === "") {
        fail(
          `${rel(skillMd)}: empty alternation branch in a self-review grep pattern` +
            " -- remove the stray '|'",
        );
      }
      // A bare character class expands to its member characters here (the ""
      // expansion is filtered out), so a term must always contribute some
      // literal text we can look up in the word list.
      const candidates = expandTermCandidates(term, rel(skillMd)).filter(
        (candidate) => candidate.trim() !== "",
      );
      if (candidates.length === 0) {
        fail(
          `${rel(skillMd)}: grep term '${term}' expands to no literal text -- it cannot` +
            " be verified against the word list",
        );
      }
      const found = candidates.some((candidate) => {
        const needle = candidate.toLowerCase();
        if (words.includes(needle)) return true;
        const trimmed = needle.trim();
        return trimmed !== "" && words.includes(trimmed);
      });
      if (!found) {
        fail(
          `${rel(wordsMd)}: grep term '${term}' from the ${rel(skillMd)} self-review` +
            " commands is not in the word list -- document it there too",
        );
      }
    }
  }
}

// The read-only preamble is quoted verbatim in the skill's prompt template;
// extract the canonical copy from the backticked span in SKILL.md (step 2's
// "Always include:" bullet) so this guard tracks rewording instead of
// hardcoding a third copy.
function checkReviewerPreamble(): void {
  const skillMd = join(SKILLS_DIR, "rubber-duck-review", "SKILL.md");
  const promptMd = join(SKILLS_DIR, "rubber-duck-review", "references", "reviewer-prompt.md");
  requireFile(skillMd);
  requireFile(promptMd);
  const span = /Always include: `([^`]+)`/.exec(readFileSync(skillMd, "utf-8"));
  const preamble = span === null ? "" : (span[1] ?? "");
  if (preamble === "") {
    fail(`${rel(skillMd)}: cannot find the backticked preamble after 'Always include:'`);
  }
  if (!readFileSync(promptMd, "utf-8").includes(preamble)) {
    fail(
      `${rel(promptMd)}: must quote the read-only preamble verbatim from ${rel(skillMd)}:` +
        ` "${preamble}"`,
    );
  }
}

function main(): void {
  const marketplace = loadMarketplace();
  const manifest = loadRootManifest();
  const dirs = skillDirs();
  const skillNames: ReadonlySet<string> = new Set(dirs.map((dir) => basename(dir)));

  checkCatalogVersion(marketplace);
  checkRootManifestVersion(manifest);
  checkCatalogCoverage(manifest, dirs);
  checkMarketplaceAgainstManifest(marketplace, manifest);

  const codexManifests: CodexManifest[] = [];
  const skillFrontmatters: SkillFrontmatter[] = [];
  for (const skillDir of dirs) {
    checkNoPlaceholders(skillDir);
    checkNoInstallDroppedFiles(skillDir);
    const codex = loadCodexManifest(skillDir);
    const skillMd = loadSkillFrontmatter(skillDir);
    checkSingleSourceVersion(codex, skillMd);
    checkManifestConventions(skillDir, codex);
    checkInterfaceIdentity(skillDir, codex);
    const openaiYaml = join(skillDir, "agents", "openai.yaml");
    checkExplicitInvocationPairing({
      skillMdPath: rel(skillMd.path),
      frontmatter: skillMd.frontmatter,
      openaiYamlPath: rel(openaiYaml),
      openaiYamlText: existsSync(openaiYaml) ? readTextFile(openaiYaml) : undefined,
    });
    checkDescriptionTriggerForm(rel(skillMd.path), skillMd.frontmatter);
    codexManifests.push(codex);
    skillFrontmatters.push(skillMd);
  }
  // template/ keeps a codex manifest and a SKILL.md too; the identity guards
  // and both halves of the version ban cover the template, even though it is
  // not a published skill (its frontmatter legitimately lacks the identity
  // and license fields, so it stays out of skillFrontmatters).
  const templateCodex = loadCodexManifest(join(ROOT, "template"));
  checkCodexManifestVersionBan(templateCodex);
  checkFrontmatterVersionBan(loadSkillFrontmatter(join(ROOT, "template")));
  codexManifests.push(templateCodex);

  checkManifestEntriesHaveFolders(manifest, skillNames);
  const readmeText = readTextFile(join(ROOT, "README.md"));
  checkReadmeSkillList(readmeText, skillNames);
  checkReadmeInvocationGrouping(
    readmeText,
    skillFrontmatters.map(({ path, frontmatter }) => ({
      name: basename(dirname(path)),
      disabled: frontmatter["disable-model-invocation"] === true,
    })),
  );
  checkIssueTemplateOptionsMatchFolders(skillNames);
  checkAuthorIdentity(marketplace, manifest, codexManifests, skillFrontmatters);
  checkLicenseIdentity(manifest, codexManifests, skillFrontmatters);
  checkHomepageIdentity(marketplace, manifest, codexManifests);
  checkPlaceholderMarkersStillInTemplate();
  checkReviewCriteriaAutoDiscovery(dirs);
  checkPinnedSnapshotRevision();
  checkGrepTermsCoveredByWordList();
  checkReviewerPreamble();

  console.log(`Smoke test passed (${dirs.length} skill(s) checked).`);
}

runChecks(main);
