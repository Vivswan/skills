// The contract between the daemon and a source. The daemon owns the session: its socket, the
// delivery with the envelope and the boundary line, the write-ahead log, the saved state, and the
// schedule. A source owns one polled system: what a target is, how it is read, and what its events
// say. A source module's default export is `define(...)`, handed to `main` by the entry script.

import type { ParseArgsOptionsConfig } from "node:util";

/** A command-line mistake: the message is printed with the failing command's usage line, exit 2. */
export class UsageError extends Error {}

/** Thrown by `PollContext.checkAbort` once the owner is gone: the poll ends where it stands. */
export class Aborted extends Error {}

/** What a source hands the daemon for one event; the daemon numbers and stamps it. */
export type EventInput = { kind: string; text: string; url?: string } & Record<string, unknown>;

/** One line of the write-ahead log: `id` and `at` first, then the source's fields in its order. */
export type Event<Input extends EventInput = EventInput> = { id: number; at: string } & Input;

/** The values node:util's parseArgs returns for the options a command declares. */
export type OptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** A subscribing command: `watch` and its kin. The daemon adds `--id` to the options it declares. */
export interface CommandSpec<Target> {
  /** The command's usage line, `--id` included, as a usage error prints it. */
  usage: string;
  /** How many positionals the command takes; a further one is a usage error. */
  positionals: number;
  options: ParseArgsOptionsConfig;
  /** Throws UsageError for a bad argument. */
  parse(positionals: string[], values: OptionValues): Target;
}

export interface PollError {
  where: string;
  message: string;
  /** The second sentence of the trouble notice three failed polls raise, when the error asks for more than a retry. */
  advice?: string;
}

export interface PollContext<Saved> {
  saved: Saved;
  /** The one target this poll was asked for (the key `subscribe` returned), or null for every target. */
  scope: string | null;
  /** The daemon's log file, for a notice that sends the reader there. */
  logPath: string;
  log(line: string): void;
  /** Throws Aborted once the owner is gone; a source calls it before each read it makes. */
  checkAbort(): void;
}

export interface PollResult<Saved, Input extends EventInput> {
  events: Input[];
  saved: Saved;
  /** Every read that failed, in order; the last one names the trouble notice. */
  errors: PollError[];
  /** Why the poll ended early, when the source caught Aborted: what it read before is kept, nothing is delivered. */
  aborted?: string;
}

export interface Source<Target, Saved, Input extends EventInput = EventInput> {
  /** The sender the envelope names, the closing line's name, and the msg_id prefix. */
  name: string;
  /** The floor of `--interval`, and its default. */
  minIntervalSeconds: number;
  /** Set when events quote text from the polled system: the fence label and the boundary sentence a digest opens with. */
  quoted?: { label: string; boundary: string };
  /** The target fields of a daemon-wide trouble line, in the order the source's lines carry them. */
  blankTarget: Record<string, unknown>;
  commands: Record<string, CommandSpec<Target>>;
  unwatch: {
    /** The usage line, `--all` and `--id` included. */
    usage: string;
    /** The key a target names, as `subscribe` returned it, and how the confirmation prints it. */
    parse(target: string | undefined): { key: string; label: string };
  };
  describeTarget(target: Target): string;
  /** The event's subject as a message headline opens with it; null for a daemon-wide line. */
  subjectOf(event: Event<Input>): string | null;
  /** The saved state as the last daemon left it (undefined on a fresh start), and the log lines appended after it was saved. */
  restore(raw: unknown, logAhead: Event<Input>[]): Saved;
  subscribe(saved: Saved, target: Target): { saved: Saved; key: string; logLine: string };
  /** Null drops every target. Throws for a key that names more than one. */
  unsubscribe(saved: Saved, key: string | null): Saved;
  countTargets(saved: Saved): number;
  /** The target lines `status` prints after the delivery line. */
  describeStatus(saved: Saved): string[];
  poll(context: PollContext<Saved>): Promise<PollResult<Saved, Input>>;
  /** Run once the daemon holds its socket; what it throws ends the start with exit 2. */
  preflight?(): void;
}

/**
 * The quoted rows of one event inside a fence the daemon's boundary line names. The fence is
 * longer than any run of backticks opening a quoted row, so no row can close it.
 */
export function fenceQuoted(label: string, rows: string[]): string[] {
  const longest = Math.max(2, ...rows.map((row) => /^ {0,3}(`*)/.exec(row)?.[1]?.length ?? 0));
  const fence = `  ${"`".repeat(longest + 1)}`;
  return [`${fence}${label}`, ...rows, fence];
}

export interface Kit {
  UsageError: typeof UsageError;
  Aborted: typeof Aborted;
  fenceQuoted: typeof fenceQuoted;
}

const KIT: Kit = { UsageError, Aborted, fenceQuoted };

export type AnySource = Source<unknown, unknown, EventInput>;

/** A source module's default export: the factory receives what a source needs from the daemon. */
export default function define<Target, Saved, Input extends EventInput = EventInput>(
  factory: (kit: Kit) => Source<Target, Saved, Input>,
): Source<Target, Saved, Input> {
  return factory(KIT);
}
