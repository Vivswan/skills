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
import { join, resolve } from "node:path";

// The harness writes each queued notice as its own block, so a block that is nothing but
// `<task-notification>` elements is notices, every one of them; a block carrying anything else (a
// teammate's envelope, prose) is a teammate's words, and a notice quoted inside it is not one. The
// envelope text escapes nothing, so a span rule could never tell a quoted envelope from a real one.
const NOTICE_OPEN = "<task-notification>";
const NOTICE_CLOSE = "</task-notification>";
const TASK_ID_OPEN = "<task-id>";
const TASK_ID_CLOSE = "</task-id>";
// An absolute path inside a command or a prompt: quoted whole (a space inside stays), or bare
// after a separator; a drive letter and colon before the slash (`C:/x`) is no POSIX path. A
// path-valued field (`file_path`, `path`, `cwd`) is taken whole instead, so a space never cuts a
// path into a sibling worktree's root.
const ABSOLUTE_PATH =
  /"(\/[^"]+)"|'(\/[^']+)'|`(\/[^`]+)`|(?<![^\s=(,:]|\b[A-Za-z]:)\/[^\s"'`;|&<>()]+/g;
const PATH_FIELD = /path|dir|cwd/i;
// Distinct paths an agent named, the least recently named dropped past this: bounded state for a
// long transcript, and a path in current use never lapses.
const MAX_NAMED_PATHS = 1000;
// Each teammate envelope with its body: the regex locates, the parsed body decides. A body with a
// tag inside is text, never a notice, so it is not captured.
const TEAMMATE_ENVELOPE =
  /<\\?teammate-message\s[^>]*?teammate_id="([^"]+)"[^>]*>([^<]*)<\\?\/teammate-message>/g;
const SPAWN_STATUSES = new Set(["async_launched", "teammate_spawned"]);
const NEWLINE = 0x0a;

/** A tool call with no result yet: mid-call, or killed with the agent. `taskId` is the name an Agent call gives its child (what a TaskStop later takes), a TaskStop's own task_id, or a SendMessage's `to`; null for every other tool. `timeoutMs` is the call's own `timeout` input, when it carries one. */
export interface PendingCall {
  tool: string;
  at: string;
  taskId: string | null;
  timeoutMs: number | null;
}

/** A background job this agent launched, keyed by its task id, until its notice arrives. */
export interface Job {
  at: string;
}

/**
 * An agent this one spawned, keyed by agentId, kept after it finished so a later poll still sees a
 * stop. `at` is the spawn and never moves, since a name resolves to the latest spawn; `since` is
 * when its current run began: the spawn, or the message that resumed it.
 */
export interface Child {
  name: string | null;
  readonly at: string;
  since: string;
  outcome: "running" | "finished" | "stopped";
}

/** What an agent's transcript says it is doing. `lastMovedAt` is the newest timestamp seen, floored by the file's mtime once read from disk. */
export interface Activity {
  lastMovedAt: string | null;
  turn: "open" | "ended";
  pending: Record<string, PendingCall>;
  jobs: Record<string, Job>;
  children: Record<string, Child>;
  /** Successful TaskStops on a task id that is no job and no child here, by that exact id: a nested agent another agent spawned, stopped by the lead. */
  stops: Record<string, string>;
  /** Absolute paths named in this agent's tool-call inputs (never a result or a user text), resolved, distinct, least recently named first: the worktrees it works in by its own commands. */
  named: string[];
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

/** A JSON object, or null for anything else. */
export function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A string, or null for anything else. */
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number, or null for anything else. */
export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    stops: {},
    named: [],
    lines: 0,
    skipped: 0,
  };
}

/** The absolute paths one input string names: a path field's value whole, else each quoted or bare path in it. */
function namedPathsIn(text: string, field: string): string[] {
  const trimmed = text.trim();
  if (PATH_FIELD.test(field) && trimmed.startsWith("/")) return [trimmed];
  // A bare path in prose carries the sentence's punctuation; a quoted one carries nothing extra.
  return [...text.matchAll(ABSOLUTE_PATH)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? match[0].replace(/[.,:;]+$/, ""),
  );
}

// The worktree an agent works in shows up in its own tool calls (`git -C /abs/wt status`) before
// anything else does, and a tool call's input is the agent's own words, where a result or a user
// text is not. Each string is read under the field that holds it, an array under its parent's.
function namePaths(state: Activity, input: unknown, field = ""): void {
  if (typeof input === "string") {
    for (const named of namedPathsIn(input, field)) {
      const path = resolve(named);
      const at = state.named.indexOf(path);
      if (at >= 0) state.named.splice(at, 1);
      state.named.push(path);
      if (state.named.length > MAX_NAMED_PATHS) state.named.shift();
    }
  } else if (Array.isArray(input)) {
    for (const item of input) namePaths(state, item, field);
  } else if (typeof input === "object" && input !== null) {
    for (const [key, item] of Object.entries(input)) namePaths(state, item, key);
  }
}

