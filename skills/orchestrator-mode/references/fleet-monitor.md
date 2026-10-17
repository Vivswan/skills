# Fleet Monitor

The fleet monitor is one role with two instruments (One Role, Two Instruments below). The default is `scripts/fleet-events.mts`, this skill's source for the `/session-events` skill's daemon: the lead's session starts it once as a background task and subscribes itself, and from then on every transition in the fleet arrives as a message.

This page owns the role: what the daemon says and what it cannot see, the monitor subagent's brief, and the judgment and instruments that stay the lead's. The `/session-events` skill's page owns the envelope, the files, and the two-hour cap.

```bash
bun "<skill-dir>/scripts/fleet-events.mts" daemon                       # once per session, as a BACKGROUND task
bun "<skill-dir>/scripts/fleet-events.mts" watch session --repo <root>  # this session's subagents, plus the worktree reading
```

The lead goes back to work. Some polls later, unasked:

```text
<cross-session-message from="uds:/run/user/1000/session-events/4242.fleet-events.sock" from-name="fleet-events" from-mode="bypass">
agent builder-a: waiting on Bash for 14 min
file:///home/user/.claude/projects/-repo/0f3c7e2a-5b1d-4c8e-9a2f-6d7e8f9a0b1c/subagents/agent-0a1b2c3d4e5f6a7b8.jsonl

worktree feat/parser: head moved to 1a2b3c4d5e6f
file:///repo/.claude/worktrees/feat-parser
automated notice from fleet-events; no reply needed
</cross-session-message>
```

Under the daemon no turn is spent on "nothing changed yet", and no subagent sweeps. The daemon is per session: a new wave needs no new monitor, and it exits with the session.

