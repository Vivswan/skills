// The one owner of temp fixtures in a test file: one afterAll per file
// removes everything the file made. Call tempDirs() at the file's top
// level: bun:test binds hooks to the registering file, so a module-level
// hook here would serve only its first importer.

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirs {
  /**
   * A fresh directory under the OS temp dir, or under `parent` when a case needs it elsewhere
   * (a fixture planted inside the repository to prove the launcher's git ceiling holds).
   * The prefix names the suite in a leftover's path, so keep it specific.
   */
  dir(prefix: string, parent?: string): string;
}

export function tempDirs(): TempDirs {
  const made: string[] = [];
  afterAll(() => {
    const failed: string[] = [];
    for (const dir of made.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        failed.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`temp fixtures could not be removed:\n${failed.join("\n")}`);
    }
  });
  return {
    dir(prefix: string, parent: string = tmpdir()): string {
      const dir = mkdtempSync(join(parent, prefix));
      made.push(dir);
      return dir;
    },
  };
}
