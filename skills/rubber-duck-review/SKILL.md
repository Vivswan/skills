---
name: rubber-duck-review
description: Use when asked to rubber duck a change, get a second opinion, or run an independent cross-model review of code changes.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Rubber Duck Review

Get a second opinion on code changes from a different model while you keep ownership of the task.

## When to Apply

Use this skill when someone asks for:

- `/rubber-duck-review`
- "rubber duck my changes"
- "get a second opinion on this"
- "review this with another model"

## Workflow

### 1. Pick the reviewer

- Prefer a dedicated review tool when one is available.
- Use a reviewer that is different from the current model when possible.
- If no dedicated tool exists, fall back to a read-only CLI invocation through this skill's `scripts/run-review.mts` (step 3). Pick the reviewer by which model *you* are:
  - If you are currently using **Claude** → `codex`, fallback `copilot`.
  - If you are currently using **Codex or GitHub Copilot** → `claude`, fallback `copilot`.
- **Never** let the reviewer write files, edit code, or run unrestricted shell commands.
  - The script enforces read-only flags: `--sandbox read-only` (codex) / `--permission-mode plan` (claude) / a read-only tool allow-list (copilot).
  - Read-only still lets the reviewer self-check: it can run read-only commands (grep, `git diff`, typecheck; copilot can only read and grep files) but writes are blocked. That self-checking makes findings concrete.
  - Note: a read-only sandbox can block temp-dir creation, so the reviewer may skip tests that need to write.

### 2. Craft the prompt

- Ask for a review of the relevant changes and surrounding context only.
- Always include: `This is a review-only task. Do not edit, write, or modify any files. Only read and report findings.`
- Tell it how to see the change (e.g. "run `git --no-pager diff HEAD` and read the new files") rather than pasting diffs; it follows imports and cross-file behavior better that way.
- Ask the reviewer to look for:
  - Correctness issues
  - Future-proofing risks
  - Naming or design choices that will become awkward as the codebase grows
  - Hardcoded assumptions that may become misleading later
  - Workarounds propped up by long justification comments: if it takes a paragraph-long comment to argue the workaround is OK, the code is wrong. Flag both the comment and the code for fixing.
- Fold in criteria from **companion skills**: for EVERY installed skill that declares a `## Review Criteria` section in its SKILL.md, expand that section into the reviewer prompt, and triage the resulting findings with that skill's own workflow.
  - There is no registry; declaring the section is what makes a skill part of the review. In this collection, `/no-invalid-states`, `/code-standards`, and `/never-twice` declare it.
  - Enumerate participants by grepping installed skills, e.g. `grep -rlE '^## Review Criteria' ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md 2>/dev/null` (adjust the paths to wherever your harness installs skills).
  - A skill whose criteria only apply in a specific context names its heading differently (e.g. `## <Context> Review Criteria`) and folds its own criteria into the reviews it launches itself.
- Ask for **prioritized** findings (blocking vs non-blocking), and ask it to say so plainly if the code is correct; this keeps re-reviews terminable.
- If the user has already declined or reverted something in this thread, add a short `Already decided / out of scope` section so the reviewer does not keep re-raising it.
- On a re-review, state which fixes were already applied so it focuses on what remains.

For a reusable prompt template, see `references/reviewer-prompt.md`.

### 3. Run the reviewer

This skill ships `scripts/run-review.mts` (the path is relative to the installed skill folder, not the repo under review). It encapsulates the launch pitfalls:

- spawns the reviewer from an argv array with no shell in between (backticks and `$(...)` in the prompt stay literal)
- closes stdin (both `codex exec` and `claude -p` block forever waiting on open stdin)
- captures the full stream to a scratch file under the OS tmp dir (never the working tree)
- passes each reviewer's required flags and extracts the verdict

Write the step-2 prompt to a tmp file and pass the reviewer name plus that file:

```bash
prompt_file="$(mktemp "${TMPDIR:-/tmp}/rubber-duck-prompt.XXXXXX")"
# write the step-2 prompt into "$prompt_file" (heredoc with a quoted delimiter, or your Write tool)
bun "<skill-dir>/scripts/run-review.mts" codex "$prompt_file"  # codex|claude|copilot per step 1
```

- Reviewer argument:
  - `codex`: runs `codex exec --json --sandbox read-only`.
  - `claude`: runs `claude -p --permission-mode plan --verbose --output-format stream-json` (`--verbose` is required with `stream-json`).
  - `copilot`: runs `copilot -p <prompt> -s --available-tools=view,rg,glob --deny-tool=write --deny-tool=shell --disable-builtin-mcps`. Last-resort fallback; prefer codex/claude. Its limits:
    - The read-only tool allow-list lets it read and grep files, but it cannot shell out, write, reach MCP servers, or spawn subagents.
    - No shell means no `git diff` and no typecheck, so name the files to read.
    - It does not stream JSON, so there is no liveness signal.
