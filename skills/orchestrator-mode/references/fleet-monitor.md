# Fleet Monitor

One subagent whose only job is watching the rest of the fleet. It starts a periodic check (a cron or scheduled wakeup where the harness offers one, a sleep loop otherwise) and messages the lead when any agent stalls or dies. Sweep every 5-10 minutes; each sweep is a single script invocation built to the Probe Cost budget below, so the bound is noise, not load. Reviewers sometimes idle without delivering: tell them explicitly to report back, and nudge if only an idle notification arrives.

The measurement mechanism lives in this skill's `scripts/` now. Every mechanical trap those scripts retire - self-matching greps, zsh word-splitting and glob aborts, the missing `timeout` binary on macOS, fragile hand-grepped token checks, counts standing in for the sets they approximate - is deliberately absent from this file: a trap folded into a tested script cannot re-fire, and keeping its prose recipe around only invites hand-rolling the probe again. What remains is the judgment layer: what the readings mean, when to flag, and how to report. Every rule below comes from a false conclusion caught in production. Do not simplify them away, and do not hand-roll shell probes around the scripts - when a reading is missing, extend the script. The flags, field names, and schema strings this file cites are pinned to the script sources by `tests/doc-drift.test.ts`: a rename on either side fails CI until doc and script move together.

## The Sweep

