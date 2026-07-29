#!/usr/bin/env bun

/**
 * Consistency checks for the skills collection. Complements
 * scripts/validate-skills.ts (per-file structure) by catching drift across
 * files that still passes structural validation:
 *
 *   - template placeholders left behind in a published skill
 *   - version fields anywhere but marketplace.json metadata.version, and the
 *     release-please wiring that keeps that single source updated
 *   - catalog drift: a skill folder missing from the root plugin manifest, a
 *     marketplace entry disagreeing with the plugin manifest, or a strict:false
 *     entry that would make Claude Code refuse to load the plugin
 *   - README.md missing a section for a published skill
 *   - files named metadata.json inside a skill (npx skills drops them at install)
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Marketplace, RootManifest } from "./lib";
import {
  fail,
  isRecord,
  loadJsonObject,
  loadMarketplace,
  loadRootManifest,
  parseFrontmatter,
  ROOT,
  rel,
  runChecks,
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

function checkSingleSourceVersion(skillDir: string, codex: CodexManifest): void {
  if ("version" in codex.plugin) {
    fail(
      `${rel(codex.path)}: unexpected 'version' field -- the single source of truth is` +
        " marketplace.json metadata.version (see AGENTS.md > Releases)",
    );
  }

  const skillMd = join(skillDir, "SKILL.md");
  const frontmatter = parseFrontmatter(skillMd);
  const metadata = frontmatter.metadata;
  if ("version" in frontmatter || (isRecord(metadata) && "version" in metadata)) {
    fail(
      `${rel(skillMd)}: unexpected version in frontmatter -- the single source of truth is` +
        " marketplace.json metadata.version",
    );
  }
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
    !Array.isArray(keywords) ||
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

  const releaseManifest = loadJsonObject(join(ROOT, ".release-please-manifest.json"));
  const released = releaseManifest["."];
  if (released !== version) {
    fail(
      `.release-please-manifest.json version ${JSON.stringify(released)} does not match` +
        ` marketplace.json metadata.version ${JSON.stringify(version)}`,
    );
  }

  // release-please only keeps metadata.version current because the config
  // lists marketplace.json as an extra-file; fail loudly if that wiring is lost.
  const config = loadJsonObject(join(ROOT, "release-please-config.json"));
  const packages = config.packages;
  const rootPackage = isRecord(packages) ? packages["."] : undefined;
  const extraFiles = isRecord(rootPackage) ? rootPackage["extra-files"] : undefined;
  const wired =
    Array.isArray(extraFiles) &&
    extraFiles.some(
      (entry) =>
        isRecord(entry) &&
        entry.type === "json" &&
        entry.path === ".claude-plugin/marketplace.json" &&
        entry.jsonpath === "$.metadata.version",
    );
  if (!wired) {
    fail(
      "release-please-config.json: packages['.'].extra-files no longer updates" +
        " .claude-plugin/marketplace.json $.metadata.version",
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

function checkCatalogCoverage(manifest: RootManifest): void {
  const listed = new Set(manifest.skills.map((skillPath) => join(ROOT, skillPath)));
  for (const skillDir of skillDirs()) {
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

function checkReadmeCoverage(): void {
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  for (const skillDir of skillDirs()) {
    const name = basename(skillDir);
    if (!new RegExp(`^### ${name}\\s*$`, "m").test(readme)) {
      fail(`README.md: missing a '### ${name}' section for ${rel(skillDir)}`);
    }
  }
}

// The bug-report form offers a per-skill dropdown; keep it in step with the
// published skills so reporters can always pick the affected one.
function checkIssueTemplateCoverage(): void {
  const bugForm = join(ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.yml");
  if (!existsSync(bugForm)) return;
  const options = readFileSync(bugForm, "utf-8")
    .split("\n")
    .map((line) => line.trim());
  for (const skillDir of skillDirs()) {
    const name = basename(skillDir);
    if (!options.includes(`- ${name}`)) {
      fail(`.github/ISSUE_TEMPLATE/bug_report.yml: skill dropdown is missing '${name}'`);
    }
  }
}

function main(): void {
  const marketplace = loadMarketplace();
  const manifest = loadRootManifest();

  checkCatalogVersion(marketplace);
  checkRootManifestVersion(manifest);
  checkCatalogCoverage(manifest);
  checkMarketplaceAgainstManifest(marketplace, manifest);
  checkReadmeCoverage();
  checkIssueTemplateCoverage();

  const dirs = skillDirs();
  for (const skillDir of dirs) {
    checkNoPlaceholders(skillDir);
    checkNoInstallDroppedFiles(skillDir);
    const codex = loadCodexManifest(skillDir);
    checkSingleSourceVersion(skillDir, codex);
    checkManifestConventions(skillDir, codex);
  }

  console.log(`Smoke test passed (${dirs.length} skill(s) checked).`);
}

runChecks(main);
