#!/usr/bin/env bun
// The fleet source: what each agent of a Claude Code session waits on, read from its transcript,
// and what landed in each worktree, delivered as transitions by the session-events daemon
// installed beside this skill. Transcript first, worktree second; judgment stays the lead's.
//
//   bun "<skill-dir>/scripts/fleet-events.mts" daemon                              # once per session, as a BACKGROUND task
//   bun "<skill-dir>/scripts/fleet-events.mts" watch session --repo /abs/repo
//   bun "<skill-dir>/scripts/fleet-events.mts" watch /abs/session-dir --quiet-after 5

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EventInput, Io, PollResult } from "../../session-events/scripts/session-events.mts";
import {
  discoverWorktrees,
  resolveBaseRef,
  resolveDefaultRef,
  type WorktreeRow,
  worktreeRow,
} from "./fleet/git.mts";
import { attributeProcesses, type ProcessRow } from "./fleet/processes.mts";
import {
  type Activity,
  displayName,
  initialTranscript,
  isStopped,
  locateSession,
  projectsRoot,
  readSidecar,
  readTranscript,
  type Sidecar,
  type Transcript,
} from "./fleet/transcripts.mts";

const INSTALL = "npx skills add Vivswan/skills -g --skill session-events";
const DEFAULT_QUIET_AFTER_MINUTES = 10;
// A worktree nobody claims is quiet after this many polls with no worker process and no change.
const QUIET_POLLS = 2;
// A lone shell parked on a worktree is presence, not work; anything else beside it (a sleep too) is alive.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"]);
const TRANSCRIPT_NAME = /^agent-([^/]+)\.jsonl$/;
const SHORT_SHA = 12;
const MINUTE_MS = 60_000;

/** One agent as the daemon remembers it: the transcript cursor and state, the sidecar, and what was seen and said. */
interface AgentEntry extends Transcript {
  path: string;
  sidecar: Sidecar | null;
  /** The situation key the last poll observed; a stillness is announced only once it is seen twice. */
  observed: string | null;
  /** The situation key last announced; null before anything was said. */
  said: string | null;
  /** The situation key the baseline poll found, never news while it holds; null once the situation first differs, and for an agent first seen later. */
  baseline: string | null;
}

/** One worktree's last reading: the head, the tree size, the activity fingerprint, and how long it has sat idle. */
interface WorktreeEntry {
  branch: string | null;
  headSha: string | null;
  treeFileCount: number | null;
  fingerprint: string | null;
  processes: { workers: number; shells: number };
  /** Polls in a row with no worker process and an unchanged fingerprint; the quiet event fires when it reaches QUIET_POLLS. */
  quietPolls: number;
}

interface Target {
  form: "session" | "dir";
  sessionFile: string;
  subagentsDir: string;
  repo: string | null;
  base: string | null;
  quietAfterMinutes: number;
  /** Polls done so far; the first is the baseline and announces nothing. */
  polls: number;
  agents: Record<string, AgentEntry>;
  lead: Transcript;
  worktrees: Record<string, WorktreeEntry>;
  /** The trouble conditions in force, by key, each with the text said when it began. */
  trouble: Record<string, string>;
}

type Situation =
  | { kind: "moving" }
  | { kind: "stopped" }
  | { kind: "tool"; id: string; tool: string; since: string }
  | { kind: "child"; id: string; name: string; since: string }
  | { kind: "jobs"; ids: string; count: number; since: string }
  | { kind: "stall"; since: string }
  | { kind: "ended"; since: string };

interface Trouble {
  text: string;
  url: string;
}

/** A read the whole poll depends on failed, so nothing this poll saw can be judged; `key` names the condition in the trouble ledger. */
class FleetReadError extends Error {
  constructor(
    readonly key: string,
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

let base: typeof import("../../session-events/scripts/session-events.mts");
try {
  base = await import("../../session-events/scripts/session-events.mts");
} catch {
  console.error(
    `the session-events skill is not installed beside this one; install it beside this skill: ${INSTALL}`,
  );
  process.exit(2);
}
const { runEvents, UsageError } = base;

function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

function minutesBetween(nowMs: number, at: string): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(at)) / MINUTE_MS));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- the target -------------------------------------------------------------------