- `--stdin-prompt` (codex/claude only): add it if the environment rejects the prompt as a command argument, or the prompt is very large. The prompt file itself is served as the reviewer's stdin. A file fd is EOF-terminated, so it cannot hang; the stdin hang trap is an open pipe, not a used stdin.
- Foreground (the default) blocks until the reviewer exits, so give the tool call a generous timeout. Subagents (worktree builders, spawned workers) always run foreground: a worker that ends its turn waiting for a background reviewer's completion notification never gets one.
- `--background` prints the output-file path and the PID of a detached monitor that records the reviewer's exit status beside the stream. Leads use it to keep working while the review runs, then extract the verdict once it exits (step 4). Killing that PID cancels the review (the signal is forwarded to the reviewer).
- Progress: a foreground run prints at most two progress lines to stderr, one when the stream first shows life and one when the reviewer exits (a failure then adds its own `review FAILED` line). Silence in between is normal; a real review can take a while.
- Runtime: `bun`; `node` 24+ also works (`node "<skill-dir>/scripts/run-review.mts" ...`).
- Exit codes:
  - 0: verdict extracted and printed to stdout, or a `--background` launch started (that run's verdict comes later, via `--extract`).
  - 1: `review FAILED - relaunch`.
  - 2: usage error or reviewer binary not found.
- In this skill's home repository, a drift test (`tests/doc-drift.test.ts`) pins these citations (the reviewer invocations, the flags, the exit codes, the failure verdict) to `scripts/run-review.mts`. A rename on either side fails CI until doc and script move together.

### 4. Act on the printed verdict

- **Exit 0** from a foreground run or `--extract`: the verdict is on stdout. Triage it per steps 6-7: apply or reject each finding, and treat a plain "the code is correct" as convergence input, not a reason to skip re-review after fixes. (A `--background` launch also exits 0, printing only the output path and PID; its verdict comes from `--extract`.)
- **Exit 1** (`review FAILED - relaunch`): the stream was empty, cut mid-turn, truncated on its final line, blank, contained error events, or the reviewer exited non-zero. That is no review at all, never a clean pass. Relaunch it (the captured output path is in the failure message if you want to inspect why).
- **Exit 2**: fix the invocation or install the missing reviewer binary; nothing was reviewed.
- After a `--background` run exits, extract the verdict from the captured stream with the same rules and exit codes: `bun "<skill-dir>/scripts/run-review.mts" <reviewer> --extract <output-file>`, where `<reviewer>` is the same argument the review was launched with. It validates the reviewer and output file against what the launch recorded, and refuses to report a verdict until the run has recorded a successful exit beside the stream. So extracting too early, with the wrong reviewer, or from the wrong file fails safe.
- Failed and background runs keep their scratch dir (under the OS tmp dir, never the working tree) for inspection; `rm -rf` it once triaged. Foreground successes clean up after themselves. The script snapshots your prompt into that dir, so all review artifacts travel and clean up together; the mktemp prompt file you wrote remains yours to remove.

### 5. Large change sets: fan out one review per section

- A single broad review of a big diff is shallower than several focused ones. Split the change into logical **sections** (each new command/module, each script, the CI/release config, a parity pair) and run one review per section in parallel, each scoped to its files.
- **Don't over-parallelize.** Many simultaneous `codex exec` processes can saturate the backend and hang. If reviews stall, run them in smaller batches (2-3 at a time).
- **Detect & recover from hangs.** With JSON streaming, compare each review's event count over ~30-60s. If one is flat while its siblings climb, it's hung: stop it (the task runner's stop, or `pkill -f "<unique substring of that prompt>"`) and relaunch just that one.

### 6. Apply findings thoughtfully

- Treat valid "non-blocking" feedback as real work, especially when it points at design traps or future maintenance issues.
- Fix valid non-blocking findings as well as the blocking ones, including fixes that improve maintainability (clearer naming, removed duplication, simpler structure).
  - Skip a valid finding only when the fix would conflict with the design, reach outside the change under review, or go against an explicit user decision; record why.
  - A finding you judge incorrect or inapplicable is not skipped but rejected, per the next bullet.
- Do not blindly accept every finding. If you disagree, explain why, and watch for fixes that would conflict with the design (e.g. a suggested guard that breaks a legitimate path).
- If a finding conflicts with an explicit user decision, follow the user and record that the issue was intentionally skipped.
- Re-validate after each batch of fixes (typecheck / lint / tests) before re-reviewing.

### 7. Re-review until it converges

- After applying fixes, **re-run the review** on the updated state, one review per section, not a single overall pass.
- Repeat until **no valid blocking findings remain** and every non-blocking finding has been handled per step 6: fixed, skipped for a recorded reason, or rejected as incorrect or inapplicable. Treat that convergence as the gate; the `/review-before-commit` skill owns holding the commit until it opens.

### 8. If these instructions don't work, fix the skill

- Fix the skill when a step fails in practice and the root cause is the instructions themselves (a documented flag no longer exists, an extraction rule misses the verdict, a copy-paste block breaks in a reproducible way).
  - Work around it to finish the current review, then capture the fix so the next run doesn't rediscover it.
  - First rule out transient causes (backend outage, sandbox restriction, local tool config); those are not skill defects.
- This applies to **you, the driving agent**; the reviewer stays read-only per step 1.
  - Fix the skill only where you can edit its canonical source: in the authoring repo, edit the affected skill sources directly (`SKILL.md`, `references/`, or `scripts/`).
  - From an installed or vendored copy, or when you're not authorized to write, report the defect and your proposed fix to the user instead.
- Fold the root cause into the relevant step rather than appending a one-off note, and keep the copy-paste blocks runnable as written.
- A skill edit is a working-tree change like any other: finish the review with the corrected instructions, and put the edit through the same validate, review, and converge gate (steps 6 and 7).
