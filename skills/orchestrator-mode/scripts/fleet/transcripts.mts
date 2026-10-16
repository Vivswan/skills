// What each agent of a fleet is waiting on, read from the JSONL transcripts Claude Code writes
// under ~/.claude/projects. The state carries ids, names, tool names, and times only: the daemon's
// words land in the lead's session as user-role text, where a quoted tool result would read as
// something the owner wrote.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  type Stats,
  statSync,
} from "node:fs";
import { join } from "node:path";

// One injected text can carry several notices: two jobs finishing in one turn arrive as two blocks.
const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;
const TASK_ID = /<task-id>\s*([^<\s][^<]*?)\s*<\/task-id>/;
// Each teammate envelope with its body: the regex locates, the parsed body decides. A body with a
// tag inside is text, never a notice, so it is not captured.
const TEAMMATE_ENVELOPE =
  /<\\?teammate-message\s[^>]*?teammate_id="([^"]+)"[^>]*>([^<]*)<\\?\/teammate-message>/g;
// Whatever a teammate's message quotes, a notice included, is that teammate's words.
const TEAMMATE_SPAN = /<\\?teammate-message\s[^>]*>[\s\S]*?<\\?\/teammate-message>/g;
const SPAWN_STATUSES = new Set(["async_launched", "teammate_spawned"]);
const NEWLINE = 0x0a;

/** A tool call with no result yet: mid-call, or killed with the agent. `taskId` is the name an Agent call gives its child (what a TaskStop later takes) or a TaskStop's own task_id; null for every other tool. */
export interface PendingCall {
  tool: string;
  at: string;
  taskId: string | null;
}

/** A background job this agent launched, keyed by its task id, until its notice arrives. */
export interface Job {
  at: string;
}

/** An agent this one spawned, keyed by agentId, kept after it finished so a later poll still sees a stop. */
export interface Child {
  name: string | null;
  at: string;
  outcome: "running" | "finished" | "stopped";
}

/** What an agent's transcript says it is doing. `lastMovedAt` is the newest timestamp seen, floored by the file's mtime once read from disk. */
export interface Activity {
  lastMovedAt: string | null;
  turn: "open" | "ended";
  pending: Record<string, PendingCall>;
  jobs: Record<string, Job>;
  children: Record<string, Child>;
  lines: number;
  /** Lines that were not a JSON object with a timestamp: counted, never fatal. */
  skipped: number;
}

/** Where the next read starts: bytes consumed through the last newline (the unfinished tail is read again), with the inode and size seen, so a replaced or shrunk file (any smaller size) is told from growth. */
export interface Cursor {
  offset: number;
  ino: number | null;
  size: number;
}

/** One transcript as the daemon remembers it between polls. */
export interface Transcript {
  cursor: Cursor;
  state: Activity;
}

/** What one read of a transcript returned: the complete new lines and where the next read starts. */
export interface Increment {
  lines: Record<string, unknown>[];
  skipped: number;
  cursor: Cursor;
  mtimeMs: number;
  /** Another inode, or smaller than the size seen: replaced, truncated, or rotated, so the read started over. */
  restarted: boolean;
}

/** The `agent-<agentId>.meta.json` beside a transcript; its mtime is the spawn time. */
export interface Sidecar {
  name: string | null;
  description: string | null;
  agentType: string | null;
  parentAgentId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  toolUseId: string | null;
  spawnedAt: string;
}

