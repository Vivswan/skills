/**
 * Replace the installed copies of this repo's skills in ~/.agents/skills with
 * symlinks into the working tree, so edits here are live in every agent
 * without re-running `npx skills add .`.
 *
 * `npx skills add` copies the skill source into ~/.agents/skills/<name> (the
 * per-agent directories like ~/.claude/skills symlink to that copy, not to
 * the source). Direct source linking is an open feature request upstream
 * (vercel-labs/skills#748), so this script rewires the canonical copy.
 *
 * Usage: bun scripts/link-agents.ts [--dry-run | --add]
 * `--add` first runs `npx skills add . --global` interactively (its UI wires
 * the per-agent pointers but overwrites the canonical symlinks with copies),
 * then re-links automatically once it exits successfully. The install is
 * always global (user-level) and never passes --copy, so per-agent
 * directories keep symlinking into ~/.agents/skills.
 * Revert: re-run `npx skills add . --all` (the CLI overwrites the symlinks
 * with fresh copies).
 */

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fail, ROOT, rel, runChecks, SKILLS_DIR, skillDirs } from "./lib.ts";

export interface LinkAction {
  readonly skill: string;
  readonly kind: "linked" | "already-linked" | "created";
}

/**
 * Link each repo skill directory into agentsSkillsDir. Returns the action
 * taken per skill; mutates nothing when dryRun is true.
 */
export function linkSkills(
  repoSkillDirs: readonly string[],
  agentsSkillsDir: string,
  dryRun = false,
): LinkAction[] {
  if (!statSync(agentsSkillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`${agentsSkillsDir}: missing; run \`npx skills add .\` once before linking`);
  }

  const actions: LinkAction[] = [];
  for (const sourceDir of repoSkillDirs) {
    const skill = basename(sourceDir);
    const target = join(agentsSkillsDir, skill);
    const existing = lstatSync(target, { throwIfNoEntry: false });

    let kind: LinkAction["kind"];
    if (existing?.isSymbolicLink()) {
      if (safeRealpath(target) === realpathSync(sourceDir)) {
        actions.push({ skill, kind: "already-linked" });
        continue;
      }
      kind = "linked";
      if (!dryRun) unlinkSync(target);
    } else if (existing?.isDirectory()) {
      // Only ever delete something that looks like an installed skill copy.
      if (!statSync(join(target, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
        fail(`${target}: exists but has no SKILL.md; refusing to replace it`);
      }
      kind = "linked";
      if (!dryRun) rmSync(target, { recursive: true });
    } else if (existing) {
      fail(`${target}: exists and is neither a directory nor a symlink; refusing to replace it`);
    } else {
      kind = "created";
    }

    if (!dryRun) symlinkSync(sourceDir, target, "dir");
    actions.push({ skill, kind });
  }
  return actions;
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  runChecks(() => {
    const args = process.argv.slice(2);
    const unknown = args.filter((arg) => arg !== "--dry-run" && arg !== "--add");
    if (unknown.length > 0) fail(`unknown option(s): ${unknown.join(", ")}`);
    const dryRun = args.includes("--dry-run");
    const withAdd = args.includes("--add");
    if (withAdd && dryRun) fail("--add and --dry-run cannot be combined");

    if (withAdd) {
      const result = spawnSync("npx", ["skills", "add", ".", "--global"], {
        cwd: ROOT,
        stdio: "inherit",
      });
      if (result.error) fail(`npx skills add .: ${result.error.message}`);
      if (result.status !== 0) {
        fail(`npx skills add . exited with status ${result.status ?? "unknown"}; not linking`);
      }
    }

    const agentsSkillsDir = join(homedir(), ".agents", "skills");
    const actions = linkSkills(skillDirs(), agentsSkillsDir, dryRun);

    const prefix = dryRun ? "[dry-run] " : "";
    for (const action of actions) {
      const source = rel(join(SKILLS_DIR, action.skill));
      if (action.kind === "already-linked") {
        console.log(`${prefix}already linked: ${action.skill}`);
      } else {
        console.log(`${prefix}${action.kind}: ${action.skill} -> ${source}`);
      }
    }
    const created = actions.filter((action) => action.kind === "created");
    if (created.length > 0) {
      console.log(
        `note: ${created.map((action) => action.skill).join(", ")} had no prior install; ` +
          "per-agent directories (e.g. ~/.claude/skills) only gain pointers via " +
          "`npx skills add .`, so run that first for brand-new skills, then re-link.",
      );
    }
  });
}
