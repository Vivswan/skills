#!/usr/bin/env bun
/**
 * Structural validation for the skills collection: required files exist, the
 * catalog manifests parse and reference real paths, and every skill folder is
 * shaped the way installers expect.
 *
 * Consistency rules that cut across files (version drift, catalog coverage,
 * leftover placeholders) live in scripts/smoke-test.ts.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
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
  rel,
  requireFile,
  runChecks,
  SKILLS_DIR,
  skillDirs,
} from "./lib";

// Claude Code rejects skills whose frontmatter exceeds these limits.
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function validateMarketplace(): void {
  const { path, plugins } = loadMarketplace();
  for (const plugin of plugins) {
    const name = plugin.name;
    if (typeof name !== "string" || !KEBAB_CASE.test(name)) {
      fail(`${rel(path)}: plugin name ${JSON.stringify(name)} must be kebab-case`);
    }
    // This repo publishes itself: every entry must resolve to the repo root,
    // and the smoke test's entry-vs-manifest drift check relies on that.
    if (plugin.source !== "./") {
      fail(`${rel(path)}: plugin '${name}' source must be "./"`);
    }
    const skills = plugin.skills;
    if (skills !== undefined) {
      if (!isUnknownArray(skills)) fail(`${rel(path)}: plugin '${name}' skills must be a list`);
      for (const skillPath of skills) {
        if (typeof skillPath !== "string") {
          fail(`${rel(path)}: skill paths must be strings`);
        }
        if (!existsSync(join(ROOT, skillPath))) {
          fail(`${rel(path)}: missing referenced path ${skillPath}`);
        }
      }
    }
  }
}

function validateRootPluginManifest(): void {
  const { path, skills } = loadRootManifest();
  for (const skillPath of skills) {
    // Keep every published skill a direct child of skills/ so the per-folder
    // validation below cannot be bypassed by an out-of-tree or traversing
    // path (resolve() collapses any ../ segments before the containment check).
    const resolved = resolve(ROOT, skillPath);
    if (dirname(resolved) !== SKILLS_DIR) {
      fail(`${rel(path)}: skill path ${skillPath} must be a direct child of ./skills/`);
    }
    if (!existsSync(join(resolved, "SKILL.md"))) {
      fail(`${rel(path)}: referenced skill ${skillPath} has no SKILL.md`);
    }
  }
}

function validateSkillDir(skillDir: string): void {
  const skillMd = join(skillDir, "SKILL.md");
  const readme = join(skillDir, "README.md");
  const pluginJson = join(skillDir, ".codex-plugin", "plugin.json");
  const folder = basename(skillDir);

  requireFile(skillMd);
  requireFile(readme);
  requireFile(pluginJson);

  const frontmatter = parseFrontmatter(skillMd);
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string" || !name) {
    fail(`${rel(skillMd)}: missing frontmatter name`);
  }
  if (typeof description !== "string" || !description) {
    fail(`${rel(skillMd)}: missing frontmatter description`);
  }
  if (name !== folder) {
    fail(`${rel(skillMd)}: frontmatter name '${name}' does not match folder '${folder}'`);
  }
  if (!KEBAB_CASE.test(name)) fail(`${rel(skillMd)}: name '${name}' must be kebab-case`);
  if (name.length > MAX_NAME_LENGTH) {
    fail(`${rel(skillMd)}: name exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    fail(`${rel(skillMd)}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  const plugin = loadJsonObject(pluginJson);
  if (plugin.name !== folder) {
    fail(`${rel(pluginJson)}: name does not match folder '${folder}'`);
  }

  const mcpJson = join(skillDir, ".mcp.json");
  if (existsSync(mcpJson)) loadJson(mcpJson);
}

function validateTemplate(): void {
  const templateDir = join(ROOT, "template");
  requireFile(join(templateDir, "SKILL.md"));
  requireFile(join(templateDir, "README.md"));
  requireFile(join(templateDir, ".codex-plugin", "plugin.json"));
  requireFile(join(templateDir, "agents", "openai.yaml"));
  requireFile(join(templateDir, ".mcp.json.example"));

  // metadata.internal keeps template/ out of `npx skills add` listings; if it
  // ever goes missing, the placeholder skill ships to consumers.
  const frontmatter = parseFrontmatter(join(templateDir, "SKILL.md"));
  const metadata = frontmatter.metadata;
  if (!isRecord(metadata) || metadata.internal !== true) {
    fail("template/SKILL.md: metadata.internal must be true");
  }

  loadJsonObject(join(templateDir, ".codex-plugin", "plugin.json"));
  loadJson(join(templateDir, ".mcp.json.example"));
}

function main(): void {
  for (const name of ["README.md", "AGENTS.md"]) {
    requireFile(join(ROOT, name));
  }

  validateMarketplace();
  validateRootPluginManifest();
  const dirs = skillDirs();
  for (const dir of dirs) validateSkillDir(dir);
  validateTemplate();
  console.log(`Skill validation passed (${dirs.length} skill(s) checked).`);
}

runChecks(main);