The periodic check is one command (`<skill-dir>` is this skill's root):

```bash
bun <skill-dir>/scripts/sweep.mts <repo-root> [--transcripts <dir>]
```

It prints one JSON line per worktree of `<repo-root>` (a real captured row, wrapped here for width):

```json
{"worktree":"/repo/.claude/worktrees/agent-a0e0514bb44bad3e8","branch":"worktree-agent-a0e0514bb44bad3e8",
 "ok":true,"headSha":"05387480f58e11df4f74776bb29b3a7e3f0871e0","aheadBehind":{"ahead":0,"behind":0},
 "treeFileCount":130,"dirtyCount":1,"untrackedCount":0,"newestDirtyMtime":"2026-08-26T07:41:36.177Z",
 "statusHash":"405808942a362a72","processes":[{"pid":5835,"command":"bun","state":"S+"}]}
```

How to read the row:

- `headSha` plus `newestDirtyMtime` answer "did anything happen": the newest mtime among dirty and untracked files plus the HEAD sha (a clean amend or rebase moves HEAD with no dirty files and an unchanged commits-ahead count) - never the git index, which can sit frozen at spawn time for 12.5 measured minutes while a worker writes hundreds of lines. `statusHash` fingerprints the path-and-status set only: it freezes the moment a worker stops adding files and just keeps editing the same ones, which is exactly what `newestDirtyMtime` is there to catch.
- `aheadBehind` is measured against a sha of origin's default branch pinned ONCE for the whole sweep, so two rows of one pass cannot disagree because a fetch moved the ref mid-sweep. Across sweeps the mainline still moves: when readings contradict, re-fetch and re-read rather than trusting the earlier number.
- `treeFileCount` (files at HEAD) is the repo-wipe detector: HEAD sha, ahead/behind, dirty count, and mtimes all read normal for a commit stacked on top of a repo-wiping commit; only the file count at HEAD versus the base separates "committed its work" from "committed on top of deleting the repo".
- `processes` is attributed by lsof cwd, never argv: tools like `codex exec` run with the worktree as cwd but no path in argv, so an argv match shows zero processes for a builder mid-review and mimics the corpse signature exactly.
- `--transcripts <dir>` adds one liveness line covering every `agent-*.jsonl` transcript in the directory: `mtime`, `sizeBytes`, `lastEventAgeSeconds`, and `lastEventType` per agent.

A broken probe is loud, never zero. A vanished worktree or failed git reading is an `ok:false` row carrying its error; a row whose HEAD, branch, or gitdir moved mid-measurement refuses itself as `ok:false` rather than mixing two states (the next sweep re-measures); a degraded or downed instrument is a leading `{"control":"FAILED",...}`, `{"lsof":{"ok":false,...}}`, or `{"defaultRef":{"ok":false,...}}` line. Exit 0 means the sweep ran, `ok:false` rows included; exit 1 is reserved for a control failure (worktree discovery failed, or the main checkout's own row is impossible - the positive control). A downed lsof or unresolvable default branch still exits 0 with its warning line, so read the leading lines and the per-row `ok` fields, never the exit code alone. A dead sweep is an instrument failure, never a quiet fleet.

## Reading a Sweep

The row is data; these rules are what it means:

- **Two observations before any flag.** For "did anything happen" require two sweeps of BOTH `newestDirtyMtime` and `headSha`; for "is anything happening now" judge the `processes` list by its command names and state codes across two sweeps - the sweep emits exactly `pid`, `command`, and `state` per process, nothing more.
- **Presence is not work.** A `processes` list that is a single shell row (one `zsh`/`bash` entry) parked on the worktree cwd reads as "alive" under a presence test and silently voids idle counts that should keep running. A working agent shows WORKER rows - every process whose cwd is inside the worktree is its own row, so bun/node/test-host children appear alongside the shell. The sweep row cannot answer "is this lone shell childless and idle" (it carries no ppid and no CPU): that is an escalation probe, run only when a suspicious row set warrants it - `ps -o ppid=,pcpu=,stat= -p <pid>` - and even then judge by children and state, never a single CPU sample: an I/O-bound test host reads near-zero CPU while fully busy.
- **A sleeping shell counts as alive.** A worker sleep-polling shows up in the sweep as a `sleep` row beside its shell's row on the same worktree - a discipline problem for the lead, never a corpse for the monitor.
- **Rebase-refreshed mtimes mimic editing.** Rebasing onto a moved mainline checks out every file the new base's commits touched, so their mtimes go fresh with zero work done. Before attributing "actively editing" after a branch-tip rewrite, check `dirtyCount` AND `untrackedCount`: both zero means no edits regardless of mtimes. (A monitor once reported a builder "actively editing" two files it never owned - they were the new base's.) The same trap at spawn: creating a worktree stamps EVERY checked-out file, so mtime-since-spawn cannot discriminate the agent writing from the checkout happening.
- **Size a track base-to-HEAD** (its branch-point commit to its HEAD), never `diff origin/main..HEAD`: for a behind track the latter also reverses every sibling landing in the gap (observed seven-fold deletion inflation). Reserve origin/main comparisons for the ahead/behind counts the sweep already carries.
- The absence of a test runner's scratch directories does not mean no test is running, and an infra builder's work lives outside `src/`.
- **Evidence is bound to a SHA and a moment.** Every amend or rebase expires every prior content claim about the commit; re-verify on the new SHA rather than carrying counts forward (a track can cross four SHAs between first commit and landing). A working-tree capture is a DRAFT: a builder once rewrote a captured phrase before committing it, so any token handed onward is re-derived at commit time, never quoted from an uncommitted diff.

## Content Claims: probe.mts

Any claim about file content - "the sentence landed", "the key set matches", "this track touched only its territory" - runs through the probe script, never a raw grep:

```bash
bun <skill-dir>/scripts/probe.mts count <file> <literal>       # lines with a token-bounded match, WITH the matched lines
bun <skill-dir>/scripts/probe.mts json-keys <file> [<file2>]   # parsed key paths; with two files, the key-set diff
bun <skill-dir>/scripts/probe.mts set <repo-root> <base-ref>   # changed files: committed (base..HEAD) + dirty, as one union
bun <skill-dir>/scripts/probe.mts tokens <table.json> <root>   # a token table (schema below) against a tree
```

Every result is evidence-bearing or a loud error, never a bare number: counts carry their matched lines, probed paths are existence-validated before any zero is trusted, JSON is parsed rather than grepped, and change sets union committed and dirty paths. Literal matching is fixed-string and token-bounded: a literal embedded in a longer word or filename does not count, so `release.yml` can never match `update-release.yml`. Exit semantics differ by subcommand: `tokens` and two-file `json-keys` are checks - exit 0 is a verified pass, exit 1 a failed check; `count` and single-file `json-keys` and `set` are measurements - exit 0 means the measurement succeeded, and the verdict is yours to read from the value and evidence. Exit 1 is also any broken probe (a vanished file fails every token loudly - a negative token can never read a missing file as 0 occurrences and silently pass); exit 2 is usage.

A `tokens` table is a JSON object mapping tree-relative files to token lists, each token a `text` plus an `expect` of a non-negative integer or `">=1"`:

```json
{"docs/guide.md": [{"text": "the exact sentence that must appear twice", "expect": 2},
                   {"text": "the removed line that must stay gone", "expect": 0}]}
```

The judgment that stays with the operator:

- **A count is a pointer to go look; it is never a finding.** The probe attaches the matched lines precisely so you read them before flagging. Three textbook alarms in one shift dissolved on printing the actual lines - among them dirty generated files whose generated rows were byte-identical.
- **Availability bias is an instrument defect.** A freshly-primed hazard becomes the assumed explanation for the next zero, and unlike a bad grep it produces a confident, plausible, well-written WRONG answer (a token read 0 from staleness and was diagnosed as the reflow split primed twenty minutes earlier). Reading the evidence lines is the only cure here too.
- **Narrowing a working probe can silently break it.** `git stash show --numstat stash@{0} -- <path>` returns empty - not because the stash misses the path, but because `stash show` takes no pathspec at all, so the narrowed command measures nothing. The wide probe was correct; the narrowed form was a different, broken instrument. Every narrowed variant of a working probe is a NEW probe and needs its own control: prove the narrowed form returns non-empty on a case that must match before trusting its empty.
- **Resolve spreads and follow moved definitions by searching, never by pinned path.** A path-pinned check counts 0 and passes silently after the definition moves.

## Standing States: ledger.mts

Per-worker standing state lives in a ledger file the LEAD creates at session start (so it survives agent context loss and monitor handovers), and the monitor checks every would-be flag against it before reporting:

```bash
mkdir -p /tmp/fleet-<sessionId>   # ledger init does not create parent directories
bun <skill-dir>/scripts/ledger.mts /tmp/fleet-<sessionId>/ledger.json init
bun <skill-dir>/scripts/ledger.mts <file> state <worker> <state>    # active | dormant-by-design | landing-gate | landed-swept
bun <skill-dir>/scripts/ledger.mts <file> flag <worker> <text>      # content-hashed; an identical standing flag is REFUSED
bun <skill-dir>/scripts/ledger.mts <file> retract <hash-prefix>     # retraction is a recorded transition
bun <skill-dir>/scripts/ledger.mts <file> grant <worker> <wording> <glob...>
bun <skill-dir>/scripts/ledger.mts <file> show [worker]
```

Saves are temp-plus-rename atomic, `init` is an atomic create-if-absent (it never clobbers an existing ledger), and the mutating commands (`state`, `flag`, `retract`, `grant`) run under a lockfile - a mutation never proceeds unlocked - so duplicate flags are refused globally even under concurrent writers, dormancy is a lookup, and grants keep their exact wording for later literal-vs-intent re-reads. Without this, a lead's "do not flag X, it is parked on purpose" instruction evaporates two rounds later and the same false suspicion re-fires each sweep. A `dormant-by-design` worker's only reportable events are its worktree vanishing, its HEAD moving (new commits appearing OR an amend/rebase - the commits-ahead count may not change), or new dirty or untracked files appearing while parked; a `landing-gate` worker's branch may legitimately gain a fix commit or disappear entirely (verified landing).

Two disaster-shaped non-disasters: **HEAD == origin/main at 0-ahead/0-behind is the post-landing-swept signature only with a CLEAN tree** - with a dirty tree it is the opposite, a deliberate WIP collapse mid-build (rebase the WIP commits, then reset onto the new base; a 51-file package once read as vanished this way), the discriminators are the dirty count and the reflog, and `parent..HEAD` sizing is meaningless after the reset because HEAD is no longer the track's commit. And **a falling insertion count on a removal track is the expected direction, not lost work** - reconcile it arithmetically against the folded-in rounds instead of flagging.

## Priors at the Quiet Seams

- **The signal seam:** a committed-clean-quiescent worker is MORE OFTEN mid-review or composing its signal than stranded - 27 quiescences across the lineage's shifts, zero confirmed strands. Raise the flag anyway (the one real strand is the one that matters), but frame it as a QUESTION with the benign explanations beside it, never an assertion: "no tree activity since X; you will know whether its signal arrived". The lead holds the half the monitor cannot see (whether the agent's turn is open, whether a message landed): 26 of the 27 resolved by the worker visibly returning, and exactly ONE resolved only by lead escalation - that flag was load-bearing precisely because the monitor could not settle it alone. Name the state before measuring it: UNCOMMITTED-AND-STATIC (never committed, owes no message; ~14 minutes of stillness is lineage-normal) and the seam proper (committed, owes one) have different normals, and the wrong baseline measures against the wrong number.
- **The read-first prior:** a builder whose brief says read-the-landed-code-first is silent with nothing written for its first one or two sweeps, then produces substantial output in one go. Reading leaves no trace in trees or processes - its silence is not evidence of anything, the same blind spot as composing a message.
- **The output-composition twin:** the read-first prior's symmetric blind class. A worker composing a large edit batch or prompt shows no tree trace, no process trace, and no message trace - FIFTY minutes of total silence measured mid-generation on a healthy worker, identical to a corpse from the monitor's side. The bigger the batch, the longer the blind window, with no upper bound measurable from trees; only the lead's half (an open turn, no idle notification) resolves it. Reading and writing are equally invisible - only the delivery is visible, and it arrives all at once.
- **The meta-lesson:** a known-bad probe can re-enter through someone else's wording of a flag condition. The defence is not memory, it is measuring again immediately before firing - a near-miss stays a near-miss only because the monitor re-checked instead of trusting its own earlier authorization. The two-observation bar decides whether to LOOK; a fresh re-measure immediately before sending decides whether to SEND - a flag that met the bar on genuine evidence was withheld because a re-measure 37 seconds later found the tree dirty again.

