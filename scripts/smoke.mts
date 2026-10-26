#!/usr/bin/env bun

/**
 * Consistency checks for THIS catalog. The validate-skills action (`bun run validate`) is the
 * per-folder baseline any skills repository can call; everything here is either specific to this
 * catalog or drift ACROSS files that still passes structural validation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Frontmatter, Marketplace, RootManifest } from "./lib.mts";
import {
  errorMessage,
  fail,
  isRecord,
  isUnknownArray,
  KEBAB_CASE,
  loadJson,
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
} from "./lib.mts";
import {
  checkDescriptionTriggerForm,
  checkExplicitInvocationPairing,
  checkMarketplacePluginVersionBan,
  checkReadmeExplicitUpstreams,
  checkReadmeInvocationGrouping,
  checkReadmeMermaidGraph,
  checkReadmeSkillList,
  checkSkillDependencies,
  checkSkillScripts,
  ensureBuiltTemplate,
  SCRIPT_EXTENSIONS,
  SEMVER,
  type UpstreamSkill,
} from "./smoke-checks.mts";

// Strings that should only ever appear in template/, never in a published skill.
const PLACEHOLDER_MARKERS = ["Replace with", "Replace this", "template-skill", "Template Skill"];

// The component-declaring plugin.json fields; a marketplace entry with strict:false beside any of them fails to load.
const COMPONENT_FIELDS = ["skills", "commands", "agents", "hooks", "mcpServers", "lspServers"];

// Marketplace-entry fields with no counterpart in the plugin manifest, so exempt from the entry-vs-manifest equality check.
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

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

interface SkillTree {
  readonly manifestPaths: string[];
  readonly nodeModulesPaths: string[];
  readonly lockfilePaths: string[];
  readonly scriptPaths: string[];
}

// statSync follows links, so a linked package.json or script is judged as the file it points at and a dangling
// link fails instead of vanishing from the walk; node_modules is recorded for the gate, never entered, and .build
// holds the gitignored bundles a run left behind.
function walkSkillTree(dir: string, tree: SkillTree): SkillTree {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.name === "node_modules") {
      tree.nodeModulesPaths.push(full);
      continue;
    }
    if (entry.name === ".build") continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch (error) {
      fail(`${rel(full)}: cannot stat (${errorMessage(error)})`);
    }
    if (stat.isDirectory()) walkSkillTree(full, tree);
    else if (entry.name === "package.json") tree.manifestPaths.push(full);
    else if (LOCKFILES.has(entry.name)) tree.lockfilePaths.push(full);
    else if (SCRIPT_EXTENSIONS.includes(extname(entry.name))) tree.scriptPaths.push(full);
  }
  return tree;
}

function checkDependencies(
  skillDir: string,
  rootDevDependencies: Record<string, unknown>,
  buildBlock: string,
): void {
  const tree = walkSkillTree(skillDir, {
    manifestPaths: [],
    nodeModulesPaths: [],
    lockfilePaths: [],
    scriptPaths: [],
  });
  const manifestPath = join(skillDir, "package.json");
  const declared = checkSkillDependencies({
    skillPath: rel(skillDir),
    manifestPaths: tree.manifestPaths.map(rel),
    nodeModulesPaths: tree.nodeModulesPaths.map(rel),
    lockfilePaths: tree.lockfilePaths.map(rel),
    manifest: existsSync(manifestPath) ? loadJsonObject(manifestPath) : undefined,
    rootDevDependencies,
  });
  checkSkillScripts(
    tree.scriptPaths.map((path) => ({ path: rel(path), text: readTextFile(path) })),
    { skillPath: rel(skillDir), declared, buildBlock },
  );
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
        " marketplace.json metadata.version (see docs/authoring.md > Validation Checklist)",
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
  if (plugin.name !== folder) fail(`${rel(path)}: name does not match folder '${folder}'`);
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
        " marketplace.json metadata.version (see docs/authoring.md > Validation Checklist)",
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
  // This repo publishes itself: the plugin named like plugin.json resolves to the repo root and is what marketplace
  // installs and the CLI grouping key on, so it must be there once. Every other entry is an upstream skill.
  const roots = marketplace.plugins.filter((plugin) => plugin.name === manifest.name);
  const [plugin] = roots;
  if (roots.length !== 1 || plugin === undefined) {
    fail(
      `${rel(marketplace.path)}: exactly one plugin must publish the repository root, named` +
        ` '${manifest.name}' like .claude-plugin/plugin.json`,
    );
  }
  if (plugin.source !== "./") {
    fail(`${rel(marketplace.path)}: plugin '${manifest.name}' source must be "./"`);
  }
  // strict defaults to true (plugin.json is the authority). strict:false
  // alongside a component-declaring plugin.json is a load-time conflict.
  if (plugin.strict === false && COMPONENT_FIELDS.some((field) => field in manifest.raw)) {
    fail(
      `.claude-plugin/marketplace.json: plugin '${manifest.name}' sets strict:false while` +
        " .claude-plugin/plugin.json declares components -- Claude Code refuses to load this",
    );
  }

  // Any manifest field repeated on the marketplace entry must agree with the
  // manifest, otherwise the two files drift apart silently.
  for (const [key, value] of Object.entries(plugin)) {
    if (MARKETPLACE_ONLY_FIELDS.has(key) || !(key in manifest.raw)) continue;
    if (JSON.stringify(value) !== JSON.stringify(manifest.raw[key])) {
      fail(
        `.claude-plugin/marketplace.json: plugin '${manifest.name}' field '${key}' disagrees` +
          " with .claude-plugin/plugin.json -- keep them identical or drop the duplicate",
      );
    }
  }
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** An upstream entry's git-subdir source: the GitHub owner/repo and the skill folder inside it, pinned to nothing. */
function upstreamSource(
  where: string,
  source: unknown,
): { readonly url: string; readonly path: string } {
  if (!isRecord(source) || source.source !== "git-subdir") {
    fail(
      `${where}: source must be a git-subdir object -- only the root plugin is published from this repository`,
    );
  }
  if (typeof source.url !== "string" || !GITHUB_REPO.test(source.url)) {
    fail(`${where}: source.url must be the upstream as GitHub owner/repo`);
  }
  if (typeof source.path !== "string" || !/^[^/](.*[^/])?$/.test(source.path)) {
    fail(
      `${where}: source.path must be the skill folder, repository-relative, without a leading or trailing slash`,
    );
  }
  if ("sha" in source || "ref" in source) {
    fail(
      `${where}: carries a sha or ref -- the upstream skills follow their default branch, so the entry pins nothing`,
    );
  }
  return { url: source.url, path: source.path };
}

