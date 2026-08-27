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
 * After linking, installs of skills this repo no longer ships are pruned:
 * symlinks in ~/.agents/skills that point into this repo's skills/ but no
 * longer name a current skill, installed copies that the npx skills lockfile
 * (~/.agents/.skill-lock.json) attributes to this repo, and per-agent
 * pointers (e.g. ~/.claude/skills/<name>) left behind by those removals.
 * Skills from other repos are never touched; a copy that cannot be
 * attributed is kept and reported instead of guessed at.
 *
 * Usage: bun scripts/link-agents.ts [--dry-run | --add]
 * `--dry-run` reports every link and prune without changing anything.
 * `--add` first runs `npx skills add . --global` interactively (its UI wires
 * the per-agent pointers but overwrites the canonical symlinks with copies),
 * then re-links automatically once it exits successfully. The install is
 * always global (user-level) and never passes --copy, so per-agent
 * directories keep symlinking into ~/.agents/skills.
 * Revert: re-run `npx skills add . --all` (the CLI overwrites the symlinks
 * with fresh copies).
 */

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  fail,
  isRecord,
  loadJsonObject,
  loadRootManifest,
  ROOT,
  rel,
  runChecks,
  SKILLS_DIR,
  skillDirs,
} from "./lib.ts";

export interface LinkAction {
  readonly skill: string;
  readonly kind: "linked" | "already-linked" | "created";
}

export interface PruneAction {
  readonly path: string;
  readonly kind: "pruned" | "would-prune" | "kept";
  readonly reason: string;
}

/**
 * What the npx skills lockfile says about an installed skill's origin.
 * "unknown" covers entries with missing or conflicting source identity;
 * nothing is ever deleted on "unknown".
 */
export type LockVerdict = "ours" | "foreign" | "unknown";

