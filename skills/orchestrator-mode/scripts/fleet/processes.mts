// The process half of a fleet reading: every process attributed to the worktree it runs in, by
// lsof cwd and never by argv, which a shell pipeline or a wrapper can misreport.

import { existsSync, realpathSync } from "node:fs";
import { parse } from "node:path";
import { type RunResult, run } from "./git.mts";

// The instrument's own children run from the filesystem root, which no worktree holds; spawned where the caller stands, lsof (which lists itself) and ps would be attributed to that worktree.
const FILESYSTEM_ROOT = parse(process.cwd()).root;

export interface ProcessRow {
  pid: number;
  command: string;
  state: string;
}

export interface CwdEntry {
  pid: number;
  command: string;
  cwd: string;
}

/**
 * Parse `lsof -a -d cwd -F pcn0` field output: NUL-terminated fields marked
 * p<pid>, c<command>, n<path>. The NUL terminator (the trailing 0 in -F) is
 * what makes a cwd path containing literal newlines one intact field instead
 * of lines that would corrupt a newline-oriented parse; lsof still inserts
 * cosmetic newlines between field sets, so each token strips leading ones.
 */
export function parseLsofFields(output: string): CwdEntry[] {
  const entries: CwdEntry[] = [];
  let pid = -1;
  let command = "";
  for (const rawToken of output.split("\0")) {
    const token = rawToken.replace(/^\n+/, "");
    if (token.startsWith("p")) {
      pid = Number.parseInt(token.slice(1), 10);
      command = "";
    } else if (token.startsWith("c")) {
      command = token.slice(1);
    } else if (token.startsWith("n") && pid > 0) {
      entries.push({ pid, command, cwd: token.slice(1) });
    }
  }
  return entries;
}

/**
 * Attribute each cwd to the LONGEST matching worktree path: this repo nests
 * worktrees inside the main checkout (.claude/worktrees/), so a plain prefix
 * match would credit every nested worker to the main checkout as well.
 */
export function attributeByCwd(
  entries: CwdEntry[],
  realPathByWorktree: Map<string, string>,
): Map<string, CwdEntry[]> {
  const attributed = new Map<string, CwdEntry[]>();
  for (const [worktree] of realPathByWorktree) attributed.set(worktree, []);
  for (const entry of entries) {
    let bestWorktree: string | null = null;
    let bestLength = -1;
    for (const [worktree, realPath] of realPathByWorktree) {
      const matches = entry.cwd === realPath || entry.cwd.startsWith(`${realPath}/`);
      if (matches && realPath.length > bestLength) {
        bestWorktree = worktree;
        bestLength = realPath.length;
      }
    }
    if (bestWorktree !== null) attributed.get(bestWorktree)?.push(entry);
  }
  return attributed;
}

/** One `ps` for all attributed pids; per-pid iteration stays in TS arrays. */
export async function processStates(pids: number[]): Promise<Map<number, string>> {
  const states = new Map<number, string>();
  if (pids.length === 0) return states;
  const result = await run("ps", ["-o", "pid=,stat=", "-p", pids.join(",")], {
    acceptStdoutOnError: true, // ps exits 1 when some pids exited mid-sweep
    cwd: FILESYSTEM_ROOT,
  });
  if (!result.ok) return states;
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)/);
    if (match) states.set(Number.parseInt(match[1] as string, 10), match[2] as string);
  }
  return states;
}

/** The lsof outcome a sweep reports as its own line: down, or degraded. Null: a complete reading. */
export type LsofLine =
  | { lsof: { ok: false; error: string } }
  | { lsof: { ok: true; degraded: true; note: string } }
  | null;

/**
 * What one lsof run says, from its exit code and its parsed cwd records together. lsof exits 1
 * whenever one process it scanned could not be read (another user's sandbox, a pid gone mid-scan)
 * and still prints every process that answered, so exit 1 with records is a complete reading of
 * those processes; with no records it answered for nobody, which is degraded. A missing binary, a
 * timeout, or exit 2 and above is the instrument down, and so is exit 0 with no records: this
 * process holds a cwd and is in the scanned set, so a working lsof never prints nothing.
 */
function lsofReading(result: RunResult, records: number): LsofLine {
  if (result.code === 1) {
    if (records > 0) return null;
    const note = "lsof exited 1 with no cwd records: it answered for no process";
    return { lsof: { ok: true, degraded: true, note } };
  }
  if (!result.ok) return { lsof: { ok: false, error: result.error } };
  if (result.code >= 2) {
    const detail = result.stderr.toString("utf8").trim().split("\n")[0] ?? "";
    return {
      lsof: { ok: false, error: `lsof exited ${result.code}${detail ? ` [${detail}]` : ""}` },
    };
  }
  if (records > 0) return null;

  const shape = result.stdout.length === 0 ? "empty" : "nonempty";
  return {
    lsof: { ok: false, error: `lsof exited 0 and parsed zero cwd records from ${shape} output` },
  };
}

/**
 * Every process running inside one of the worktrees, by worktree path, with its state. lsof
 * paths are symlink-resolved (macOS /var -> /private/var), so matching goes by realpath while
 * the keys stay git's own worktree paths.
 */
export async function attributeProcesses(
  worktreePaths: string[],
): Promise<{ processesByWorktree: Map<string, ProcessRow[]>; lsofLine: LsofLine }> {
  const realPathByWorktree = new Map<string, string>();
  for (const worktreePath of worktreePaths) {
    if (!existsSync(worktreePath)) continue;
    try {
      realPathByWorktree.set(worktreePath, realpathSync(worktreePath));
    } catch {
      // raced deletion between existsSync and realpathSync: row goes ok:false
    }
  }

  const lsofResult = await run("lsof", ["-a", "-d", "cwd", "-F", "pcn0"], {
    acceptStdoutOnError: true,
    cwd: FILESYSTEM_ROOT,
  });
  const entries = lsofResult.ok ? parseLsofFields(lsofResult.stdout.toString("utf8")) : [];
  const lsofLine = lsofReading(lsofResult, entries.length);
  const attributed =
    lsofLine === null ? attributeByCwd(entries, realPathByWorktree) : new Map<string, CwdEntry[]>();

  const allPids = [...attributed.values()].flat().map((entry) => entry.pid);
  const states = await processStates(allPids);
  const processesByWorktree = new Map<string, ProcessRow[]>();
  for (const [worktree, entries] of attributed) {
    processesByWorktree.set(
      worktree,
      entries.map((entry) => ({
        pid: entry.pid,
        command: entry.command,
        state: states.get(entry.pid) ?? "unknown",
      })),
    );
  }
  return { processesByWorktree, lsofLine };
}