| Argument | Means |
| --- | --- |
| `session` | this session's transcript and subagents directory, found by `CLAUDE_CODE_SESSION_ID` under `~/.claude/projects` (the cwd's project tried first) |
| `/abs/<sessionId>` | an absolute session directory, for another session's fleet |
| `--repo <root>` | adds the worktree reading of that repository: what `sweep.mts` prints, every poll |
| `--base <ref>` | the ahead/behind base (default: origin's default branch) |
| `--quiet-after <minutes>` | how long a wait or a stall lasts before it is said (default 10) |

The transcript reading is incremental: each poll reads what an `agent-*.jsonl` gained since the last. The interval is 60 s while something moves, backing off to 300 s. The command contract (`--help`) is quoted under The Daemon at the end of this page.

## One Role, Two Instruments

The fleet monitor is a role: watch the fleet, and report each transition with how long the state behind it has held. It judges nothing, so every call and every action stays the lead's.

| Instrument | Reads | Harness | The pick |
| --- | --- | --- | --- |
| the `fleet-events` daemon | a session's agent transcripts, plus the worktrees with `--repo` | a Claude Code lead. File-sink mode (`--id <name>`, The Daemon below) changes only the delivery: every poll still reads a session transcript | the default wherever there is a session to read |
| the monitor subagent | the sweep's worktree rows, plus the ledger | any harness, any worker: Codex, Copilot, a human | the fallback wherever there is no session to read. For workers without a Claude transcript its rows are the whole reading |

Both say what moved and for how long, and the rest of this page reads the same rows either way. The daemon's events are What Arrives, and the subagent's brief is The Monitor Subagent.

## What Arrives

Each event is one line and its `file://` URL, inside the `/session-events` skill's envelope; never reply to a message. Every text is names, tool names, counts, durations, shas, and paths, and nothing an agent wrote or read is in a message: the URL is where to read it. A state is said once on entering and once on leaving.

| Kind | The line says | What the lead judges |
| --- | --- | --- |
| `agent` | `agent <name>: started` | nothing yet |
| `agent` | `agent <name>: waiting on Bash for 14 min` | a long command, or a permission prompt: the transcript shows the two the same, and whether a prompt is up is the session's to know |
| `agent` | `agent <name>: waiting on agent <child> for 40 min; <child> last moved 2 min ago` | a child still moving (its last move is on the line) and a parent waiting by design, or a child whose own line says it stalled |
| `agent` | `agent <name>: waiting on 2 background jobs for 9 min` | what the jobs do is invisible to the daemon; the agent's own report says, or the escalation pair in Reading a Sweep at flag-time |
| `agent` | `agent <name>: quiet for 12 min mid-turn, nothing pending` | a stall, or a worker composing a large edit: the two read the same, and Priors at the Quiet Seams carries the base rates |
| `agent` | `agent <name>: turn ended 10 min ago, nothing outstanding` | a finished turn whose signal never came, or a wait on a message the lead owes: the two read the same. Tell reviewers explicitly to report back, and nudge when only an idle notification arrived |
| `agent` | `agent <name>: stopped by the lead` | the stop landed |
| `agent` | `agent <name>: moving again` | the wait or the quiet ended; a standing flag on it is void |
| `head` | `worktree <branch>: head moved to <sha12>` | the PII grep below, and every content claim about the track re-verified on the new sha |
| `wipe` | `worktree <branch>: 130 files at HEAD -> 3` | a commit on top of deleting the repo reads normal on every other reading; the tree is read before the track lands |
| `quiet` | `worktree <branch>: no worker process and no change for 2 polls` | the liveness line for a Codex or Copilot worker; expected on a parked worker, per the ledger |
| `active` | `worktree <branch>: active again` | the quiet ended: a worker is in the tree or the dirty tree changed; a standing flag on it is void |
| `gone` | `worktree <branch>: gone` | discovery no longer lists it: a landed track swept, or a removed worktree; the `sha` field is its last head |
| `trouble` | `fleet: <reason>` | the daemon could not take a reading: tooling trouble, never a quiet fleet; the `/session-events` skill's line after three failed polls is the same kind |
| `restored` | `fleet: process attribution restored` | lsof answers again after a trouble line; empty process lists are verified inactivity once more |

What stays the lead's, by hand: content claims through `probe.mts`, standing state in `ledger.mts`, the PII grep on every `head` event, `baseline.mts` at landings, and every nudge and directive. Codex and Copilot workers write no Claude transcript, so for them the daemon has only the worktree reading, the same rows a monitor subagent sweeps.

The instruments live in this skill's `scripts/`; `fleet/git.mts` and `fleet/processes.mts` are the worktree readings the daemon and `sweep.mts` share. Runtime: bun. `baseline.mts` needs it, since on first run it bundles its one dependency, `diff`, into the skill's `.build` folder; `sweep.mts`, `probe.mts`, and `ledger.mts` also run on Node 24.3+.

Every mechanical trap those scripts retire is deliberately absent from this file: self-matching greps, zsh word-splitting and glob aborts, the missing `timeout` binary on macOS, fragile hand-grepped token checks, counts standing in for the sets they approximate. A trap folded into a tested script cannot re-fire. Keeping its prose recipe around only invites hand-rolling the probe again.

What remains is the judgment layer: what the readings mean, when to act, and what the daemon cannot see. Every rule below comes from a false conclusion caught in production. Do not simplify them away, and do not hand-roll shell probes around the scripts: when a reading is missing, extend the script.

The measurement rules that are not monitor-specific live in the `/verify-with-controls` skill: evidence-or-error probes, positive and negative controls, suspecting the instrument, postconditions over logs, the look-then-send re-measure. This file keeps their monitor-specific instantiations and wiring.

Each script prints its contract with `--help`. This page quotes those blocks, and a test upstream keeps every quote equal to its script, so the script is the source where the prose around it disagrees.

## The Monitor Subagent

The fallback instrument is one subagent whose only job is watching the rest of the fleet. It wakes on a timer, runs the sweep, reads the ledger, and reports to the lead. One report, with the worktree names and shas as examples:

```text
sweep 14:20, ledger re-read, needles grep run on every moved head

| worktree    | head         | transition                                  | held since |
| ----------- | ------------ | ------------------------------------------- | ---------- |
| feat/parser | 1a2b3c4d5e6f | head moved, PII grep exit 1                 | 14:19      |
| feat/docs   | 9f8e7d6c5b4a | no worker process, tree still, 2 sweeps     | 14:10      |
| fix/ci      | 0f1e2d3c4b5a | parked by design per the ledger, no event   |            |

ack: directive 14:12 "hold feat/docs silent" is flag 3f9a in the ledger
```

Transitions only, two observations before any flag (Reading a Sweep), nothing an agent wrote quoted, and every lead directive acknowledged. A sweep with no transition to report and no directive to acknowledge sends nothing.

What the brief names, so the monitor never hand-rolls a probe:

- **`scripts/sweep.mts <repo-root>`**: the periodic sweep, one invocation per wake, read per Reading a Sweep.
- **`scripts/probe.mts`**: every content claim, never a raw grep (Content Claims).
- **`scripts/ledger.mts <file>`**: the standing state, re-read every sweep before any flag (Standing States).
- **`scripts/baseline.mts`**: pinned copies at landings (Pinned Copies).
- **`/tmp/fleet-<sessionId>/pii-needles.txt`**: the grep on every sweep where a row's `headSha` moved (PII on Every HEAD Move).
- **The cadence**: every 5 to 10 minutes, a scheduled wakeup where the harness offers one (Claude Code's cron tool), a sleep loop otherwise. Each sweep is one script invocation built to the Probe Cost budget, so the bound is noise, not load.

The reporting rules that are the monitor's:

- **Report at the seam where agents strand.** The brief states the report as the deliverable first and requires it in every branch, per `references/spawn-briefs.md`, Report-First for Watchers and Reviewers. The monitor is named because the lead addresses it mid-run.
- **An unacknowledged directive is undelivered**, so the monitor acknowledges every lead directive in its next report. The brief's line is `references/spawn-briefs.md`, item 11, and the lead's half, re-send or write it to the ledger, is Reporting Discipline's.
- **A flag is a question, never a verdict**: "no tree activity since 14:10; you will know whether its signal arrived". The lead holds whether the turn is open and whether a message landed (Priors at the Quiet Seams), and a worker's claim is forwarded with its read-back or as a claim (Reporting Discipline).
- **When messages cross, answer "already sent at 14:20"** rather than staying silent. Silence reads as an unmet obligation (seven crossings in one shift).
- **The stand-down is the one directive the lead does not wait on.** An idle monitor reads its inbox only when it next runs (in Claude Code, at its next tool round), so a stand-down can sit unread for 20+ minutes while the lead waits for an acknowledgement that cannot come. Once the fleet is landed, the lead sends it for the record and stops the monitor directly (Claude Code's TaskStop).
- Reporting Discipline's narration and retraction rules bind the monitor's reports too.

The boundary: the monitor reads worktrees, never transcripts. A Claude Code worker's waits, quiet turns, and ended turns live in its transcript, so for those workers the daemon's agent lines are the better instrument, and a lead who can run both runs the daemon.

## The Sweep

The one-shot reading is one command, `bun <skill-dir>/scripts/sweep.mts <repo-root>` (`<skill-dir>` is this skill's root). It prints, once, what the daemon reads from the worktrees on every poll with `--repo`:

```text usage=skills/orchestrator-mode/scripts/sweep.mts
usage: sweep.mts <repo-root> [--base <ref>] [--transcripts <dir>]
  --base <ref>         aheadBehind against this committish (e.g. origin/develop) instead of origin's default branch
  --transcripts <dir>  add one liveness line over the agent-*.jsonl transcripts in the directory
prints: one JSON line each, in this order, each only when its condition holds
  {"control":"FAILED","reason":...}          the sweep itself is broken
  {"lsof":{"ok":false,"error":...}}          process attribution is down (rows carry processes:[])
  {"lsof":{"ok":true,"degraded":true,...}}   lsof exited nonzero but produced records (lists may omit processes)
  {"defaultRef":{"ok":false,"error":...}}    origin's default branch is unresolvable (rows carry aheadBehind:null)
  {"baseRef":{"ok":false,"error":...}}       the --base ref is unresolvable or ambiguous (same, never a fallback)
  {"worktree":...,"ok":true,...}             one per worktree: branch, headSha, aheadBehind {ahead, behind}, treeFileCount,
                                             dirtyCount, untrackedCount, newestDirtyMtime, statusHash, processes [{pid, command, state}]
  {"worktree":...,"ok":false,"error":...}    vanished dir, git failure, or readings that moved mid-row
  {"transcripts":{...}}                      only with --transcripts: mtime, sizeBytes, lastEventAgeSeconds,
                                             lastEventType per agent
exits: 0 the sweep ran (ok:false rows included); 1 control failure; 2 usage error
```

It prints one JSON line per worktree of `<repo-root>` (one row, example values, wrapped here for width):

```json
{"worktree":"/repo/.claude/worktrees/agent-a1b2c3d4e5f60718","branch":"worktree-agent-a1b2c3d4e5f60718",
 "ok":true,"headSha":"0123abcd0123abcd0123abcd0123abcd0123abcd","aheadBehind":{"ahead":0,"behind":0},
 "treeFileCount":130,"dirtyCount":1,"untrackedCount":0,"newestDirtyMtime":"2026-01-01T00:00:00.000Z",
 "statusHash":"0123456789abcdef","processes":[{"pid":4242,"command":"bun","state":"S+"}]}
```

How to read the row:

- **The activity fingerprint is `headSha` plus `newestDirtyMtime` plus `statusHash`, all three together.** The newest mtime among dirty and untracked files catches edits. The HEAD sha catches clean amends and rebases (which move HEAD with no dirty files and an unchanged commits-ahead count).

  `statusHash` (the path-and-status set) catches deletion-only work, which the other two cannot see: a deleted path cannot be stat'd, so it bumps `dirtyCount` and the hash while `newestDirtyMtime` stays frozen.

  Never the git index, which can sit frozen at spawn time for 12.5 measured minutes while a worker writes hundreds of lines. The hash alone is not enough either: it freezes the moment a worker stops adding files and just keeps editing the same ones, which is exactly what `newestDirtyMtime` is there to catch.
- **`aheadBehind` is measured against a base sha pinned ONCE for the whole sweep**, so two rows of one pass cannot disagree because a fetch moved the ref mid-sweep. Across sweeps the mainline still moves: when readings contradict, re-fetch and re-read rather than trusting the earlier number.

  The base defaults to origin's DEFAULT branch. Pass `--base <mainline>` (any committish, e.g. `--base origin/develop`) for sessions targeting a non-default mainline, so the counts measure the branch the fleet actually lands on.

  An unresolvable or ambiguous `--base` ref is loud, never zeros and never a silent fallback to the default. The sweep emits a leading `{"baseRef":{"ok":false,...}}` line and rows carry `aheadBehind:null`.
- **`treeFileCount` (files at HEAD) is the repo-wipe detector.** HEAD sha, ahead/behind, dirty count, and mtimes all read normal for a commit stacked on top of a repo-wiping commit. Only the file count separates "committed its work" from "committed on top of deleting the repo".

  The comparison is executable from ONE sweep output. The main checkout is always emitted as the first row (it doubles as the positive control), so compare each worktree row's `treeFileCount` against the main-checkout row's. No hand-rolled base probe needed.
- **`processes` is attributed by lsof cwd, never argv.** Tools like `codex exec` run with the worktree as cwd but no path in argv, so an argv match shows zero processes for a builder mid-review and mimics the corpse signature exactly.
- `--transcripts <dir>` adds one liveness line covering every `agent-*.jsonl` transcript in the directory: `mtime`, `sizeBytes`, `lastEventAgeSeconds`, and `lastEventType` per agent.

A broken probe is loud, never zero:

- A vanished worktree or failed git reading is an `ok:false` row carrying its error.
- A row whose HEAD, branch, or gitdir moved mid-measurement refuses itself as `ok:false` rather than mixing two states (the next sweep re-measures).
- A degraded or downed instrument is a leading `{"control":"FAILED",...}`, `{"lsof":{"ok":false,...}}`, `{"defaultRef":{"ok":false,...}}`, or `{"baseRef":{"ok":false,...}}` line.
- Partial lsof visibility is its own documented state, not a failure. lsof exiting nonzero while still producing records emits `{"lsof":{"ok":true,"degraded":true,...}}`, and process lists may omit unreadable processes. Under degraded, an EMPTY `processes` list is NOT verified inactivity: treat it as unknown and escalate rather than reading absence into it.
- Exit 0 means the sweep ran, `ok:false` rows included. Exit 1 is reserved for a control failure (worktree discovery failed, or the main checkout's own row, the positive control, is impossible).
- A downed lsof, an unresolvable default branch, or an unresolvable or ambiguous `--base` ref still exits 0 with its warning line. So read the leading lines and the per-row `ok` fields, never the exit code alone. A dead sweep is an instrument failure, never a quiet fleet.

## Reading a Sweep

The row is data. These rules are what it means:

- **Two observations before any flag.** For "did anything happen" in a sweep: ALL THREE of `newestDirtyMtime`, `headSha`, and `statusHash` stable across two readings mean no commit landed and no file moved. Deletions are invisible to mtime, so the hash is load-bearing. The daemon's `quiet` reads only the first and third over two polls: no worker process, no dirty-tree change. A commit that landed is the `head` line, never the quiet.

  For "is anything happening now": judge the `processes` list by its command names and state codes across two sweeps. The sweep emits exactly `pid`, `command`, and `state` per process, nothing more.
- **Presence is not work.** A `processes` list that is a single shell row (one `zsh`/`bash` entry) parked on the worktree cwd reads as "alive" under a presence test and silently voids idle counts that should keep running. The daemon reads a lone shell row as presence, so its quiet count keeps running.

  A working agent shows WORKER rows: every process whose cwd is inside the worktree is its own row, so bun/node/test-host children appear alongside the shell.

  The sweep row cannot answer "is this lone shell childless and idle" (it carries no child list and no CPU). That is an escalation pair, run only when a suspicious row set warrants it: `pgrep -P <shell-pid>` for children, plus `ps -o pcpu=,stat= -p <pid>` for CPU and state.

  For `pgrep -P`, empty output with exit 1 means none, and ps's ppid column names the shell's PARENT, so it can never establish childlessness. Even then judge by children and state, never a single CPU sample. An I/O-bound test host reads near-zero CPU while fully busy.
- **A sleeping shell counts as alive.** A worker sleep-polling shows up as a `sleep` row beside its shell's row on the same worktree, and the daemon counts it alive: a discipline problem for the lead, never a corpse.
- **A zero `treeFileCount` on the main-checkout row makes the sweep report `control: FAILED` and exit 1.** It is never a wipe call and never a baseline for worktree rows, so the script refuses it. A zero that still appears means the main checkout's HEAD really is an empty tree. A zero on a WORKTREE row stays the wipe signal.

  The one instrument fault that produced it is fixed. Launched from inside a nested worktree, git read the cwd as a pathspec prefix and the row's `ls-tree` listed only paths under it, so sweep.mts read 0 on a healthy repo. Every row's git calls now run from the worktree itself and `ls-tree` carries `--full-tree`, so the reading no longer depends on the launch cwd.
- **Rebase-refreshed mtimes mimic editing.** Rebasing onto a moved mainline checks out every file the new base's commits touched, so their mtimes go fresh with zero work done. Before attributing "actively editing" after a branch-tip rewrite, check `dirtyCount` AND `untrackedCount`: both zero means no edits regardless of mtimes. (A monitor once reported a builder "actively editing" two files it never owned. They were the new base's.)

  The same trap at spawn: creating a worktree stamps EVERY checked-out file, so mtime-since-spawn cannot discriminate the agent writing from the checkout happening.
- **Size a track base-to-HEAD** (its branch-point commit to its HEAD), never `diff origin/main..HEAD`. For a behind track the latter also reverses every sibling landing in the gap (observed seven-fold deletion inflation). Reserve comparisons against the sweep's selected base for the ahead/behind counts the sweep already carries.
- The absence of a test runner's scratch directories does not mean no test is running, and a builder's work may live outside the directories a probe watches (infrastructure, CI config, docs).
- **Evidence is bound to a SHA and a moment.** Every amend or rebase expires every prior content claim about the commit. Re-verify on the new SHA rather than carrying counts forward (a track can cross four SHAs between first commit and landing).

  A working-tree capture is a DRAFT. A builder once rewrote a captured phrase before committing it, so any token handed onward is re-derived at commit time, never quoted from an uncommitted diff.

## Content Claims: probe.mts

Any claim about file content ("the sentence landed", "the key set matches", "this track touched only its territory") runs through the probe script, never a raw grep. `bun <skill-dir>/scripts/probe.mts <subcommand> ...`:

```text usage=skills/orchestrator-mode/scripts/probe.mts
usage: probe.mts <subcommand> ...
  probe count <file> <literal>        count whitespace-normalized matches, with evidence
  probe json-keys <file> [<file2>]    parsed key paths; with two files, the key-set diff
  probe set <repo-root> <base-ref>    changed files: committed (base..HEAD) + dirty union
  probe tokens <table.json> <root>    run a token table against a tree
prints: one JSON object; a match carries its start line's text and its line range (endLine);
  a tokens table maps tree-relative files to [{"text": ..., "expect": <n> | ">=1"}, ...]
exits: 0 ok (a measurement succeeded, or a check passed); 1 a failed check or a broken probe; 2 usage
```

Every result is evidence-bearing or a loud error, never a bare number:

- Each match carries the START line's text plus its line range. A whitespace-normalized match can span lines: `endLine` marks the span's last line, and the remaining lines are NOT attached, so open the file at that range to inspect the full span.
- Probed paths are existence-validated before any zero is trusted. JSON is parsed rather than grepped. Change sets union committed and dirty paths.
- Literal matching is fixed-string, token-bounded for ASCII word characters, and whitespace-normalized. An ASCII literal embedded in a longer word or filename does not count (so `release.yml` can never match `update-release.yml`). Every whitespace run in both literal and text collapses to a single space before matching, so a reflow that rewraps a paragraph across line boundaries cannot produce a false 0 by construction.
- Exit semantics differ by subcommand. `tokens` and two-file `json-keys` are checks: exit 0 is a verified pass, exit 1 a failed check. `count` and single-file `json-keys` and `set` are measurements: exit 0 means the measurement succeeded, and the verdict is yours to read from the value and evidence.

  Exit 1 is also any broken probe (a vanished file fails every token loudly, so a negative token can never read a missing file as 0 occurrences and silently pass). Exit 2 is usage.

A `tokens` table is a JSON object mapping tree-relative files to token lists, each token a `text` plus an `expect` of a non-negative integer or `">=1"`:

```json
{"docs/guide.md": [{"text": "the exact sentence that must appear twice", "expect": 2},
                   {"text": "the removed line that must stay gone", "expect": 0}]}
```

Per-locale content needs per-locale tokens: two locales can share a script and still differ in WORDS, so a claim verified against zh-cn wording says nothing about zh-tw. Each locale's file gets its own entry in the table.

The token-boundary guarantee is ASCII-only (word characters are `[A-Za-z0-9_-]`). For CJK or accented content boundaries are NOT enforced, so a short literal embedded in a longer word still matches. Make per-locale tokens distinctive by CONTENT (longer spans, punctuation anchors) rather than relying on word boundaries.

Pin each token to a stable PREFIX of its line, never through the line's terminal punctuation. A sentence extended in place turns its period into a comma, which breaks a through-punctuation token while the content it pinned survives (two production false positives had exactly this shape).

The judgment that stays with the operator:

- **A count is a pointer to go look. It is never a finding.** The probe attaches per-match evidence (the start line's text and the line range) precisely so you read it before flagging. For a match spanning lines, open the file at the range to see the full text.

  Three textbook alarms in one shift dissolved on printing the actual lines, among them dirty generated files whose generated rows were byte-identical.
- **Availability bias is an instrument defect.** A freshly-primed hazard becomes the assumed explanation for the next zero, and unlike a bad grep it produces a confident, plausible, well-written WRONG answer (a token read 0 from staleness and was diagnosed as the reflow split primed twenty minutes earlier). Reading the evidence lines is the only cure here too.
- **Every narrowed variant of a working probe is a NEW probe** and needs its own positive control before its empty is trusted. The rule and its worked example live in `/verify-with-controls`.
- **Resolve spreads and follow moved definitions by searching, never by pinned path.** A path-pinned check counts 0 and passes silently after the definition moves.

## PII on Every HEAD Move

The lead writes the session's needle file once at session start, outside the repository. The file never enters a worktree or a commit.

One fixed string per line: the real identifiers of the user and of anyone whose machine or accounts the session touches, the provenance phrases a real-data fixture carries (`measured from`, `real logs`), and, when a track replaces a fixture measured from real data, every full-precision ratio and 4+ digit integer of the old file. The `/pr-landing-discipline` skill's READY check shows the extraction.

On every head move (a daemon `head` event, or a sweep where a row's `headSha` moved: a commit, an amend, or a rebase), the instrument's holder greps every commit the track added since its branch point. It reads each commit's message and its own added lines, never the net diff: a fixture added in one commit and deleted in the next is still published by the first.

The holder is the lead on a daemon event, and the monitor subagent on its sweep, which flags a hit to the lead.

```bash
needles=/tmp/fleet-<sessionId>/pii-needles.txt; wt=<worktree>
out="$(mktemp)"; patches="$(mktemp)"
test -s "$needles" &&
  base="$(git -C "$wt" merge-base <base-remote>/<mainline> HEAD)" &&
  git -C "$wt" log --format=%B "$base..HEAD" > "$out" &&
  git -C "$wt" log -p --no-color --diff-merges=first-parent --format= "$base..HEAD" > "$patches" &&
  sed -n '/^+/p' "$patches" >> "$out" &&
  { grep -n -i -F -f "$needles" "$out"; echo "grep exit $?"; }
rm -f "$out" "$patches"
```

- The base is the track's branch point on the session's mainline (the same base-to-HEAD span the sizing rule above uses), pinned by `merge-base` at read time. Neither the `head` event nor the sweep row carries it.
- `--no-color` because the `+` filter reads the first byte of each line: under `color.ui=always` an escape code comes first and the filter selects nothing, a silent empty.

  `--diff-merges=first-parent` makes a merge commit show what it added against its first parent. `git log -p` shows no patch for a merge by default, so a needle typed in while resolving a conflict would otherwise never be read.

  Content merged in from the mainline shows up too. A hit there is read like any other and named as already-published mainline content when it is.
- `grep exit 1` is clean for this HEAD, and `grep exit 0` is a flag to the lead carrying the hit lines. No `grep exit` line means the needle file is empty or a git read failed, and the reading says nothing: the `&&` chain stops before the grep, so a broken probe cannot print a clean verdict.
- Only added lines are read: a track that redacts PII carries the PII in its removed lines by definition.
- The hit is read before it is flagged, like every other count in this file. A 4+ digit needle coinciding with a year or a sha fragment is named as such, and a hit on a provenance phrase is flagged against the fixture it describes.
- A commit pushed between two polls or sweeps is caught at the next one, not before the push. The check that runs before anything merges is the landing gate's. The PR-side text (title, body, comments) is also the landing gate's read, and this read covers what leaves a worktree as commits.

The landing gate in direct mode runs the same read over the frozen branch, with two additions the head-move read does not need: the whole replacement fixture (a retained old figure sits on an unchanged line, which no patch shows) and, for a patch still uncommitted, the index in place of `base..HEAD`, since HEAD has not moved.

Each variant is one `&&` chain into the same `$out`. With no replaced fixture, the `show` line becomes `: > "$out"`.

```bash
fixture=<path of the replaced real-data fixture>
# committed on the frozen branch
test -s "$needles" &&
  git -C "$wt" show "HEAD:$fixture" > "$out" &&
  base="$(git -C "$wt" merge-base <base-remote>/<mainline> HEAD)" &&
  git -C "$wt" log --format=%B "$base..HEAD" >> "$out" &&
  git -C "$wt" log -p --no-color --diff-merges=first-parent --format= "$base..HEAD" > "$patches" &&
  sed -n '/^+/p' "$patches" >> "$out" &&
  { grep -n -i -F -f "$needles" "$out"; echo "grep exit $?"; }
# staged, not yet committed: the index is the frozen content, and the message is the proposed one
message=<the proposed commit message>
test -s "$needles" &&
  git -C "$wt" show ":$fixture" > "$out" &&
  printf '%s\n' "$message" >> "$out" &&
  git -C "$wt" diff --cached --no-color > "$patches" &&
  sed -n '/^+/p' "$patches" >> "$out" &&
  { grep -n -i -F -f "$needles" "$out"; echo "grep exit $?"; }
```

## Standing States: ledger.mts

Per-worker standing state lives in a ledger file the LEAD creates at session start, so it survives the lead's context loss, a monitor handover, and a session handover. The lead reads every daemon event against it before acting, and a monitor subagent checks every would-be flag against it before reporting: a `quiet` on a parked worker is expected, a head move on one is not. `bun <skill-dir>/scripts/ledger.mts <file> <command>`:

```text usage=skills/orchestrator-mode/scripts/ledger.mts
usage: ledger.mts <file> <command> [args...]
commands:
  init                                create an empty ledger (never clobbers an existing one)
  state <worker> <state>              set standing state; states: active, dormant-by-design, landing-gate, landed-swept
  flag <worker> <text>                record a standing flag (an identical standing flag is refused)
  retract <flag-hash-prefix>          mark a flag retracted (unique prefix match)
  grant <worker> <wording> <glob...>  record a territory grant with its exact wording
  show [worker]                       print the whole ledger, or one worker
prints: one JSON result per command; mutations (state, flag, retract, grant) hold the <file>.lock lockfile
exits: 0 ok; 1 refused, not found, or a corrupt ledger; 2 usage
```

`init` does not create parent directories. Quote the `grant` wording and every glob, or the shell splits the wording and expands the globs:

```bash
mkdir -p /tmp/fleet-<sessionId>
bun <skill-dir>/scripts/ledger.mts /tmp/fleet-<sessionId>/ledger.json init
bun <skill-dir>/scripts/ledger.mts <file> grant <worker> "<wording>" "<glob>"...
```

Saves are temp-plus-rename atomic. `init` is an atomic create-if-absent (it never clobbers an existing ledger). The mutating commands (`state`, `flag`, `retract`, `grant`) run under a lockfile, and a mutation never proceeds unlocked.

So duplicate flags are refused globally even under concurrent writers, dormancy is a lookup, and grants keep their exact wording for later literal-vs-intent re-reads. Without this, a lead's "X is parked on purpose" decision evaporates at the next context compaction and the same false suspicion re-fires on each `quiet` event or sweep.

What still counts as an event on a parked worker:

- A `dormant-by-design` worker's only reportable events: its worktree vanishing, its HEAD moving (new commits appearing OR an amend/rebase, where the commits-ahead count may not change), or new dirty or untracked files appearing while parked.
- A `landing-gate` worker's branch may legitimately gain a fix commit or disappear entirely (verified landing).

Two disaster-shaped non-disasters:

- **HEAD == the measured base ref at 0-ahead/0-behind is the post-landing-swept signature only with a CLEAN tree**, and only when the session's selected mainline IS that measured ref. Pass `--base <mainline>` for sessions targeting a non-default mainline, so the signature reads against the branch the session actually lands on.

  With a dirty tree it is the opposite, a deliberate WIP collapse mid-build (rebase the WIP commits, then reset onto the new base). A 51-file package once read as vanished this way. The discriminators are the dirty count and the reflog, and `parent..HEAD` sizing is meaningless after the reset because HEAD is no longer the track's commit.
- **A falling insertion count on a removal track is the expected direction, not lost work.** Reconcile it arithmetically against the folded-in rounds instead of flagging.

## Priors at the Quiet Seams

- **The signal seam:** a committed-clean-quiescent worker (a `quiet` on its worktree, or `turn ended, nothing outstanding`) is MORE OFTEN mid-review or composing its signal than stranded. In one long-running deployment, 27 quiescences across the lineage's shifts produced zero confirmed strands. Read the line anyway (the one real strand is the one that matters), as a QUESTION with the benign explanations beside it, never as a verdict.

  The daemon reads whether the turn is open, a monitor subagent reads neither the turn nor the inbox, and whether a message landed is the lead's half either way. 26 of the 27 resolved by the worker visibly returning (today's `moving again`), and exactly ONE resolved only by lead escalation. That flag was load-bearing precisely because the instrument could not settle it alone.

  Name the state before measuring it. UNCOMMITTED-AND-STATIC (never committed, owes no message, and in that deployment ~14 minutes of stillness was normal) and the seam proper (committed, owes one) have different normals, and the wrong baseline measures against the wrong number. Calibrate the stillness baseline against the fleet's own observed normals: `--quiet-after` is that number.
- **The read-first prior:** a builder whose brief says read-the-landed-code-first is silent with nothing written for its first ten to twenty minutes, then produces substantial output in one go. Reading leaves no trace in trees or processes, only in the transcript, so for a Claude worker the daemon has at most a tool wait to say, and for a Codex or Copilot worker a worktree `quiet`. Neither is evidence of anything.
- **The output-composition twin:** the read-first prior's symmetric blind class. A worker composing a large edit batch or prompt shows no tree trace, no process trace, no transcript trace, and no message trace: the daemon says `quiet mid-turn, nothing pending`. FIFTY minutes of total silence was measured mid-generation on a healthy worker, identical to a corpse from the instrument's side.

  The bigger the batch, the longer the blind window, with no upper bound measurable from trees. Only the lead's half resolves it: no idle notification has arrived, and the brief asked for something that size. Only the delivery is visible, arriving all at once.
- **The meta-lesson:** a known-bad probe can re-enter through someone else's wording of a flag condition. Memory is no defence. Measuring again immediately before firing is.

  A near-miss stayed a near-miss only because the monitor of the day re-checked instead of trusting its own earlier authorization. The general bar (two observations decide whether to LOOK, a fresh re-measure immediately before sending decides whether to SEND) is `/verify-with-controls` rule 5.

## Reporting Discipline

The daemon says each state once on entering and once on leaving, so it never narrates an unchanged call and always retracts one that went void. A monitor subagent reports the same way (The Monitor Subagent). The rules below are the lead's: for its own record, and for what it tells the user and the workers.

**Standing state lives in the ledger, not in messages.** A message is a one-shot exchange, never a standing order, and the lead's own context compacts. Anything that must hold across polls goes into the ledger in the shape it represents, and every daemon event is read against it:

| The decision | Its ledger shape |
| --- | --- |
| "parked on purpose" | a `state` transition |
| a scope adjudication | a `grant` with its exact wording |
| a closed finding | a `retract` |
| an order with no dedicated shape (a hold-silent order, say) | a standing `flag` on the target worker (`flag` takes arbitrary text), retracted when lifted |

Production, from a monitor subagent whose standing state lived in messages: ten directives sent over six hours drained from its inbox in one batch, hours later, and meanwhile it re-raised closed items, quoted a superseded base rate, and sent a mistaken stand-down. So no standing state ever lives only in message history.

The rest:

- **A worker's claim without its read-back is a question, never a fact.** A signal saying "resolved", "subscribed", or "pushed" with nothing read back beside it (the API's `isResolved`, the daemon's `status` line, `git ls-remote origin refs/heads/<branch>`) is read as "the worker claims X; no read-back shown", and never enters the ledger as state.

  Production: a relay acknowledged two `watch` subscriptions the daemon's `status` never listed, so a merge went unseen. The brief side (the read-back named per claim) is `references/spawn-briefs.md`, Read-back reporting.
- **A send proves queuing, not delivery.** A worker mid-turn reads its inbox when it next runs (in Claude Code, at its next tool round), so a directive is in force only once acknowledged; until then, re-send or write it to the ledger. Re-send only a directive that is still current: every directive is idempotent per `references/spawn-briefs.md`, Directives and Steps Are Idempotent, and a superseded one re-sent restores stale intent.

  The monitor subagent's half, the acknowledgement in its next report, is The Monitor Subagent's.
- **Never re-send an unchanged call or flag**, to the user or to a worker: it is narration, and it trains the reader to skim the next one.
- **Retract the moment a call goes void** (a standing flag that is void is worse than no flag). Re-measure immediately before sending a call, a nudge, or a retraction alike, because all are equally perishable (a dirty state once lasted under 43 seconds, spanning the two commands of a single sweep).
- **Literal-vs-intent territory grants:** when a grant's wording and its evident intent diverge (a "one-line" note that measured +5/-4, or a `docs/**` grant that plainly meant the README's locale twins too), read the numbers against BOTH readings before deciding, and record the decision as a new `grant` with its wording. Never resolve the divergence silently in either direction. The ledger's `grant` command keeps the exact wording for exactly this re-read.
- **Never widen scope from an inferred rule. Only an explicit grant widens scope.** Pre-approving a file class because a repo rule seems to imply it fails OPEN and SILENTLY: the wrongly pre-approved class gets waved through at exactly the moment the independent check mattered. That is strictly worse than the one-message cost of asking.

  Production: a migrations/ script marked "expected" for a rename whose rendered path never actually changed. The rule's trigger condition did not hold.

  "Suspect my record first" guards against false accusations. It gives nothing against false permissions. When a rule seems to imply scope, verify its trigger condition, or simply do not pre-approve and ask when the file shows up.

## Probe Cost

Every poll's or sweep's worktree reading must be O(cheap), and `fleet/git.mts`, which the daemon and `sweep.mts` share, is built to that budget: status hash, dirty-file mtimes, HEAD sha, ahead/behind. Never a whole-tree filesystem walk, which collapses under wave-start I/O (parallel installs can kill consecutive sweeps at the command cap).

The row's one size-scaling reading is `treeFileCount`, backed by a per-worktree `git ls-tree -r` at HEAD, the sweep's heaviest git call. It reads the object store rather than walking the filesystem, but its cost still grows with tree size. Expensive walks belong at flag-time, against one worktree only.

## Pinned Copies: baseline.mts

A whole-file ownership claim is an exact copy pinned before the risky step and compared after it, byte for byte, so drift is a visible diff and never a count. `bun <skill-dir>/scripts/baseline.mts <command> ...`:

```text usage=skills/orchestrator-mode/scripts/baseline.mts
usage: baseline.mts pin <baseline-dir> <tree-root> <file...>
       baseline.mts check <baseline-dir> <tree-root>
  pin    copy the exact current content of each file (paths relative to tree-root) into baseline-dir, keeping
         the relative paths, and write a manifest.json listing the pinned set; if anything fails, the previous
         baseline is left untouched and every file is reported as pinned or not
  check  compare every manifest entry against the tree byte for byte; per file: identical | drifted (with the
         unified diff) | missing-in-tree | missing-baseline
prints: one JSON summary object on stdout; findings and unified diffs on stderr
exits: 0 clean; 1 drift found or ok:false; 2 usage error
```

## Verifying a Landing

- Verify by ancestry on the mainline's remote ref (e.g. `origin/main`), never by inferring from a worktree's disappearance.
- In a cherry-pick, rebase, or squash-merge landing workflow, verify by PATCH CONTENT (subject match + patch diff + files exist at the mainline's remote tip), never by sha. The worktree's sha is never the landed sha, so a sha-identity rule reports every successful landing as lost work.
- **The rebase is the risk, not the intent.** "Did this track touch the file" and "did this track's rebase preserve the file" are different questions. A clean replay can drop another landing's lines with no conflict marker, and the silent no-op is the failure that hides.

  The check is executable, not hand-minted. For whole-file ownership, pin exact copies before the rebase and check after. Drift, including a deleted line coming back, is a visible diff:

  ```bash
  bun <skill-dir>/scripts/baseline.mts pin   /tmp/fleet-<sessionId>/baseline <tree-root> <file...>
  bun <skill-dir>/scripts/baseline.mts check /tmp/fleet-<sessionId>/baseline <tree-root>
  ```

  For specific-line claims in shared files that several landings edit, run a `probe tokens` table (schema in Content Claims above) on every post-rebase tree and again on the mainline after each landing, regardless of what the track meant to touch. `"expect": 0` pins a line that must stay deleted.

  Check the number, never mere presence. In a removal wave the hazard inverts: the real failure is a DELETED line coming back, which a presence check cannot see, and three collisions in one production wave all had resurrection as their real hazard.
- **A rebase can silently no-op as well as silently drop.** Before an INDEPENDENT behind track (one whose branch does not already contain the sibling's content) rebases across a sibling's landing, run the SIBLING's token table against the un-rebased tree (it must FAIL there) and again after the rebase, where it must pass. The flip proves the replay genuinely happened, independently of the ahead/behind counts. Two measurements, one conclusion.

  The flip is INVALID for a dependent (stacked) successor. Its branch already contains the sibling's tokens before the restack, so the pre-restack probe correctly passes and the rule would report a false failure. Verify dependent successors by stack ancestry and the per-site postconditions in `references/landing.md` instead.
- **A disjointness claim is bound to when it was measured.** A track measured disjoint at spawn can grow into a real collision with a sibling that is already strict-ready. Re-verify with `probe set <worktree> <base>` whenever a track's file set grows, never once.
- **Executable landing baselines, negative-controlled.** For a wave where each landing ships whole files, keep one runnable per-landing check: file presence, a minimum size, and a structural count (exported symbols, section headings: something a mangled merge cannot preserve by accident). Then negative-control the CHECKER itself, in addition to its tokens, against a ref that lacks the files (the pre-landing mainline), per `/verify-with-controls` rule 6.

## The Daemon

The same readings run as a session-events source, `bun <skill-dir>/scripts/fleet-events.mts`, which the lead's session starts once as a background task and which delivers each agent's waits, stalls, and head moves as messages (its `--help`):

```text usage=skills/orchestrator-mode/scripts/fleet-events.mts
usage: fleet-events.mts <command> [options]
  daemon [--interval <s>] [--mode bypass|prompting] [--id <name> [--pid <pid>]]
  watch <target> [the source's flags] [--id <name>]
  unwatch <target> | --all [--id <name>]
  wait [--since <id>] [--timeout <s>] [--id <name>]
  poll | status | stop [--id <name>]
the daemon serves the Claude Code session named by CLAUDE_CODE_MESSAGING_SOCKET and exits with it;
--id <name> names a file-sink daemon for a non-Claude agent instead, --pid <pid> ends it with that process;
--mode is the session's permission mode, carried in the envelope: bypass (the default) or prompting;
--interval is 60 s by default, 1 to 86400
targets: session (this session's transcript and subagents dir, found by CLAUDE_CODE_SESSION_ID under ~/.claude/projects), or an absolute path to a session directory
--repo <root>            add the worktree reading for every worktree of this repository (absolute path)
--base <ref>             aheadBehind against this committish (default: origin's default branch)
--quiet-after <minutes>  a wait or a stall is this long before it is said (default 10)
the session-events skill must be installed beside this one; without it every command exits 2 naming the install: npx skills add Vivswan/skills -g --skill session-events
files: <dir>/<pid>-<start>.fleet-events.{state.json,events.jsonl,log} and <dir>/<pid>.fleet-events.sock for a session; <id>.fleet-events.* for a file sink;
  <dir> is $SESSION_EVENTS_DIR, else $XDG_RUNTIME_DIR/session-events, else $CLAUDE_CODE_TMPDIR/session-events-<uid>, else <os tmpdir>/session-events-<uid>, else /tmp/session-events-<uid>
prints: one message per poll with events, wrapped in <cross-session-message from="uds:<socket>" from-name="fleet-events" from-mode="<mode>"> and ending "automated notice from fleet-events; no reply needed";
  wait prints the new events as JSON lines, then cursor: <id>
exits: 0 ok (stop with no daemon running, and a second daemon start, are ok too); 2 usage, a state file that is not JSON, or no runtime directory;
       3 no daemon answers for this session: stderr names the socket and the background command that starts one; 4 wait only: the timeout passed with no newer line
```