function parseFlags(flags: string[]): {
  repo: string | null;
  base: string | null;
  quietAfterMinutes: number;
} {
  let repo: string | null = null;
  let ref: string | null = null;
  let quietAfterMinutes = DEFAULT_QUIET_AFTER_MINUTES;
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i] as string;
    const value = flags[i + 1];
    if (flag !== "--repo" && flag !== "--base" && flag !== "--quiet-after") {
      throw new UsageError(`unknown option: ${flag}`);
    }
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${flag} needs a value`);

    if (flag === "--repo") {
      if (!isAbsolute(value))
        throw new UsageError(`--repo must be an absolute path, got: ${value}`);
      repo = resolve(value);
    } else if (flag === "--base") {
      ref = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) <= 0) {
        throw new UsageError(
          `--quiet-after must be a positive whole number of minutes, got: ${value}`,
        );
      }
      quietAfterMinutes = Number(value);
    }
  }
  return { repo, base: ref, quietAfterMinutes };
}

/** `session` resolves here, in the CLI process, by the session id under the user's home; a path must be an existing absolute directory. */
function parseTarget(args: string[]): Target {
  const [text, ...flags] = args;
  const options = parseFlags(flags);

  let form: Target["form"];
  let paths: { sessionFile: string; subagentsDir: string };
  if (text === "session") {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    if (sessionId === undefined || sessionId === "") {
      throw new UsageError(
        "CLAUDE_CODE_SESSION_ID is unset: not a Claude Code session; pass the session directory instead",
      );
    }
    form = "session";
    const home = homedir();
    const found = locateSession(sessionId, home, process.cwd());
    if (found === null) {
      throw new UsageError(
        `no transcript ${sessionId}.jsonl under ${projectsRoot(home)}: CLAUDE_CODE_SESSION_ID names a session this home has not written`,
      );
    }
    paths = found;
  } else {
    const dir = text as string;
    if (!isAbsolute(dir))
      throw new UsageError(`target must be session or an absolute path, got: ${dir}`);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new UsageError(`not a directory: ${dir}`);
    }
    form = "dir";
    const sessionDir = resolve(dir);
    paths = {
      sessionFile: join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`),
      subagentsDir: join(sessionDir, "subagents"),
    };
  }

  return {
    form,
    ...paths,
    ...options,
    polls: 0,
    agents: {},
    lead: initialTranscript(),
    worktrees: {},
    trouble: {},
  };
}

// --- the agents -------------------------------------------------------------------

function agentName(agentId: string, entry: AgentEntry | undefined): string {
  return oneLine(displayName(agentId, entry?.sidecar ?? null));
}

function oldest<T extends { at: string }>(entries: Record<string, T>): [string, T] | undefined {
  let found: [string, T] | undefined;
  for (const pair of Object.entries(entries)) {
    if (found === undefined || Date.parse(pair[1].at) < Date.parse(found[1].at)) found = pair;
  }
  return found;
}

/** The fleet agent a pending Agent call spawned, joined through the child's sidecar `toolUseId`. */
function childOfCall(target: Target, toolUseId: string): string | undefined {
  return Object.keys(target.agents).find(
    (agentId) => target.agents[agentId]?.sidecar?.toolUseId === toolUseId,
  );
}

