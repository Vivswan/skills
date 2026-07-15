---
name: rubber-duck-review
description: Cross-model code review using a second agent, tool, or read-only CLI fallback. This skill should be used when someone asks to rubber duck a change, get a second opinion, or run an independent review focused on correctness, future-proofing, and design quality.
license: MIT
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
- If no dedicated tool exists, fall back to a read-only CLI invocation. Pick by which model *you* are, then use the matching full pattern in step 3:
  - If you are currently using **Claude** → **Codex reviewer** (§3a): `codex exec --json --sandbox read-only`, fallback `copilot -p --deny-tool='write' --deny-tool='shell'`.
  - If you are currently using **Codex or GitHub Copilot** → **Claude reviewer** (§3b): `claude -p --permission-mode plan --verbose --output-format stream-json`, fallback `copilot -p ...`.
  - Always pass the prompt as `"$(cat "$prompt_file")"` (a file inside the scratch tmp dir, see §3) and append `< /dev/null`; the copy-paste blocks in §3a/§3b already do both.
- Never let the reviewer write files, edit code, or run unrestricted shell commands. `--sandbox read-only` (codex) / `--permission-mode plan` (claude) lets it run read-only commands (grep, `git diff`, typecheck) but blocks writes. That self-checking makes findings concrete. (Note: a read-only sandbox can block temp-dir creation, so the reviewer may skip tests that need to write.)

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
- Ask it to report **prioritized** findings (blocking vs non-blocking) and to **say so plainly if the code is correct**; this keeps re-reviews terminable.
- If the user has already declined or reverted something in this thread, add a short `Already decided / out of scope` section so the reviewer does not keep re-raising it.
- On a re-review, state which fixes were already applied so it focuses on what remains.

For a reusable prompt template, see `references/reviewer-prompt.md`.

### 3. Run the reviewer, with streaming progress

General principles (apply to **both** reviewers in 3a/3b below):

- **Put every artifact in a throwaway scratch tmp dir, never the working tree.** Create one per review and derive all paths from it:

  ```bash
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rubber-duck.XXXXXX")"
  prompt_file="$tmp_dir/prompt.txt"; out_file="$tmp_dir/review.jsonl"; err_file="$tmp_dir/review.err"
  ```

  Write the crafted prompt into `$prompt_file` (heredoc with a quoted delimiter, or your Write tool). Keeping `prompt.txt` / `review.jsonl` / `review.err` in a tmp dir means they can't be staged or committed by accident, and cleanup is a single `rm -rf "$tmp_dir"` once you've extracted the verdict. Run the launch + watch + wait sequence in **one shell invocation** so `$tmp_dir` stays in scope; shell variables don't survive across separate tool calls. For fan-out (step 5), give each section its own file names inside the dir (e.g. `$tmp_dir/review.api.jsonl`).
