// Two skills installed side by side, the way `npx skills add --skill <name>` lays them out: each
// copied into a canonical directory and symlinked from the agent's skills directory, so a
// cross-skill import resolves from either. Without it each source's test carries its own copy of
// the layout, and the exit-2 case for a missing dependency drifts between them.

import { cpSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../scripts/lib.mts";

/** The side-by-side install `sideBySide` builds, and the one mutation a test makes to it. */
export interface SkillLayout {
  /** The canonical copies, under the real path of the temp root: bun names a script by its real path. */
  canon: string;

  /** Symlinks to the canonical copies, as the agent's skills directory holds them. */
  agent: string;

  /** An empty directory for SESSION_EVENTS_DIR, so the daemon's files stay inside the fixture. */
  runtime: string;

  /** Removes a skill's canonical copy and leaves its symlink dangling: the dependency is gone. */
  remove(skill: string): void;
}

/** The repository's `skills` copied into `<root>/canonical` and symlinked from `<root>/agent`, by name. */
export function sideBySide(root: string, skills: string[]): SkillLayout {
  const base = realpathSync(root);
  const canon = join(base, "canonical");
  mkdirSync(canon);
  for (const skill of skills) {
    cpSync(join(ROOT, "skills", skill), join(canon, skill), { recursive: true });
  }
  const agent = join(base, "agent");
  mkdirSync(agent);
  for (const skill of skills) {
    symlinkSync(join(canon, skill), join(agent, skill));
  }
  const runtime = join(base, "runtime");
  mkdirSync(runtime);
  return {
    canon,
    agent,
    runtime,
    remove(skill: string): void {
      rmSync(join(canon, skill), { recursive: true });
    },
  };
}