export interface PruneOptions {
  /** This repo's skills/ directory; symlink targets under it are ours. */
  readonly repoSkillsDir: string;
  /** Basenames of the skills the repo currently ships. */
  readonly currentSkills: ReadonlySet<string>;
  /** The canonical install directory (~/.agents/skills). */
  readonly agentsSkillsDir: string;
  /** Per-agent pointer directories to sweep (e.g. ~/.claude/skills). */
  readonly agentSkillDirs: readonly string[];
  /** Lockfile verdict per installed skill name; absent means not in the lockfile. */
  readonly lockAttribution: ReadonlyMap<string, LockVerdict>;
  /** Called as each action happens, so removals are reported even if a later step throws. */
  readonly onAction?: (action: PruneAction) => void;
  readonly dryRun?: boolean;
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

/**
 * Remove stale installs attributable to this repo: canonical entries in
 * agentsSkillsDir for skills the repo no longer ships, then per-agent
 * pointers left dangling by those removals. Everything else - other repos'
 * skills, unattributable copies - is left alone. Mutates nothing when
 * dryRun is true (actions report "would-prune" instead of "pruned").
 */
export function pruneStaleSkills(options: PruneOptions): PruneAction[] {
  const { repoSkillsDir, currentSkills, agentsSkillsDir, agentSkillDirs, lockAttribution } =
    options;
  const dryRun = options.dryRun ?? false;
  const pruneKind = dryRun ? "would-prune" : "pruned";
  const repoForms = pathForms(repoSkillsDir);
  const agentsForms = pathForms(agentsSkillsDir);

  const actions: PruneAction[] = [];
  const record = (action: PruneAction): void => {
    actions.push(action);
    options.onAction?.(action);
  };
  const prunedNames = new Set<string>();

  for (const name of readdirSync(agentsSkillsDir).sort()) {
    if (currentSkills.has(name)) continue; // linkSkills owns current skills
    const entry = join(agentsSkillsDir, name);
    const stat = lstatSync(entry);

    if (stat.isSymbolicLink()) {
      const target = canonicalTarget(resolve(agentsSkillsDir, readlinkSync(entry)));
      if (!isUnder(target, repoForms)) continue; // another repo's symlink: never touch
      const targetExists = statSync(target, { throwIfNoEntry: false }) !== undefined;
      const reason = targetExists
        ? `symlink into this repo, but "${name}" is not a current skill`
        : `dangling symlink into this repo (${target} no longer exists)`;
      if (!dryRun) unlinkSync(entry);
      prunedNames.add(name);
      record({ path: entry, kind: pruneKind, reason });
    } else if (stat.isDirectory()) {
      const verdict = lockAttribution.get(name);
      if (verdict === "ours") {
        if (!dryRun) rmSync(entry, { recursive: true });
        prunedNames.add(name);
        record({
          path: entry,
          kind: pruneKind,
          reason: `installed copy of retired skill "${name}" (lockfile attributes it to this repo)`,
        });
      } else if (verdict === undefined) {
        record({
          path: entry,
          kind: "kept",
          reason: "copy with no lockfile entry; cannot attribute it to this repo, leaving it alone",
        });
      } else if (verdict === "unknown") {
        record({
          path: entry,
          kind: "kept",
          reason:
            "copy whose lockfile entry has missing or conflicting source identity; " +
            "cannot attribute it to this repo, leaving it alone",
        });
      }
      // "foreign": another repo's skill, skip silently.
    }
    // Plain files (e.g. .DS_Store) are not installs; skip silently.
  }

  for (const agentDir of agentSkillDirs) {
    if (!safeIsDirectory(agentDir)) continue;
    for (const name of readdirSync(agentDir).sort()) {
      const entry = join(agentDir, name);
      if (!lstatSync(entry).isSymbolicLink()) continue;
      // Classify by the raw target's parent and basename without following
      // the final hop, so dry runs and real runs agree on pointers into
      // canonical entries this run prunes. Only exact direct children of the
      // canonical directory count: a deeper path names someone else's tree.
      const rawTarget = resolve(agentDir, readlinkSync(entry));
      if (!agentsForms.includes(canonicalTarget(dirname(rawTarget)))) continue;
      const canonicalName = basename(rawTarget);
      if (currentSkills.has(canonicalName)) continue;

      if (prunedNames.has(canonicalName)) {
        if (!dryRun) unlinkSync(entry);
        record({
          path: entry,
          kind: pruneKind,
          reason: `points at the pruned canonical entry for "${canonicalName}"`,
        });
      } else if (
        lstatSync(join(agentsSkillsDir, canonicalName), { throwIfNoEntry: false }) === undefined
      ) {
        if (lockAttribution.get(canonicalName) === "ours") {
          if (!dryRun) unlinkSync(entry);
          record({
            path: entry,
            kind: pruneKind,
            reason:
              `dangling pointer to missing "${canonicalName}" ` +
              "(lockfile attributes it to this repo)",
          });
        } else if (lockAttribution.get(canonicalName) !== "foreign") {
          record({
            path: entry,
            kind: "kept",
            reason: `dangling pointer to "${canonicalName}"; cannot attribute it to this repo`,
          });
        }
        // "foreign": its owner's residue, skip silently.
      }
    }
  }
  return actions;
}

/**
 * Per-agent skill directories npx skills wires pointers into: every
 * ~/.<agent>/skills directory except the canonical ~/.agents/skills itself.
 */
export function discoverAgentSkillDirs(home: string, agentsSkillsDir: string): string[] {
  const agentsForms = pathForms(agentsSkillsDir);
  const dirs: string[] = [];
  for (const name of readdirSync(home).sort()) {
    if (!name.startsWith(".")) continue;
    const candidate = join(home, name, "skills");
    if (!safeIsDirectory(candidate)) continue;
    if (isUnder(canonicalTarget(candidate), agentsForms)) continue;
    dirs.push(candidate);
  }
  return dirs;
}

/**
 * Read the npx skills lockfile and judge, per installed skill name, whether
 * its recorded source is this repo. Deletion demands unanimity: "ours" only
 * when every recorded identity matches this repo, and any malformed identity
 * downgrades the entry to "unknown". A missing lockfile means no verdicts;
 * an unreadable one, malformed JSON, a drifted skills shape, or an
 * unsupported version fails instead of guessing.
 */
export function loadLockAttribution(
  lockfilePath: string,
  repoIds: ReadonlySet<string>,
): Map<string, LockVerdict> {
  const attribution = new Map<string, LockVerdict>();
  if (!statSync(lockfilePath, { throwIfNoEntry: false })?.isFile()) return attribution;
  const raw = loadJsonObject(lockfilePath);
  if (raw.version !== 3) {
    fail(
      `${lockfilePath}: unsupported lockfile version ${JSON.stringify(raw.version)}; ` +
        "verify the new shape before trusting it for pruning",
    );
  }
  const skills = raw.skills;
  if (!isRecord(skills)) {
    fail(`${lockfilePath}: expected a "skills" object; the lockfile format has changed`);
  }
  for (const [name, entry] of Object.entries(skills)) {
    if (!isRecord(entry)) {
      attribution.set(name, "unknown");
      continue;
    }
    const identities = [entry.source, entry.sourceUrl].filter((value) => value !== undefined);
    if (identities.some((value) => typeof value !== "string")) {
      attribution.set(name, "unknown");
      continue;
    }
    const ids = identities
      .map((value) => normalizeSourceId(value as string))
      .filter((id) => id.length > 0);
    const matches = ids.filter((id) => repoIds.has(id)).length;
    if (ids.length === 0) attribution.set(name, "unknown");
    else if (matches === ids.length) attribution.set(name, "ours");
    else if (matches === 0) attribution.set(name, "foreign");
    else attribution.set(name, "unknown"); // conflicting identities: never delete on those
  }
  return attribution;
}

/** Identifiers a lockfile entry may record for repositoryUrl: the URL itself and owner/repo. */
export function repoSourceIds(repositoryUrl: string): Set<string> {
  const ids = new Set([normalizeSourceId(repositoryUrl)]);
  const slug = /(?:github\.com)[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repositoryUrl.trim());
  if (slug?.[1]) ids.add(normalizeSourceId(slug[1]));
  return ids;
}

function normalizeSourceId(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** The comparable forms of a directory path: as given and fully resolved. */
function pathForms(dir: string): string[] {
  const literal = resolve(dir);
  const real = safeRealpath(dir);
  return real && real !== literal ? [literal, real] : [literal];
}

function isUnder(path: string, dirForms: readonly string[]): boolean {
  return dirForms.some((dir) => path === dir || path.startsWith(dir + sep));
}

/**
 * Resolve symlinks in a path even when trailing components no longer exist:
 * realpath of the nearest existing ancestor plus the missing remainder.
 */
function canonicalTarget(target: string): string {
  let prefix = target;
  let suffix = "";
  while (true) {
    const real = safeRealpath(prefix);
    if (real) return suffix === "" ? real : join(real, suffix);
    const parent = dirname(prefix);
    if (parent === prefix) return target; // no existing ancestor at all
    suffix = suffix === "" ? basename(prefix) : join(basename(prefix), suffix);
    prefix = parent;
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false; // unreadable (e.g. permissions): not sweepable
  }
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
    const repoSkillDirs = skillDirs();
    const actions = linkSkills(repoSkillDirs, agentsSkillsDir, dryRun);

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

    const repository = loadRootManifest().raw.repository;
    if (typeof repository !== "string" || repository.length === 0) {
      fail(".claude-plugin/plugin.json: repository must be a non-empty string URL");
    }
    const lockfilePath = join(dirname(agentsSkillsDir), ".skill-lock.json");
    const pruneActions = pruneStaleSkills({
      repoSkillsDir: SKILLS_DIR,
      currentSkills: new Set(repoSkillDirs.map((dir) => basename(dir))),
      agentsSkillsDir,
      agentSkillDirs: discoverAgentSkillDirs(homedir(), agentsSkillsDir),
      lockAttribution: loadLockAttribution(lockfilePath, repoSourceIds(repository)),
      // Report as it happens: a removal stays visible even if a later step throws.
      onAction: (action) => {
        if (action.kind === "kept") {
          console.log(`notice: kept ${action.path}: ${action.reason}`);
        } else if (action.kind === "would-prune") {
          console.log(`[dry-run] would prune: ${action.path} (${action.reason})`);
        } else {
          console.log(`pruned: ${action.path} (${action.reason})`);
        }
      },
      dryRun,
    });

    if (!pruneActions.some((action) => action.kind !== "kept")) {
      console.log(`${prefix}nothing to prune: no stale installs attributable to this repo`);
    }
  });
}