- Launch the review in the **background** and capture output to a file; keep working while it runs. Read findings only when you need them to decide the next step.
- **Redirect stdin from `/dev/null` (`< /dev/null`).** Both `codex exec` and `claude -p` read stdin for *additional* input on top of the prompt arg. When backgrounded, or run in a non-interactive tool shell with no TTY, they block waiting on stdin that never closes: codex prints `Reading additional input from stdin...` and emits **zero JSON events** (a silent hang that looks identical to "still thinking"). Always append `< /dev/null` so the prompt argument is the only input. This is the single most common cause of a review that never starts.
- **Keep the launching shell alive until every reviewer exits.** In short-lived tool shells, a backgrounded `claude`, `codex`, or `copilot` process can be reaped when the shell exits, leaving **zero-byte stdout/stderr files** and no error. Start the reviewer, store its PID, run the progress watch, and `wait` for that PID in the same shell invocation. Do not launch the process in one tool call and poll it from another unless the process has been detached with a mechanism you have verified in this environment. **If your tool shell can't reliably keep a backgrounded process alive, run the reviewer *foreground* with a timeout instead** (same command, drop the `&`/`wait`); a clean blocking run beats a reaped background one.
- **Always stream JSON** (`--json` for codex, `--output-format stream-json --verbose` for claude). A steadily growing event count means it's reading/reasoning; a file flat for minutes means it's stuck. A single final-object format gives no liveness signal during a long review. Do not treat an output file that is still empty after only a few seconds as failure; a real review can take a while to emit its first events.
- **Capture the FULL stream, never a `tail`/`head`/`grep` subset of the live pipe.** Redirect all of stdout straight to a file and poll that whole file. Piping through `tail`/`head` defeats liveness detection (the pipe buffers, so you can't tell if events are still arriving) and can truncate the final verdict. Subset only when *reading* a finished file.
- **Don't let the shell touch the prompt.** Backticks and `$(...)` inside a double-quoted shell argument run as command substitution *before* the reviewer starts, so a prompt that mentions `` `tar` `` or `` `git diff` `` silently executes them, mangling the prompt (stray errors like `tar: Must specify one of -c, -r, -t...` and **zero JSON events**). Write the prompt to a file in the scratch tmp dir and pass it as `"$(cat "$prompt_file")"`; substitution results are not re-evaluated, so backticks in the file stay literal.
- **A progress watch must emit at most TWO notifications, not one per tick.** Emit: (1) **once** when the streams first show life (event count > 1), and (2) **once** when every reviewer process has exited. A reviewer that exits before showing life produces only the second. Stay silent otherwise; poll on a sleep loop but only `echo` on those two transitions.

#### 3a. Codex reviewer (use when you are **Claude**)

Read-only via `--sandbox read-only` (allows grep / `git diff` / typecheck, blocks writes). Note `< /dev/null`.

```bash
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rubber-duck.XXXXXX")"
prompt_file="$tmp_dir/prompt.txt"; out_file="$tmp_dir/review.jsonl"; err_file="$tmp_dir/review.err"
cat > "$prompt_file" <<'PROMPT'
# ... your review prompt; see step 2 / references/reviewer-prompt.md ...
PROMPT

touch "$out_file"  # pre-create so the progress loop never reads a missing file
codex exec --json --sandbox read-only "$(cat "$prompt_file")" < /dev/null >"$out_file" 2>"$err_file" &
reviewer_pid=$!

# Event 1: first sign of life. Stay quiet until then.
alive_reported=0
while kill -0 "$reviewer_pid" 2>/dev/null; do
  line_count="$(wc -l < "$out_file" 2>/dev/null || echo 0)"
  if [ "$alive_reported" -eq 0 ] && [ "$line_count" -gt 1 ]; then
    echo "review alive"; alive_reported=1
  fi
  sleep 2
done

# Event 2: reviewer exited. Keep this wait in the launching shell.
wait "$reviewer_pid"; review_status=$?
echo "review complete (status=$review_status)"  # verdict in $out_file; rm -rf "$tmp_dir" when done
exit "$review_status"
```

Foreground fallback (no background management; blocks until done, so give the tool a generous timeout):

```bash
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rubber-duck.XXXXXX")"; prompt_file="$tmp_dir/prompt.txt"
cat > "$prompt_file" <<'PROMPT'
# ... your review prompt ...
PROMPT
codex exec --json --sandbox read-only "$(cat "$prompt_file")" < /dev/null > "$tmp_dir/review.jsonl" 2> "$tmp_dir/review.err"
```

#### 3b. Claude reviewer (use when you are **Codex** or **GitHub Copilot**)

Read-only via `--permission-mode plan` (no edits/writes). `--output-format stream-json` **requires `--verbose`**; without it Claude errors to stderr and stdout stays empty. Note `< /dev/null`.

```bash
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rubber-duck.XXXXXX")"
prompt_file="$tmp_dir/prompt.txt"; out_file="$tmp_dir/review.jsonl"; err_file="$tmp_dir/review.err"
cat > "$prompt_file" <<'PROMPT'
# ... your review prompt; see step 2 / references/reviewer-prompt.md ...
PROMPT

touch "$out_file"  # pre-create so the progress loop never reads a missing file
claude -p --permission-mode plan --verbose --output-format stream-json "$(cat "$prompt_file")" < /dev/null >"$out_file" 2>"$err_file" &
reviewer_pid=$!

# Event 1: first sign of life. Stay quiet until then.
alive_reported=0
while kill -0 "$reviewer_pid" 2>/dev/null; do
  line_count="$(wc -l < "$out_file" 2>/dev/null || echo 0)"
  if [ "$alive_reported" -eq 0 ] && [ "$line_count" -gt 1 ]; then
    echo "review alive"; alive_reported=1
  fi
  sleep 2
done

# Event 2: reviewer exited. Keep this wait in the launching shell.
wait "$reviewer_pid"; review_status=$?
echo "review complete (status=$review_status)"  # verdict in $out_file; rm -rf "$tmp_dir" when done
exit "$review_status"
```

Foreground fallback:

```bash
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rubber-duck.XXXXXX")"; prompt_file="$tmp_dir/prompt.txt"
cat > "$prompt_file" <<'PROMPT'
# ... your review prompt ...
PROMPT
claude -p --permission-mode plan --verbose --output-format stream-json "$(cat "$prompt_file")" < /dev/null > "$tmp_dir/review.jsonl" 2> "$tmp_dir/review.err"
```

> `copilot -p --deny-tool='write' --deny-tool='shell' "$(cat "$prompt_file")" < /dev/null` is the secondary fallback for either side; it does not stream JSON, so you lose the liveness signal. Prefer codex/claude above.

### 4. Extract the verdict from JSON streams

- For Codex JSONL, the final answer is the **last** `item.completed` event whose `item.type` is `agent_message`. Codex emits *intermediate* `agent_message` narration as it works, so take the **last** one, not the first match.
- For Claude `--output-format stream-json`, the final answer is the `result` string on the final `{"type":"result", ...}` event. If the stream ended before a result event, use the last `{"type":"assistant", "message": ...}` text only as a partial/incomplete clue and relaunch if needed.
- Watch for `error` events (e.g. `stream disconnected before completion`). If the last `agent_message` is narration rather than a findings list, the stream was cut mid-thought; relaunch that review.
- jq-free extraction:

  ```js
  let msg = null;
  for (const l of read(file).split("\n").filter(Boolean)) {
    try { const o = JSON.parse(l);
      if (o.type === "item.completed" && o.item?.type === "agent_message") msg = o.item.text;
      if (o.type === "result" && typeof o.result === "string") msg = o.result;
    } catch {}
  }
  // msg = the final review; also scan for {"type":"error"} events.
  ```
- Once you've extracted the verdict, remove the scratch dir: `rm -rf "$tmp_dir"`. On a re-review (step 7), start a fresh `mktemp -d` rather than reusing the old dir.

### 5. Large change sets: fan out one review per section

- A single broad review of a big diff is shallower than several focused ones. Split the change into logical **sections** (each new command/module, each script, the CI/release config, a parity pair) and run **one review per section in parallel**, each scoped to its files.
- **Don't over-parallelize.** Many simultaneous `codex exec` processes can saturate the backend and hang. If reviews stall, run them in **smaller batches** (2–3 at a time).
- **Detect & recover from hangs.** With JSON streaming, compare each review's event count over ~30–60s. If one is flat while its siblings climb, it's hung: stop it (the task runner's stop, or `pkill -f "<unique substring of that prompt>"`) and relaunch **just that one**.

### 6. Apply findings thoughtfully

- Treat valid "non-blocking" feedback as real work, especially when it highlights design traps or future maintenance issues.
- Do not blindly accept every finding. If you disagree, explain why, and watch for fixes that would conflict with the design (e.g. a suggested guard that breaks a legitimate path).
- If a finding conflicts with an explicit user decision, follow the user and record that the issue was intentionally skipped.
- Re-validate after each batch of fixes (typecheck / lint / tests) before re-reviewing.

### 7. Re-review until it converges, before committing

- After applying fixes, **re-run the review on the updated state**, one review per section, not a single overall pass.
- Repeat until every section returns **no blocking findings**. Treat that convergence as the gate.
- **Review before you commit, not after.** Run the review on the working-tree changes, apply/triage findings, *then* commit, so a flaw can't land (or push) before anyone looks at it. This matters most where commits go straight to the main branch.

### 8. If these instructions don't work, fix the skill

- If a step in this skill fails in practice and the root cause is the instructions themselves (a documented flag no longer exists, an extraction rule misses the verdict, a copy-paste block breaks in a reproducible way), work around it to finish the current review, but don't stop there: capture the fix so the next run doesn't rediscover it. First rule out transient causes (backend outage, sandbox restriction, local tool config); those are not skill defects.
- This applies to **you, the driving agent**; the reviewer stays read-only per step 1. Fix the skill only where you can edit its canonical source: in the authoring repo, edit the affected skill sources directly (`SKILL.md`, `references/`, or `scripts/`). From an installed or vendored copy, or when you're not authorized to write, report the defect and your proposed fix to the user instead.
- Fold the root cause into the relevant step rather than appending a one-off note, and keep the copy-paste blocks runnable as written.
- A skill edit is a working-tree change like any other: finish the review with the corrected instructions, and put the edit through the same validate, review, and converge gate (steps 6 and 7) before it is committed.