function situationOf(target: Target, agentId: string, entry: AgentEntry, nowMs: number): Situation {
  const state: Activity = entry.state;
  if (isStopped(target.lead.state, agentId, entry.sidecar?.name ?? null))
    return { kind: "stopped" };

  const quietMs = target.quietAfterMinutes * MINUTE_MS;
  if (state.lastMovedAt === null || nowMs - Date.parse(state.lastMovedAt) < quietMs) {
    return { kind: "moving" };
  }

  const call = oldest(state.pending);
  if (call !== undefined) {
    const [id, pending] = call;
    const childId = pending.tool === "Agent" ? childOfCall(target, id) : undefined;
    if (childId !== undefined) {
      return {
        kind: "child",
        id: childId,
        name: agentName(childId, target.agents[childId]),
        since: pending.at,
      };
    }
    return { kind: "tool", id, tool: pending.tool, since: pending.at };
  }

  const running = Object.fromEntries(
    Object.entries(state.children).filter(([, child]) => child.outcome === "running"),
  );
  const child = oldest(running);
  if (child !== undefined) {
    const [id, spawned] = child;
    const name =
      target.agents[id] === undefined ? (spawned.name ?? id) : agentName(id, target.agents[id]);
    return { kind: "child", id, name: oneLine(name), since: spawned.at };
  }

  const job = oldest(state.jobs);
  if (job !== undefined) {
    const ids = Object.keys(state.jobs).sort().join(",");
    return { kind: "jobs", ids, count: Object.keys(state.jobs).length, since: job[1].at };
  }

  if (state.turn === "open") return { kind: "stall", since: state.lastMovedAt };
  return { kind: "ended", since: state.lastMovedAt };
}

function situationKey(situation: Situation): string {
  switch (situation.kind) {
    case "moving":
    case "stopped":
      return situation.kind;
    case "tool":
    case "child":
      return `${situation.kind}:${situation.id}`;
    case "jobs":
      return `jobs:${situation.ids}`;
    case "stall":
    case "ended":
      return `${situation.kind}:${situation.since}`;
  }
}

function situationText(target: Target, name: string, situation: Situation, nowMs: number): string {
  switch (situation.kind) {
    case "moving":
      return `agent ${name}: moving again`;
    case "stopped":
      return `agent ${name}: stopped by the lead`;
    case "tool":
      return `agent ${name}: waiting on ${situation.tool} for ${minutesBetween(nowMs, situation.since)} min`;
    case "child": {
      const head = `agent ${name}: waiting on agent ${situation.name} for ${minutesBetween(nowMs, situation.since)} min`;
      const moved = target.agents[situation.id]?.state.lastMovedAt ?? null;
      if (moved === null) return head;
      return `${head}; ${situation.name} last moved ${minutesBetween(nowMs, moved)} min ago`;
    }
    case "jobs": {
      const jobs =
        situation.count === 1 ? "1 background job" : `${situation.count} background jobs`;
      return `agent ${name}: waiting on ${jobs} for ${minutesBetween(nowMs, situation.since)} min`;
    }
    case "stall":
      return `agent ${name}: quiet for ${minutesBetween(nowMs, situation.since)} min mid-turn, nothing pending`;
    case "ended":
      return `agent ${name}: turn ended ${minutesBetween(nowMs, situation.since)} min ago, nothing outstanding`;
  }
}

function isStillness(key: string | null): boolean {
  return key !== null && key !== "moving" && key !== "stopped";
}

/**
 * The transition to announce for one agent, or null. The baseline poll records the situation and
 * says nothing. After it, a stop and a return to movement are facts said at once; a wait, a stall,
 * or an ended turn is said once the same reading was seen on the poll before (two observations
 * before a flag), and once only while it holds.
 */
function agentTransition(
  target: Target,
  agentId: string,
  entry: AgentEntry,
  nowMs: number,
): EventInput | null {
  const situation = situationOf(target, agentId, entry, nowMs);
  const key = situationKey(situation);
  const seenBefore = entry.observed === key;
  entry.observed = key;
  if (target.polls === 0) {
    entry.baseline = key;
    return null;
  }
  // The state the watch began in is not a change; the first reading that differs retires it, and
  // every later entry into a stillness is news.
  if (key === entry.baseline) return null;
  entry.baseline = null;

  let announce = false;
  if (situation.kind === "stopped") announce = entry.said !== "stopped";
  else if (situation.kind === "moving") announce = isStillness(entry.said);
  else announce = seenBefore && entry.said !== key;
  if (!announce) return null;

  entry.said = key;
  return {
    kind: "agent",
    text: situationText(target, agentName(agentId, entry), situation, nowMs),
    url: fileUrl(entry.path),
    agentId,
  };
}