## Reporting Discipline

- Never re-send an unchanged strict call or an unchanged flag: it is narration, and it trains the lead to skim the next one.
- Retract the moment a call goes void - **a standing flag that is void is worse than no flag** - and re-measure immediately before sending a call or its retraction alike, because both are equally perishable (a dirty state once lasted under 43 seconds, spanning the two commands of a single sweep).
- When messages cross, answer "already sent at HH:MM" rather than staying silent; silence reads as an unmet obligation (seven crossings in one shift).
- **Literal-vs-intent territory grants:** when a grant's wording and its evident intent diverge (a "one-line" note that measured +5/-4; a `docs/**` grant that plainly meant the README's locale twins too), report the numbers and name BOTH readings - the lead adjudicates. Never resolve the divergence silently in either direction. The ledger's `grant` command records the exact wording for exactly this re-read.
- **Never widen scope from an inferred rule; only an explicit grant widens scope.** Pre-approving a file class because a repo rule seems to imply it (a migrations/ script marked "expected" for a rename whose rendered path never actually changed - the rule's trigger condition did not hold) fails OPEN and SILENTLY: the wrongly pre-approved class gets waved through at exactly the moment the independent check mattered. That is strictly worse than the one-message cost of asking. "Suspect my record first" guards against false accusations; it gives nothing against false permissions - when a rule seems to imply scope, verify its trigger condition or simply do not pre-approve and ask when the file shows up.

## Probe Cost

Routine sweeps must be O(cheap), and the sweep script is built to that budget: status hash, dirty-file mtimes, HEAD sha, ahead/behind - never a whole-tree filesystem walk, which collapses under wave-start I/O (parallel installs can kill consecutive sweeps at the command cap). Expensive walks belong at flag-time, against one worktree only.

## Verifying a Landing

- Verify by ancestry on the mainline's remote ref (e.g. `origin/main`), never by inferring from a worktree's disappearance.
- In a cherry-pick, rebase, or squash-merge landing workflow, verify by PATCH CONTENT (subject match + patch diff + files exist at the mainline's remote tip), never by sha: the worktree's sha is never the landed sha, so a sha-identity rule reports every successful landing as lost work.
- **The rebase is the risk, not the intent.** "Did this track touch the file" and "did this track's rebase preserve the file" are different questions: a clean replay can drop another landing's lines with no conflict marker, and the silent no-op is the failure that hides. The check is executable, not hand-minted. For whole-file ownership, pin exact copies before the rebase and check after - drift, including a deleted line coming back, is a visible diff:

  ```bash
  bun <skill-dir>/scripts/baseline.mts pin   /tmp/fleet-<sessionId>/baseline <tree-root> <file...>
  bun <skill-dir>/scripts/baseline.mts check /tmp/fleet-<sessionId>/baseline <tree-root>
  ```

  For specific-line claims in shared files that several landings edit, run a `probe tokens` table (schema in Content Claims above; `"expect": 0` pins a line that must stay deleted) on every post-rebase tree and again on the mainline after each landing, regardless of what the track meant to touch. Check the number, never mere presence: in a removal wave the hazard inverts - the real failure is a DELETED line coming back, which a presence check cannot see, and three collisions in one production wave all had resurrection as their real hazard.
- **A rebase can silently no-op as well as silently drop.** Before a behind track rebases across a sibling's landing, run the SIBLING's token table against the un-rebased tree - it must FAIL there - and again after the rebase, where it must pass: the flip proves the replay genuinely happened, independently of the ahead/behind counts. Two measurements, one conclusion.
- **A disjointness claim is bound to when it was measured.** A track measured disjoint at spawn can grow into a real collision with a sibling that is already strict-ready; re-verify with `probe set <worktree> <base>` whenever a track's file set grows, never once.
- **Executable landing baselines, negative-controlled.** For a wave where each landing ships whole files, keep one runnable per-landing check: file presence, a minimum size, and a structural count (exported symbols, section headings - something a mangled merge cannot preserve by accident). Then negative-control the CHECKER itself, not just its tokens: run it against a ref that lacks the files (the pre-landing mainline) and prove it FAILS there. A checker that has never been seen failing proves nothing when it passes.