/** The task id a notice's body names, trimmed; undefined without a closed `<task-id>` holding one word of text. */
function taskIdOf(body: string): string | undefined {
  const open = body.indexOf(TASK_ID_OPEN);
  if (open < 0) return undefined;
  const close = body.indexOf(TASK_ID_CLOSE, open);
  if (close < 0) return undefined;
  const id = body.slice(open + TASK_ID_OPEN.length, close).trim();
  return id === "" || id.includes("<") ? undefined : id;
}

/**
 * The task ids of the notices in `text`, in order, when the block is nothing but notices with
 * whitespace between; none otherwise. Read element by element, never by a pattern over the whole
 * block: a wildcard would backtrack across a closing tag, and the text can be megabytes.
 */
function noticeIdsOf(text: string): string[] {
  const ids: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    const close = rest.indexOf(NOTICE_CLOSE);
    if (!rest.startsWith(NOTICE_OPEN) || close < 0) return [];
    const body = rest.slice(NOTICE_OPEN.length, close);
    if (body.includes(NOTICE_OPEN)) return [];
    const id = taskIdOf(body);
    if (id !== undefined) ids.push(id);
    rest = rest.slice(close + NOTICE_CLOSE.length).trimStart();
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
// spawn, so every lookup by name here does too, among the children of the asked-for outcome.
function childNamed(state: Activity, name: string, outcome?: Child["outcome"]): string | undefined {
  let found: string | undefined;
  let foundAt = Number.NEGATIVE_INFINITY;
  for (const [id, child] of Object.entries(state.children)) {
    if (child.name !== name || (outcome !== undefined && child.outcome !== outcome)) continue;
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

// An idle notification names its sender, and a resumed elder may share the name with a later
// spawn: the running one is the sender.
function finishChild(state: Activity, taskId: string): void {
  const id = Object.hasOwn(state.children, taskId) ? taskId : childNamed(state, taskId, "running");
  const child = id === undefined ? undefined : state.children[id];
  if (child?.outcome === "running") child.outcome = "finished";
}

function finishTask(state: Activity, taskId: string): void {
  delete state.jobs[taskId];
  finishChild(state, taskId);
}

// Claude Code resumes a finished teammate when it is sent a message, from its own transcript. A
// stopped one stays stopped: TaskStop is final.
function resumeChild(state: Activity, taskId: string, at: string): void {
  const id = childOf(state, taskId);
  const child = id === undefined ? undefined : state.children[id];
  if (child?.outcome !== "finished") return;
  child.outcome = "running";
  child.since = at;
}

// TaskStop takes a job id, an agentId, or the name given at spawn. An id this file never launched
// or spawned is still a stop by that id: the lead stopping an agent another agent spawned.
function stopTask(state: Activity, taskId: string, at: string): void {
  if (Object.hasOwn(state.jobs, taskId)) {
    delete state.jobs[taskId];
    return;
  }

  const id = childOf(state, taskId);
  if (id === undefined) state.stops[taskId] = at;
  else (state.children[id] as Child).outcome = "stopped";
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
    namePaths(state, input);
    let taskId: string | null = null;
    if (tool === "Agent") taskId = str(input?.name);
    if (tool === "TaskStop") taskId = str(input?.task_id);
    if (tool === "SendMessage") taskId = str(input?.to);
    state.pending[id] = { tool, at, taskId, timeoutMs: num(input?.timeout) };
  }
}

// A text arriving while a call is pending reached the agent before any result could: the call was
// abandoned. Notices are not interruptions: they are queued and delivered between turns, one block
// per text, and every one in a pure notice block counts (noticeIdsOf above).
function reduceInjected(state: Activity, texts: string[]): void {
  let notices = 0;
  for (const text of texts) {
    const tasks = noticeIdsOf(text);
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
    // A stop or a resume counts once its result confirms it: an errored TaskStop (no such task)
    // stopped nothing, an errored SendMessage reached nobody.
    if (item.is_error === true) continue;
    if (call.tool === "TaskStop") stopTask(state, call.taskId, at);
    if (call.tool === "SendMessage") resumeChild(state, call.taskId, at);
  }

  const result = record(line.toolUseResult);
  if (result === null) return;

  // A job also when a foreground command timed out and was moved to the background.
  const job = str(result.backgroundTaskId);
  if (job !== null) state.jobs[job] = { at };

  const agentId = str(result.agentId);
  if (agentId !== null && SPAWN_STATUSES.has(str(result.status) ?? "")) {
    state.children[agentId] = {
      name: str(result.name) ?? spawning,
      at,
      since: at,
      outcome: "running",
    };
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

  // A notice is the turn's input in this form as in the user-line form: the turn it lands in is open.
  state.turn = "open";
  for (const taskId of noticeIdsOf(str(attachment.prompt) ?? "")) finishTask(state, taskId);
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

/** Whether `parent` stopped the agent: by its exact id, spawned here or not, else by the name its sidecar gives it. */
export function isStopped(parent: Activity, agentId: string, name: string | null): boolean {
  if (Object.hasOwn(parent.stops, agentId)) return true;
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

// --- persisted state from any version --------------------------------------------------------
// A daemon restarted on newer code reads the state the older code saved. A map or field added
// since takes its default here, at the load; a shape no version wrote is null, and the caller
// starts that target over.

/** A saved map read entry by entry: absent is empty, a non-object or a bad entry is null. */
export function normalizeMap<T>(
  value: unknown,
  entry: (item: unknown) => T | null,
): Record<string, T> | null {
  if (value === undefined) return {};
  const map = record(value);
  if (map === null) return null;
  const made: Record<string, T> = {};
  for (const [key, item] of Object.entries(map)) {
    const read = entry(item);
    if (read === null) return null;
    made[key] = read;
  }
  return made;
}

function normalizePending(value: unknown): PendingCall | null {
  const call = record(value);
  const tool = str(call?.tool);
  const at = str(call?.at);
  if (call === null || tool === null || at === null) return null;
  return { tool, at, taskId: str(call.taskId), timeoutMs: num(call.timeoutMs) };
}

function normalizeJob(value: unknown): Job | null {
  const at = str(record(value)?.at);
  return at === null ? null : { at };
}

function normalizeChild(value: unknown): Child | null {
  const child = record(value);
  const at = str(child?.at);
  const outcome = child?.outcome;
  if (child === null || at === null) return null;
  if (outcome !== "running" && outcome !== "finished" && outcome !== "stopped") return null;
  return { name: str(child.name), at, since: str(child.since) ?? at, outcome };
}

/** A saved activity: `stops`, a child's `since`, and `named` came later and take their defaults; a shape no version wrote is null. */
export function normalizeActivity(value: unknown): Activity | null {
  const saved = record(value);
  if (saved === null) return null;
  const pending = normalizeMap(saved.pending, normalizePending);
  const jobs = normalizeMap(saved.jobs, normalizeJob);
  const children = normalizeMap(saved.children, normalizeChild);
  const stops = normalizeMap(saved.stops, str);
  if (pending === null || jobs === null || children === null || stops === null) return null;
  return {
    lastMovedAt: str(saved.lastMovedAt),
    turn: saved.turn === "ended" ? "ended" : "open",
    pending,
    jobs,
    children,
    stops,
    named: Array.isArray(saved.named) ? saved.named.filter((p) => typeof p === "string") : [],
    lines: num(saved.lines) ?? 0,
    skipped: num(saved.skipped) ?? 0,
  };
}

/** A saved transcript: its cursor and activity, read from the start again when saved before `stops`; null for a shape no version wrote. */
export function normalizeTranscript(value: unknown): Transcript | null {
  const saved = record(value);
  const cursor = record(saved?.cursor);
  const offset = num(cursor?.offset);
  const state = normalizeActivity(saved?.state);
  if (cursor === null || offset === null || state === null) return null;
  // The version that added `stops` also stopped moving a resumed child's `at` to the message, so
  // an older activity's `at` values are not the spawn times the name lookup needs; the one that
  // added a pending call's `timeoutMs` reads it off the call. Either older shape replays the file.
  const activity = record(saved?.state);
  const calls = Object.values(record(activity?.pending) ?? {});
  if (
    activity?.stops === undefined ||
    calls.some((call) => record(call)?.timeoutMs === undefined)
  ) {
    return initialTranscript();
  }
  // A cursor saved without `size` has read `offset` bytes: a file smaller than that restarts.
  return { cursor: { offset, ino: num(cursor.ino), size: num(cursor.size) ?? offset }, state };
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

  return sidecarOf(meta, new Date(opened.stat.mtimeMs).toISOString());
}

/** The sidecar's fields read off its JSON object; every field but `spawnedAt` is a string or null. */
export function sidecarOf(meta: Record<string, unknown>, spawnedAt: string): Sidecar {
  return {
    name: str(meta.name),
    description: str(meta.description),
    agentType: str(meta.agentType),
    parentAgentId: str(meta.parentAgentId),
    worktreePath: str(meta.worktreePath),
    worktreeBranch: str(meta.worktreeBranch),
    toolUseId: str(meta.toolUseId),
    spawnedAt,
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