/** Whether the entry's metadata marks the skill explicit-invocation-only; the install commands read nothing else of it. */
function upstreamExplicitOnly(where: string, metadata: unknown): boolean {
  if (metadata !== undefined && !isRecord(metadata)) {
    fail(`${where}: metadata must be an object`);
  }
  const explicitOnly = metadata?.["disable-model-invocation"];
  if (explicitOnly !== undefined && explicitOnly !== true) {
    fail(
      `${where}: metadata["disable-model-invocation"] is true or absent -- the install commands read nothing else`,
    );
  }
  return explicitOnly === true;
}

/**
 * Every marketplace entry other than the root plugin publishes one skill of another repository through a git-subdir
 * source: the fetched folder carries no plugin.json, so the entry is the manifest and the folder itself is the skill.
 * The entries carry no sha and no ref, so each skill follows its upstream's default branch, and nothing of the
 * upstream is copied into this repository.
 */
function checkUpstreamPlugins(
  marketplace: Marketplace,
  manifest: RootManifest,
  skillNames: ReadonlySet<string>,
): UpstreamSkill[] {
  const skills: UpstreamSkill[] = [];
  for (const plugin of marketplace.plugins) {
    if (plugin.name === manifest.name) continue;
    const where = `${rel(marketplace.path)}: plugin '${String(plugin.name)}'`;
    if (typeof plugin.name !== "string" || !KEBAB_CASE.test(plugin.name)) {
      fail(`${where}: name must be kebab-case`);
    }
    if (skillNames.has(plugin.name) || skills.some((skill) => skill.name === plugin.name)) {
      fail(`${where}: the name is taken by another skill of this catalog -- one name, one skill`);
    }
    const source = upstreamSource(where, plugin.source);
    if (JSON.stringify(plugin.skills) !== JSON.stringify(["./"])) {
      fail(`${where}: skills must be ["./"] -- the fetched folder is the skill itself`);
    }
    if (typeof plugin.description !== "string" || plugin.description.trim() === "") {
      fail(
        `${where}: needs a description -- before install, users see nothing else of a git-subdir entry`,
      );
    }
    const explicitOnly = upstreamExplicitOnly(where, plugin.metadata);
    skills.push({ name: plugin.name, repo: source.url, path: source.path, explicitOnly });
  }
  return skills;
}

