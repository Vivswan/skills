#!/usr/bin/env bun
/**
 * Fleet sweep: a worktree where a git reading fails yields an ok:false row, never a row of zeros,
 * and a broken sweep is a loud control line, never a quiet fleet. Processes are attributed by lsof
 * cwd, never by argv, which a shell pipeline or a wrapper can misreport.
 *
 * The command line, the output lines, and the exit codes are USAGE below; `--help` prints it.
 * The readings themselves live in scripts/fleet/, shared with the fleet-events daemon source.
 */

import { resolve } from "node:path";
import {
  controlFailureReason,
  discoverWorktrees,
  resolveBaseRef,
  resolveDefaultRef,
  type WorktreeRow,
  worktreeRow,
} from "./fleet/git.mts";
import { attributeProcesses } from "./fleet/processes.mts";
import { transcriptReport } from "./fleet/transcript-tail.mts";

function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

const USAGE = [
  "usage: sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]",
  "  --base <ref>         aheadBehind against this committish (e.g. origin/develop) instead of origin's default branch",
  "  --transcripts <dir>  add one liveness line over the agent-*.jsonl transcripts in the directory",
  "prints: one JSON line each, in this order, each only when its condition holds",
  '  {"control":"FAILED","reason":...}          the sweep itself is broken',
  '  {"lsof":{"ok":false,"error":...}}          process attribution is down: no lsof, a timeout or signal, exit 2 and above, or no records on exit 0 (rows carry processes:[])',
  '  {"lsof":{"ok":true,"degraded":true,...}}   lsof exited 1 with no records, answering for no process (rows carry processes:[]); exit 1 with records is a complete reading, no line',
  '  {"defaultRef":{"ok":false,"error":...}}    origin\'s default branch is unresolvable (rows carry aheadBehind:null)',
  '  {"baseRef":{"ok":false,"error":...}}       the --base ref is unresolvable or ambiguous (same, never a fallback)',
  '  {"worktree":...,"ok":true,...}             one per worktree: branch, headSha, aheadBehind {ahead, behind}, treeFileCount,',
  "                                             dirtyCount, untrackedCount, newestDirtyMtime, statusHash, processes [{pid, command, state}]",
  '  {"worktree":...,"ok":false,"error":...}    vanished dir, git failure, or readings that moved mid-row',
  '  {"transcripts":{...}}                      only with --transcripts: mtime, sizeBytes, lastEventAgeSeconds,',
  "                                             lastEventType per agent",
  "exits: 0 the sweep ran (ok:false rows included); 1 control failure; 2 usage error",
].join("\n");

function usage(): number {
  console.error(USAGE);
  return 2;
}

/**
 * Returns the process exit code; the caller assigns process.exitCode and the
 * process ends on its own once stdio drains. process.exit() after emitting
 * rows would discard still-buffered piped stdout on a large fleet - the
 * report would be silently truncated exactly when it matters most.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return 0;
  }
  let repoRoot: string | null = null;
  let transcriptsDir: string | null = null;
  let baseRefArg: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--base") {
      const value = args[++i];
      // A refname can never start with "-", so a "-"-prefixed value is a
      // missing value with the NEXT option consumed by mistake ("--base
      // --transcripts"): a usage error, not a baseRef diagnostic.
      if (value === undefined || value.startsWith("-")) return usage();
      baseRefArg = value;
    } else if (arg === "--transcripts") {
      const value = args[++i];
      if (value === undefined) return usage();
      transcriptsDir = resolve(value);
    } else if (arg.startsWith("-")) {
      return usage();
    } else if (repoRoot === null) {
      repoRoot = resolve(arg);
    } else {
      return usage();
    }
  }
  if (repoRoot === null) return usage();

  const worktrees = await discoverWorktrees(repoRoot);
  if (!worktrees.ok) {
    emit({ control: "FAILED", reason: worktrees.reason });
    return 1;
  }
  const { processesByWorktree, lsofLine } = await attributeProcesses(worktrees.paths);

  const base =
    baseRefArg === null
      ? await resolveDefaultRef(repoRoot)
      : await resolveBaseRef(repoRoot, baseRefArg);
  const rows: WorktreeRow[] = [];
  for (const worktreePath of worktrees.paths) {
    rows.push(
      await worktreeRow(
        worktreePath,
        base.ref === null ? null : base.sha,
        processesByWorktree.get(worktreePath) ?? [],
      ),
    );
  }

  // Positive control: the first porcelain entry is the main checkout. An
  // impossible control row means the instrument is broken - report that,
  // never a quiet fleet.
  const controlFailure = controlFailureReason(rows[0] as WorktreeRow);
  if (controlFailure !== null) emit({ control: "FAILED", reason: controlFailure });

  if (lsofLine !== null) emit(lsofLine);
  if (base.ref === null) {
    emit(
      baseRefArg === null
        ? { defaultRef: { ok: false, error: base.error } }
        : { baseRef: { ok: false, error: base.error } },
    );
  }
  for (const row of rows) emit(row);
  if (transcriptsDir !== null) emit(transcriptReport(transcriptsDir));
  return controlFailure === null ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