/**
 * Reads every transcript under the subagents dir into `target.agents` and returns the ids read
 * this poll. A read that failed is no observation: its entry's continuity is broken, so no wait
 * or stall is announced from a reading nobody refreshed.
 */
function readAgents(
  target: Target,
  trouble: Map<string, Trouble>,
  io: Io,
): { events: EventInput[]; busy: boolean; refreshed: string[] } {
  const events: EventInput[] = [];
  const refreshed: string[] = [];
  let busy = false;

  let names: string[];
  try {
    names = readdirSync(target.subagentsDir);
  } catch (error) {
    throw new FleetReadError(
      "subagents",
      `fleet: cannot list ${target.subagentsDir}: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
      fileUrl(target.subagentsDir),
    );
  }

  const listed = new Set<string>();
  for (const name of names.sort()) {
    const agentId = TRANSCRIPT_NAME.exec(name)?.[1];
    if (agentId === undefined) continue;
    listed.add(agentId);
    const path = join(target.subagentsDir, name);
    const known = target.agents[agentId];
    const entry = known ?? {
      ...initialTranscript(),
      path,
      sidecar: null,
      observed: null,
      said: null,
      baseline: null,
    };
    const sidecarName = `agent-${agentId}.meta.json`;
    // A read that fails is this one agent's trouble, never the poll's: the rest of the fleet is still read.
    const failed = (file: string, error: unknown): void => {
      const reason = error instanceof Error ? error.message : String(error);
      io.log(`${agentId}: ${reason}`);
      trouble.set(`agent:${agentId}`, {
        text: `fleet: cannot read ${file}: ${reason}`,
        url: fileUrl(join(target.subagentsDir, file)),
      });
      if (known !== undefined) known.observed = null;
    };

    try {
      entry.sidecar = readSidecar(join(target.subagentsDir, sidecarName));
    } catch (error) {
      failed(sidecarName, error);
      continue;
    }

    try {
      if (readTranscript(entry, path)) busy = true;
    } catch (error) {
      failed(name, error);
      continue;
    }

    // An agent joins the fleet on its first readable poll, so its start is never lost to a failed one.
    target.agents[agentId] = entry;
    refreshed.push(agentId);
    if (known === undefined && target.polls > 0) {
      events.push({
        kind: "agent",
        text: `agent ${agentName(agentId, entry)}: started`,
        url: fileUrl(path),
        agentId,
      });
    }
  }

  for (const [agentId, entry] of Object.entries(target.agents)) {
    if (!listed.has(agentId)) entry.observed = null;
  }
  return { events, busy, refreshed };
}

// --- the worktrees ----------------------------------------------------------------

function fingerprintOf(row: WorktreeRow & { ok: true }): string {
  return `${row.headSha} ${row.newestDirtyMtime ?? "-"} ${row.statusHash}`;
}

function countProcesses(processes: ProcessRow[]): { workers: number; shells: number } {
  let workers = 0;
  let shells = 0;
  for (const process of processes) {
    if (SHELLS.has(basename(process.command))) shells += 1;
    else workers += 1;
  }
  return { workers, shells };
}

function claimedWorktrees(target: Target): Set<string> {
  const claimed = new Set<string>();
  for (const entry of Object.values(target.agents)) {
    if (entry.sidecar?.worktreePath) claimed.add(resolve(entry.sidecar.worktreePath));
  }
  return claimed;
}

/** The head, wipe, and quiet transitions of one worktree against its last reading; the first reading is its baseline. */
function worktreeTransitions(
  target: Target,
  row: WorktreeRow & { ok: true },
  attributionOk: boolean,
  claimed: Set<string>,
): { events: EventInput[]; moved: boolean } {
  const events: EventInput[] = [];
  const label = `worktree ${row.branch ?? row.headSha.slice(0, SHORT_SHA)}`;
  const url = fileUrl(row.worktree);
  const fingerprint = fingerprintOf(row);
  const processes = countProcesses(row.processes);
  const previous = target.worktrees[row.worktree];
  const moved = previous?.fingerprint !== fingerprint;

  if (previous?.headSha != null && previous.headSha !== row.headSha) {
    events.push({
      kind: "head",
      text: `${label}: head moved to ${row.headSha.slice(0, SHORT_SHA)}`,
      url,
      worktree: row.worktree,
      sha: row.headSha,
      ahead: row.aheadBehind?.ahead ?? null,
      behind: row.aheadBehind?.behind ?? null,
    });
  }
  if (previous?.treeFileCount != null && row.treeFileCount < previous.treeFileCount / 2) {
    events.push({
      kind: "wipe",
      text: `${label}: ${previous.treeFileCount} files at HEAD -> ${row.treeFileCount}`,
      url,
      worktree: row.worktree,
      sha: row.headSha,
    });
  }

  // Under a downed or degraded lsof an empty process list is not verified inactivity, and a
  // worktree an agent's sidecar claims is judged by that transcript, so its count holds at zero
  // until the claim ends.
  const idle =
    attributionOk &&
    processes.workers === 0 &&
    !moved &&
    previous !== undefined &&
    !claimed.has(resolve(row.worktree));
  const quietPolls = idle ? previous.quietPolls + 1 : 0;
  if (quietPolls === QUIET_POLLS) {
    events.push({
      kind: "quiet",
      text: `${label}: no worker process and no change for ${QUIET_POLLS} polls`,
      url,
      worktree: row.worktree,
    });
  }

  target.worktrees[row.worktree] = {
    branch: row.branch,
    headSha: row.headSha,
    treeFileCount: row.treeFileCount,
    fingerprint,
    processes,
    quietPolls,
  };
  return { events, moved };
}

async function readWorktrees(
  target: Target,
  repo: string,
  trouble: Map<string, Trouble>,
  io: Io,
): Promise<{ events: EventInput[]; busy: boolean }> {
  const events: EventInput[] = [];
  let busy = false;

  const discovered = await discoverWorktrees(repo);
  if (!discovered.ok) {
    throw new FleetReadError("worktrees", `fleet: ${discovered.reason}`, fileUrl(repo));
  }

  const { processesByWorktree, lsofLine } = await attributeProcesses(discovered.paths);
  const lsof = lsofLine?.lsof ?? null;
  const attributionOk = lsof === null;
  if (lsof?.ok === true) io.log(`lsof degraded: ${lsof.note}`);
  if (lsof?.ok === false) {
    trouble.set("lsof", {
      text: `fleet: process attribution is down: ${lsof.error}`,
      url: fileUrl(repo),
    });
  }

  const ref =
    target.base === null ? await resolveDefaultRef(repo) : await resolveBaseRef(repo, target.base);
  if (ref.ref === null) trouble.set("base", { text: `fleet: ${ref.error}`, url: fileUrl(repo) });

  const claimed = claimedWorktrees(target);
  const seen = new Set<string>();
  for (const path of discovered.paths) {
    seen.add(path);
    const row = await worktreeRow(
      path,
      ref.ref === null ? null : ref.sha,
      processesByWorktree.get(path) ?? [],
    );
    if (!row.ok) {
      trouble.set(`worktree:${path}`, {
        text: `fleet: worktree ${path}: ${row.error}`,
        url: fileUrl(path),
      });
      const known = target.worktrees[path];
      if (known !== undefined) known.quietPolls = 0;
      continue;
    }
    const outcome = worktreeTransitions(target, row, attributionOk, claimed);
    events.push(...outcome.events);
    busy ||= outcome.moved;
  }
  for (const path of Object.keys(target.worktrees)) {
    if (!seen.has(path)) delete target.worktrees[path];
  }
  return { events, busy };
}

// --- the poll ----------------------------------------------------------------------

/** The trouble events: each condition once when it begins, nothing while it holds, and silence when it is gone. */
function troubleTransitions(target: Target, trouble: Map<string, Trouble>): EventInput[] {
  const events: EventInput[] = [];
  for (const [key, { text, url }] of trouble) {
    if (!Object.hasOwn(target.trouble, key)) events.push({ kind: "trouble", text, url });
  }
  target.trouble = Object.fromEntries([...trouble].map(([key, { text }]) => [key, text]));
  return events;
}

/** Every reading and judgment of one poll, on `draft`; a fleet-wide read that fails throws before anything is judged. */
async function readFleet(
  draft: Target,
  nowMs: number,
  io: Io,
): Promise<{ events: EventInput[]; busy: boolean; trouble: Map<string, Trouble> }> {
  const trouble = new Map<string, Trouble>();
  let busy = false;

  try {
    busy = readTranscript(draft.lead, draft.sessionFile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FleetReadError(
      "session",
      `fleet: cannot read the session transcript: ${reason}`,
      fileUrl(draft.sessionFile),
    );
  }

  const agents = readAgents(draft, trouble, io);
  busy ||= agents.busy;

  const worktrees =
    draft.repo === null
      ? { events: [], busy: false }
      : await readWorktrees(draft, draft.repo, trouble, io);
  busy ||= worktrees.busy;

  const transitions: EventInput[] = [];
  for (const agentId of agents.refreshed) {
    const event = agentTransition(draft, agentId, draft.agents[agentId] as AgentEntry, nowMs);
    if (event !== null) transitions.push(event);
  }

  draft.polls += 1;
  return { events: [...agents.events, ...transitions, ...worktrees.events], busy, trouble };
}

/** The one trouble event of a failed fleet-wide read, said on entering; the conditions already in force stay recorded. */
function troubleOnly(target: Target, failure: FleetReadError): PollResult {
  const events: EventInput[] = [];
  if (!Object.hasOwn(target.trouble, failure.key)) {
    events.push({ kind: "trouble", text: failure.message, url: failure.url });
  }
  target.trouble[failure.key] = failure.message;
  return { events, busy: false };
}

/**
 * One poll of a target, read and judged on a draft copy. A fleet-wide read that fails (the session
 * transcript, the subagents listing, the worktree discovery, or any dependency read added later
 * that throws past the per-agent catches) discards the draft: no transition is said, no counter
 * moves, every continuity stays as it was, and the one trouble event is said. A poll that reads
 * commits the draft. An error that is not a read failure is the daemon's failed poll, which saves
 * nothing either.
 */
async function pollTarget(target: Target, nowMs: number, io: Io): Promise<PollResult> {
  const draft = structuredClone(target);
  let outcome: Awaited<ReturnType<typeof readFleet>>;
  try {
    outcome = await readFleet(draft, nowMs, io);
  } catch (error) {
    if (!(error instanceof FleetReadError)) throw error;
    io.log(error.message);
    return troubleOnly(target, error);
  }

  Object.assign(target, draft);
  return {
    events: [...troubleTransitions(target, outcome.trouble), ...outcome.events],
    busy: outcome.busy,
  };
}

async function poll(targets: Record<string, Target>, io: Io): Promise<PollResult> {
  const nowMs = Date.now();
  const events: EventInput[] = [];
  let busy = false;
  for (const target of Object.values(targets)) {
    const result = await pollTarget(target, nowMs, io);
    events.push(...result.events);
    busy ||= result.busy;
  }
  return { events, busy };
}

runEvents<Target>({
  name: "fleet-events",
  interval: 60,
  idleInterval: 300,
  usage: [
    "targets: session (this session's transcript and subagents dir, found by CLAUDE_CODE_SESSION_ID under ~/.claude/projects), or an absolute path to a session directory",
    "--repo <root>            add the worktree reading for every worktree of this repository (absolute path)",
    "--base <ref>             aheadBehind against this committish (default: origin's default branch)",
    `--quiet-after <minutes>  a wait or a stall is this long before it is said (default ${DEFAULT_QUIET_AFTER_MINUTES})`,
    `the session-events skill must be installed beside this one; without it every command exits 2 naming the install: ${INSTALL}`,
  ],
  parseTarget,
  poll,
});