// The two hand-kept skill lists (the manifest's skills[] and the bug form's dropdown) stay
// alphabetical, so a new skill has exactly one place to go in each.
function requireSorted(displayPath: string, what: string, names: readonly string[]): void {
  for (let i = 1; i < names.length; i++) {
    const name = names[i] as string;
    const previous = names[i - 1] as string;
    if (name < previous) {
      fail(
        `${displayPath}: ${what} '${name}' sorts before '${previous}' -- keep the list alphabetical`,
      );
    }
  }
}

// Reverse of checkCatalogCoverage: a skills[] entry whose folder is gone
// would otherwise sit in the manifest forever.
function checkManifestEntriesHaveFolders(
  manifest: RootManifest,
  skillNames: ReadonlySet<string>,
): void {
  requireSorted(
    rel(manifest.path),
    "skills entry",
    manifest.skills.map((entry) => basename(entry)),
  );
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
  const named = options.filter(
    (option): option is string => typeof option === "string" && KEBAB_CASE.test(option),
  );
  requireSorted(rel(bugForm), "skill dropdown option", named);
  const offered = new Set(named);
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

interface Author {
  readonly name: string;
  readonly email: string;
}

/** The author every other copy must match: .claude-plugin/plugin.json's. */
function canonicalAuthor(manifest: RootManifest): Author {
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
  return { name: authorName, email: authorEmail };
}

function checkCodexAuthors(codexManifests: readonly CodexManifest[], author: Author): void {
  for (const codex of codexManifests) {
    const codexAuthor = isRecord(codex.plugin.author) ? codex.plugin.author : undefined;
    if (
      codexAuthor === undefined ||
      codexAuthor.name !== author.name ||
      codexAuthor.email !== author.email
    ) {
      fail(`${rel(codex.path)}: author name/email must match .claude-plugin/plugin.json author`);
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
  const author = canonicalAuthor(manifest);
  const shortName = author.name.trim().split(/\s+/)[0] ?? "";

  const owner = isRecord(marketplace.raw.owner) ? marketplace.raw.owner : undefined;
  if (owner === undefined || owner.name !== author.name || owner.email !== author.email) {
    fail(
      `${rel(marketplace.path)}: owner name/email must match the` +
        " .claude-plugin/plugin.json author",
    );
  }

  checkCodexAuthors(codexManifests, author);

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
    .find((line) => line.includes("Copyright") && line.includes(author.name));
  if (copyright === undefined) {
    fail(`LICENSE.md: copyright line must name '${author.name}'`);
  }
}

const LICENSE_DEFERRAL = "SEE LICENSE IN LICENSE.md";
const LICENSE_NAME = "Individual and Small Organization License";
const LICENSE_HEADING = new RegExp(`^# ${LICENSE_NAME} \\d+\\.\\d+\\.\\d+$`, "m");

// `npx skills add --skill <name>` copies just the skill folder, so the
// LICENSE.md the manifests refer to must travel inside each skill;
// template/ seeds the next skill with its copy.
function checkLicenseCopies(rootLicense: string): void {
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
}

function checkReadmeLicenseSection(readme: string): void {
  const licenseHeading = "\n## License\n";
  const headingIndex = readme.indexOf(licenseHeading);
  if (headingIndex === -1) fail("README.md: missing the '## License' section");
  const afterHeading = readme.slice(headingIndex + licenseHeading.length);
  const nextHeading = afterHeading.search(/^## /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  if (!section.includes(LICENSE_NAME)) {
    fail(`README.md: License section must mention ${LICENSE_NAME}`);
  }
}

// Every manifest and SKILL.md frontmatter defers to LICENSE.md (npm's "SEE
// LICENSE IN <file>" convention): copies stay in lockstep with the root plugin
// manifest, README and LICENSE.md name the same license, the version is LICENSE.md's alone.
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

  // template/ stays out of the frontmatter loop above (skillFrontmatters
  // holds only published skills), but its license field seeds every future
  // skill, so pin it here.
  const templateSkill = join(ROOT, "template", "SKILL.md");
  if (parseFrontmatter(templateSkill).license !== license) {
    fail(`${rel(templateSkill)}: frontmatter license must be '${license}'`);
  }

  const rootLicense = readTextFile(join(ROOT, "LICENSE.md"));
  checkLicenseCopies(rootLicense);
  checkReadmeLicenseSection(readTextFile(join(ROOT, "README.md")));

  // The version lives in LICENSE.md alone (the fleet sync bumps it), so the
  // README names the license without a version and the heading must carry one.
  if (!LICENSE_HEADING.test(rootLicense)) {
    fail(`LICENSE.md: must carry the heading '# ${LICENSE_NAME} <version>'`);
  }
}

function checkCodexHomepage(codex: CodexManifest, homepage: string): void {
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

  for (const codex of codexManifests) checkCodexHomepage(codex, homepage);
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

// template/ seeds every new skill, so it carries every file the layout
// requires, and metadata.internal keeps it out of `npx skills add` listings:
// if that ever goes missing, the placeholder skill ships to consumers.
function checkTemplate(skillMd: SkillFrontmatter): void {
  const templateDir = join(ROOT, "template");
  requireFile(join(templateDir, "README.md"));
  requireFile(join(templateDir, ".codex-plugin", "plugin.json"));
  requireFile(join(templateDir, "agents", "openai.yaml"));
  requireFile(join(templateDir, ".mcp.json.example"));
  const metadata = skillMd.frontmatter.metadata;
  if (!isRecord(metadata) || metadata.internal !== true) {
    fail(`${rel(skillMd.path)}: metadata.internal must be true`);
  }
  loadJson(join(templateDir, ".mcp.json.example"));
}

// Guard the placeholder-leak detector itself: if template/ stops containing
// one of the marker strings (or the marker list is emptied), the leak
// detector for published skills has silently gone stale.
function checkPlaceholderMarkersStillInTemplate(): void {
  if (PLACEHOLDER_MARKERS.length === 0) {
    fail(
      "scripts/smoke.mts: PLACEHOLDER_MARKERS is empty -- the placeholder" +
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
          " template file -- update PLACEHOLDER_MARKERS in scripts/smoke.mts to match",
      );
    }
  }
}

// rubber-duck-review's launcher names the page of every installed skill of
// this collection that declares '## Review Criteria' in the reviewer prompt,
// no registry. Guard both halves: the SKILL.md must still state that rule, and
// every declared section must actually contain criteria (an empty section
// silently contributes nothing). Context-scoped criteria use a different
// heading (e.g. '## Orchestration Review Criteria') and are exempt.
function checkReviewCriteriaAutoDiscovery(dirs: readonly string[]): void {
  const skillMd = join(SKILLS_DIR, "rubber-duck-review", "SKILL.md");
  requireFile(skillMd);
  const anchor =
    "naming the page of every installed skill of this collection that declares `## Review Criteria`";
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

// The index past the escape pair or bracket class opening at `at`, or `at` itself for any other character: what a
// '|' or a parenthesis inside it must not count as. An unclosed class runs to the end of the pattern, as in grep.
function opaqueEnd(pattern: string, at: number): number {
  if (pattern[at] === "\\") return Math.min(at + 2, pattern.length);
  if (pattern[at] !== "[") return at;

  let i = at + 1;
  while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, pattern.length);
}

// Split a POSIX ERE on top-level '|', ignoring '|' inside groups and classes.
function splitAlternation(pattern: string): string[] {
  const terms: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < pattern.length) {
    const end = opaqueEnd(pattern, i);
    if (end > i) {
      current += pattern.slice(i, end);
      i = end;
      continue;
    }
    const char = pattern[i] ?? "";
    i += 1;
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

/** One atom of a grep term: the literal strings it can match, and the index past it. */
interface TermAtom {
  readonly alternatives: readonly string[];
  readonly end: number;
}

// The branches of the group opening at `start` and closing at `end`; an empty branch would match everything,
// which no word-list entry can stand for.
function groupBranches(term: string, start: number, end: number, sourceRel: string): string[] {
  const branches = term.slice(start + 1, end).split("|");
  for (const branch of branches) {
    if (branch.trim() === "") {
      fail(`${sourceRel}: empty alternation branch inside a group in grep term '${term}'`);
    }
  }
  return branches;
}

// The atom at `at`: a '\x' escape, a '[x-y]' class, one level of '(a|b)' group, or a literal character. A group's
// branches expand through expandTermCandidates below, so the two functions recurse into each other.
function termAtom(term: string, at: number, sourceRel: string): TermAtom {
  const char = term[at] ?? "";
  if (char === "\\") return { alternatives: [term[at + 1] ?? ""], end: at + 2 };

  if (char === "[") {
    const end = term.indexOf("]", at + 1);
    if (end === -1) fail(`${sourceRel}: unbalanced character class in grep term '${term}'`);
    // The word list documents tokens like '[web:' without spelling out every
    // class member, so a class also counts as matched when its surrounding
    // literals appear ("" member).
    return { alternatives: [...expandClass(term.slice(at + 1, end)), ""], end: end + 1 };
  }

  if (char === "(") {
    const end = term.indexOf(")", at + 1);
    if (end === -1) fail(`${sourceRel}: unbalanced group in grep term '${term}'`);
    const branches = groupBranches(term, at, end, sourceRel);
    const alternatives = branches.flatMap((branch) => expandTermCandidates(branch, sourceRel));
    return { alternatives, end: end + 1 };
  }

  return { alternatives: [char], end: at + 1 };
}

// Expand one alternation term into the literal strings it can match,
// resolving '\x' escapes, one level of '(a|b)' groups, and '[x-y]' classes.
// sourceRel names the file the pattern came from in failure messages.
function expandTermCandidates(term: string, sourceRel: string): string[] {
  let results = [""];
  let i = 0;
  while (i < term.length) {
    const atom = termAtom(term, i, sourceRel);
    results = results.flatMap((prefix) => atom.alternatives.map((tail) => prefix + tail));
    i = atom.end;
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
// extract the canonical copy from the backticked span in SKILL.md (step 3's
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

/** The checks of one published skill, and the two files of it the catalog-wide checks read afterwards. */
function checkPublishedSkill(
  skillDir: string,
  rootDevDependencies: Record<string, unknown>,
  buildBlock: string,
): { codex: CodexManifest; skillMd: SkillFrontmatter } {
  requireFile(join(skillDir, "README.md"));
  checkNoPlaceholders(skillDir);
  checkNoInstallDroppedFiles(skillDir);
  checkDependencies(skillDir, rootDevDependencies, buildBlock);
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
  return { codex, skillMd };
}

function main(): void {
  for (const name of ["README.md", "AGENTS.md"]) requireFile(join(ROOT, name));
  const marketplace = loadMarketplace();
  const manifest = loadRootManifest();
  const dirs = skillDirs();
  const skillNames: ReadonlySet<string> = new Set(dirs.map((dir) => basename(dir)));

  checkCatalogVersion(marketplace);
  checkMarketplacePluginVersionBan(rel(marketplace.path), marketplace.plugins);
  checkRootManifestVersion(manifest);
  checkCatalogCoverage(manifest, dirs);
  checkMarketplaceAgainstManifest(marketplace, manifest);
  const upstream = checkUpstreamPlugins(marketplace, manifest, skillNames);
  const allNames: ReadonlySet<string> = new Set([...skillNames, ...upstream.map((s) => s.name)]);

  const rootPackage = loadJsonObject(join(ROOT, "package.json"));
  const rootDevDependencies = isRecord(rootPackage.devDependencies)
    ? rootPackage.devDependencies
    : {};
  const buildBlock = ensureBuiltTemplate(readTextFile(join(ROOT, "docs", "authoring.md")));
  if (!readTextFile(join(ROOT, ".gitignore")).split("\n").includes(".build/")) {
    fail(
      ".gitignore: missing the .build/ line; a skill script's bundle is never committed (docs/authoring.md > Dependencies)",
    );
  }
  const codexManifests: CodexManifest[] = [];
  const skillFrontmatters: SkillFrontmatter[] = [];
  for (const skillDir of dirs) {
    const { codex, skillMd } = checkPublishedSkill(skillDir, rootDevDependencies, buildBlock);
    codexManifests.push(codex);
    skillFrontmatters.push(skillMd);
  }
  // template/ keeps a codex manifest and a SKILL.md too; the identity guards
  // and both halves of the version ban cover the template, even though it is
  // not a published skill. Its frontmatter pre-fills metadata.author (so the
  // copy step cannot forget it) and is held to the canonical author below,
  // but it stays out of skillFrontmatters: the README and interface checks
  // must not demand entries for the template.
  const templateCodex = loadCodexManifest(join(ROOT, "template"));
  const templateSkillMd = loadSkillFrontmatter(join(ROOT, "template"));
  checkCodexManifestVersionBan(templateCodex);
  checkFrontmatterVersionBan(templateSkillMd);
  codexManifests.push(templateCodex);

  checkManifestEntriesHaveFolders(manifest, skillNames);
  const readmeText = readTextFile(join(ROOT, "README.md"));
  checkReadmeSkillList(readmeText, skillNames, upstream);
  checkReadmeExplicitUpstreams(readmeText, upstream);
  checkReadmeMermaidGraph(readmeText, allNames, upstream);
  // The upstream skills carry their own frontmatter, which this repository does not hold, so the invocation
  // grouping covers this repository's own skills only.
  const groupingEntries = skillFrontmatters.map(({ path, frontmatter }) => ({
    name: basename(dirname(path)),
    disabled: frontmatter["disable-model-invocation"] === true,
  }));
  checkReadmeInvocationGrouping(readmeText, groupingEntries);
  checkIssueTemplateOptionsMatchFolders(skillNames);
  // The metadata.author loop is the only consumer of the frontmatter list in
  // checkAuthorIdentity, so appending the template holds its pre-filled
  // author to the canonical one without joining any other per-skill check.
  checkAuthorIdentity(marketplace, manifest, codexManifests, [
    ...skillFrontmatters,
    templateSkillMd,
  ]);
  checkLicenseIdentity(manifest, codexManifests, skillFrontmatters);
  checkHomepageIdentity(marketplace, manifest, codexManifests);
  checkTemplate(templateSkillMd);
  checkPlaceholderMarkersStillInTemplate();
  checkReviewCriteriaAutoDiscovery(dirs);
  checkPinnedSnapshotRevision();
  checkGrepTermsCoveredByWordList();
  checkReviewerPreamble();

  console.log(`Smoke test passed (${dirs.length} skill(s), ${upstream.length} upstream, checked).`);
}

runChecks(main);