/** A session's own transcript and the directory of its subagents' transcripts and sidecars. */
export interface SessionPaths {
  sessionFile: string;
  subagentsDir: string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function timestampOf(line: Record<string, unknown>): string | null {
  const at = str(line.timestamp);
  if (at === null || Number.isNaN(Date.parse(at))) return null;
  return at;
}

// Timestamps are not monotonic: a queued attachment keeps its enqueue time, up to an hour behind
// its neighbours, so the newest wins and nothing moves the mark back.
function moveTo(state: Activity, at: string): void {
  if (state.lastMovedAt === null || Date.parse(at) > Date.parse(state.lastMovedAt)) {
    state.lastMovedAt = at;
  }
}

function initialActivity(): Activity {
  return {
    lastMovedAt: null,
    turn: "open",
    pending: {},
    jobs: {},
    children: {},
    lines: 0,
    skipped: 0,
  };
}

/** The task ids of every `<task-notification>` block in `text`, in order. */
function taskIdsOf(text: string): string[] {
  const ids: string[] = [];
  for (const block of text.matchAll(TASK_NOTIFICATION)) {
    const id = TASK_ID.exec(block[1] as string)?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// The harness writes an idle notice as one bare JSON object whose top-level type says so; a nested
// field that spells the word, or a body that is not JSON, is not one.
function isIdleNotice(body: string): boolean {
  const notice = parseRecord(body.trim());
  return notice !== null && notice.type === "idle_notification";
}

/** The senders of the idle notifications in `text`, one per envelope whose body is one. */
function idleTeammatesOf(text: string): string[] {
  const names: string[] = [];
  for (const envelope of text.matchAll(TEAMMATE_ENVELOPE)) {
    if (isIdleNotice(envelope[2] as string)) names.push(envelope[1] as string);
  }
  return names;
}

// A name is rebound when an agent is respawned under it, and Claude Code resolves it to the latest
// agent, so every lookup by name here does too.
function childNamed(state: Activity, name: string): string | undefined {
  let found: string | undefined;
  let foundAt = Number.NEGATIVE_INFINITY;
  for (const [id, child] of Object.entries(state.children)) {
    if (child.name !== name) continue;
    const at = Date.parse(child.at);
    if (at < foundAt) continue;
    found = id;
    foundAt = at;
  }
  return found;
}

/** The one resolution of a task id to a child: an agentId as written, else the latest child spawned under that name. */
function childOf(state: Activity, taskId: string): string | undefined {
  if (Object.hasOwn(state.children, taskId)) return taskId;
  return childNamed(state, taskId);
}

function finishChild(state: Activity, taskId: string): void {
  const id = childOf(state, taskId);
  const child = id === undefined ? undefined : state.children[id];
  if (child?.outcome === "running") child.outcome = "finished";
}

function finishTask(state: Activity, taskId: string): void {
  delete state.jobs[taskId];
  finishChild(state, taskId);
}

// TaskStop takes a job id, an agentId, or the name given at spawn. One this file never launched
// or spawned is nobody's: nothing is recorded.
function stopTask(state: Activity, taskId: string): void {
  if (Object.hasOwn(state.jobs, taskId)) {
    delete state.jobs[taskId];
    return;
  }

  const id = childOf(state, taskId);
  if (id !== undefined) (state.children[id] as Child).outcome = "stopped";
}

// One line per content block, and only the message's last block carries the real stop_reason:
// the others say null, which keeps the turn open until the final block says end_turn.
function reduceAssistant(state: Activity, line: Record<string, unknown>, at: string): void {
  const message = record(line.message);
  state.turn = message?.stop_reason === "end_turn" ? "ended" : "open";

  const content = message?.content;
  if (!Array.isArray(content)) return;

  for (const part of content) {
    const block = record(part);
    if (block?.type !== "tool_use") continue;
    const id = str(block.id);
    const tool = str(block.name);
    if (id === null || tool === null) continue;
    const input = record(block.input);
    let taskId: string | null = null;
    if (tool === "Agent") taskId = str(input?.name);
    if (tool === "TaskStop") taskId = str(input?.task_id);
    state.pending[id] = { tool, at, taskId };
  }
}

// A text arriving while a call is pending reached the agent before any result could: the call was
// abandoned. Notices are not interruptions: they are queued and delivered between turns, one per
// text, and every one counts. A notice is a text that IS one, from its first character; a notice
// quoted inside a teammate's message is that teammate's words.
function reduceInjected(state: Activity, texts: string[]): void {
  let notices = 0;
  for (const text of texts) {
    const notice = text.trimStart().startsWith("<task-notification>");
    const tasks = notice ? taskIdsOf(text.replace(TEAMMATE_SPAN, "")) : [];
    const idle = idleTeammatesOf(text);
    for (const taskId of tasks) finishTask(state, taskId);
    for (const name of idle) finishChild(state, name);
    notices += tasks.length + idle.length;
  }
  if (notices === 0) state.pending = {};
}

function reduceResults(
  state: Activity,
  line: Record<string, unknown>,
  at: string,
  parts: unknown[],
): void {
  let spawning: string | null = null;
  for (const part of parts) {
    const item = record(part);
    if (item?.type !== "tool_result") continue;
    const id = str(item.tool_use_id);
    if (id === null) continue;
    const call = state.pending[id];
    delete state.pending[id];
    if (call === undefined || call.taskId === null) continue;
    if (call.tool === "Agent") spawning = call.taskId;
    // A stop counts once its result confirms it: an errored TaskStop (no such task) stopped nothing.
    if (call.tool === "TaskStop" && item.is_error !== true) stopTask(state, call.taskId);
  }

  const result = record(line.toolUseResult);
  if (result === null) return;

  // A job also when a foreground command timed out and was moved to the background.
  const job = str(result.backgroundTaskId);
  if (job !== null) state.jobs[job] = { at };

  const agentId = str(result.agentId);
  if (agentId !== null && SPAWN_STATUSES.has(str(result.status) ?? "")) {
    state.children[agentId] = { name: str(result.name) ?? spawning, at, outcome: "running" };
  }
}

// A user line with no tool_result block is injected input whatever its form: each text block of an
// array is read as a string of its own.
function reduceUser(state: Activity, line: Record<string, unknown>, at: string): void {
  state.turn = "open";
  const content = record(line.message)?.content;
  if (typeof content === "string") {
    reduceInjected(state, [content]);
    return;
  }
  if (!Array.isArray(content)) return;

  const parts = content.map(record);
  if (parts.some((part) => part?.type === "tool_result")) {
    reduceResults(state, line, at, content);
    return;
  }

  const texts = parts.map((part) => (part?.type === "text" ? (str(part.text) ?? "") : ""));
  reduceInjected(state, texts);
}

// A subagent's file sees a notice only as a queued_command attachment. Every other attachment is
// noise, and a prompt_snapshot spells the tag names, so nothing else is searched.
function reduceAttachment(state: Activity, line: Record<string, unknown>): void {
  const attachment = record(line.attachment);
  if (attachment?.type !== "queued_command" || attachment.commandMode !== "task-notification") {
    return;
  }

  for (const taskId of taskIdsOf(str(attachment.prompt) ?? "")) finishTask(state, taskId);
}

/**
 * Folds one parsed transcript line into `state`, in place, and returns it, so an array of lines
 * folds with `Array.prototype.reduce`. A line without a usable timestamp is counted as skipped.
 */
export function reduce(state: Activity, line: Record<string, unknown>): Activity {
  const at = timestampOf(line);
  if (at === null) {
    state.skipped += 1;
    return state;
  }

  state.lines += 1;
  moveTo(state, at);
  switch (line.type) {
    case "assistant":
      reduceAssistant(state, line, at);
      break;
    case "user":
      reduceUser(state, line, at);
      break;
    case "attachment":
      reduceAttachment(state, line);
      break;
    default:
      break;
  }
  return state;
}

/** Whether `parent` stopped the agent: by its id, else by the name its sidecar gives it. */
export function isStopped(parent: Activity, agentId: string, name: string | null): boolean {
  let id = childOf(parent, agentId);
  if (id === undefined && name !== null) id = childOf(parent, name);
  return id !== undefined && parent.children[id]?.outcome === "stopped";
}

function readBytes(fd: number, from: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, from + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/**
 * Opens `path` for reading without blocking and refuses anything but a regular file: a FIFO in a
 * transcript's or a sidecar's place would otherwise hold the open forever. The caller closes `fd`.
 *
 * @throws {Error} the path is not a regular file, or cannot be opened
 */
function openRegularFile(path: string): { fd: number; stat: Stats } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error(`${path} is not a regular file`);
  }
  return { fd, stat };
}

/**
 * The complete lines appended since `cursor`, each parsed; a line that is not a JSON object is
 * counted in `skipped`.
 *
 * @throws {Error} the path is not a regular file, or cannot be opened
 */
export function readIncrement(path: string, cursor: Cursor): Increment {
  const { fd, stat } = openRegularFile(path);
  try {
    const replaced = cursor.ino !== null && stat.ino !== cursor.ino;
    const restarted = replaced || stat.size < cursor.size;
    const from = restarted ? 0 : cursor.offset;
    const bytes = readBytes(fd, from, stat.size - from);
    const complete = bytes.lastIndexOf(NEWLINE) + 1;

    const lines: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const raw of bytes.subarray(0, complete).toString("utf8").split("\n")) {
      if (raw === "") continue;
      const line = parseRecord(raw);
      if (line === null) skipped += 1;
      else lines.push(line);
    }

    return {
      lines,
      skipped,
      cursor: { offset: from + complete, ino: stat.ino, size: stat.size },
      mtimeMs: stat.mtimeMs,
      restarted,
    };
  } finally {
    closeSync(fd);
  }
}

/** A transcript nothing has been read from: the cursor at byte 0 and an empty state. */
export function initialTranscript(): Transcript {
  return { cursor: { offset: 0, ino: null, size: 0 }, state: initialActivity() };
}

/**
 * Reads what `path` appended since the last call into `transcript`, in place. A file that shrank
 * or was replaced starts the state over, silently.
 *
 * @returns whether the file changed since the last read
 * @throws {Error} the path is not a regular file, or cannot be opened
 */
export function readTranscript(transcript: Transcript, path: string): boolean {
  const increment = readIncrement(path, transcript.cursor);
  if (increment.restarted) transcript.state = initialActivity();

  for (const line of increment.lines) reduce(transcript.state, line);
  transcript.state.skipped += increment.skipped;
  moveTo(transcript.state, new Date(increment.mtimeMs).toISOString());

  // Bytes inside an unfinished line are movement too (the agent is mid-write), and so is a line
  // completed at the same size.
  const moved =
    increment.restarted ||
    increment.cursor.size !== transcript.cursor.size ||
    increment.cursor.offset !== transcript.cursor.offset;
  transcript.cursor = increment.cursor;
  return moved;
}

/**
 * The sidecar at `path`, or null while Claude Code has not written it yet.
 *
 * @throws {Error} the file is not a regular file or not a JSON object, or cannot be read
 */
export function readSidecar(path: string): Sidecar | null {
  let opened: { fd: number; stat: Stats };
  try {
    opened = openRegularFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let text: string;
  try {
    text = readFileSync(opened.fd, "utf8");
  } finally {
    closeSync(opened.fd);
  }

  const meta = parseRecord(text);
  if (meta === null) throw new Error(`${path} is not a JSON object`);

  return {
    name: str(meta.name),
    description: str(meta.description),
    agentType: str(meta.agentType),
    parentAgentId: str(meta.parentAgentId),
    worktreePath: str(meta.worktreePath),
    worktreeBranch: str(meta.worktreeBranch),
    toolUseId: str(meta.toolUseId),
    spawnedAt: new Date(opened.stat.mtimeMs).toISOString(),
  };
}

/** The sidecar's name, else its description, else the agentId. */
export function displayName(agentId: string, sidecar: Sidecar | null): string {
  return sidecar?.name ?? sidecar?.description ?? agentId;
}

/** Claude Code's project directory for a cwd: every character that is not a letter or digit becomes a dash. */
function projectDir(cwd: string, home: string): string {
  return join(projectsRoot(home), cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

function pathsIn(project: string, sessionId: string): SessionPaths {
  return {
    sessionFile: join(project, `${sessionId}.jsonl`),
    subagentsDir: join(project, sessionId, "subagents"),
  };
}

/** The directory under `home` that holds every project directory. */
export function projectsRoot(home: string): string {
  return join(home, ".claude", "projects");
}

/** Where Claude Code writes a session's transcript and its subagents' transcripts for a session launched in `cwd`. */
export function sessionPaths(cwd: string, sessionId: string, home: string): SessionPaths {
  return pathsIn(projectDir(cwd, home), sessionId);
}

/**
 * A session's paths found by its id: the project directory of `cwd` first (the common case, no
 * scan), then every project directory, since the project directory is the session's launch cwd
 * and a shell may have moved since. Null when no project directory holds `<sessionId>.jsonl`.
 */
export function locateSession(sessionId: string, home: string, cwd: string): SessionPaths | null {
  const guess = sessionPaths(cwd, sessionId, home);
  if (existsSync(guess.sessionFile)) return guess;

  let names: string[];
  try {
    names = readdirSync(projectsRoot(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  // stat, not the directory entry's type: a project directory may be a symlink.
  for (const name of names) {
    const project = join(projectsRoot(home), name);
    if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) continue;
    const paths = pathsIn(project, sessionId);
    if (existsSync(paths.sessionFile)) return paths;
  }
  return null;
}
