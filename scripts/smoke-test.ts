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
 *     README skill sections and bug-form dropdown options kept in exact
 *     correspondence with the skill folders (stale and missing both fail)
 *   - author, license, and homepage copies disagreeing with their canonical
 *     .claude-plugin/plugin.json fields
 *   - self-guarding of the placeholder markers against template/ rewording
 *   - skill-content cross-references: companion review criteria, the pinned
 *     Wikipedia revision, grep terms vs the word list, the reviewer preamble
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
    if (!path.endsWith(".md") && !path.endsWith(".json")) continue;
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

// Bijection between README's Available Skills sections and skill folders:
// a '### <name>' section whose folder is gone is stale documentation, and a
// missing section (or an emptied skills area) fails just as loudly. Only
// kebab-case headings count as skill sections, mirroring the dropdown
// guard's filter, so prose subheadings are left alone.
function checkReadmeSectionsMatchFolders(skillNames: ReadonlySet<string>): void {
  const readme = readTextFile(join(ROOT, "README.md"));
  const heading = "\n## Available Skills\n";
  const start = readme.indexOf(heading);
  if (start === -1) fail("README.md: missing the '## Available Skills' section");
  const body = readme.slice(start + heading.length);
  const end = body.search(/^## /m);
  const skillsArea = end === -1 ? body : body.slice(0, end);
  const sections = new Set<string>();
  for (const match of skillsArea.matchAll(/^### (.*)$/gm)) {
    const name = (match[1] ?? "").trim();
    if (KEBAB_CASE.test(name)) sections.add(name);
  }
  for (const name of sections) {
    if (!skillNames.has(name)) {
      fail(
        `README.md: '### ${name}' in the Available Skills section has no matching` +
          ` skills/${name}/ folder -- remove the stale section or restore the folder`,
      );
    }
  }
  for (const name of skillNames) {
    if (!sections.has(name)) {
      fail(`README.md: the Available Skills section is missing a '### ${name}' section`);
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

// rubber-duck-review folds companion skills' '## Review Criteria' sections
// into its reviewer prompt; every skill it names must still publish that
// heading, and no-invalid-states must stay wired in both directions.
function checkCompanionReviewCriteria(): void {
  const skillMd = join(SKILLS_DIR, "rubber-duck-review", "SKILL.md");
  requireFile(skillMd);
  const text = readFileSync(skillMd, "utf-8");
  const anchor = "add its name here:";
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex === -1) {
    fail(`${rel(skillMd)}: missing the companion-skill list anchor '${anchor}'`);
  }
  const companions: string[] = [];
  for (const line of text
    .slice(anchorIndex + anchor.length)
    .split("\n")
    .slice(1)) {
    // The companion names are the indented list nested under the anchor
    // bullet; the next outer bullet (column 0) or heading ends it, blank
    // lines within a loose list are skipped, and an indented item that is
    // not a backticked skill name is a malformed entry, not a terminator.
    if (line.trim() === "") continue;
    if (!/^\s+-/.test(line)) break;
    const item = /^\s*-\s*`([a-z0-9-]+)`\s*$/.exec(line);
    if (item === null) {
      fail(
        `${rel(skillMd)}: malformed companion-skill list item ${JSON.stringify(line.trim())}` +
          " -- expected a backticked skill name",
      );
    }
    companions.push(item[1] ?? "");
  }
  if (companions.length === 0) {
    fail(`${rel(skillMd)}: companion-skill list under '${anchor}' is empty or unparseable`);
  }
  if (!companions.includes("no-invalid-states")) {
    fail(`${rel(skillMd)}: companion-skill list no longer names 'no-invalid-states'`);
  }
  for (const name of companions) {
    const companionMd = join(SKILLS_DIR, name, "SKILL.md");
    requireFile(companionMd);
    if (!/^## Review Criteria\s*$/m.test(readFileSync(companionMd, "utf-8"))) {
      fail(
        `${rel(companionMd)}: missing the '## Review Criteria' section that` +
          " rubber-duck-review expands into its reviewer prompt",
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
  checkReadmeSectionsMatchFolders(skillNames);
  checkIssueTemplateOptionsMatchFolders(skillNames);
  checkAuthorIdentity(marketplace, manifest, codexManifests, skillFrontmatters);
  checkLicenseIdentity(manifest, codexManifests, skillFrontmatters);
  checkHomepageIdentity(marketplace, manifest, codexManifests);
  checkPlaceholderMarkersStillInTemplate();
  checkCompanionReviewCriteria();
  checkPinnedSnapshotRevision();
  checkGrepTermsCoveredByWordList();
  checkReviewerPreamble();

  console.log(`Smoke test passed (${dirs.length} skill(s) checked).`);
}

runChecks(main);
