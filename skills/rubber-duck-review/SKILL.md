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
- If no dedicated tool exists, fall back to a read-only CLI invocation and try the first one that exists:
  - If you are currently using Claude:
    1. `codex exec --json --sandbox read-only "[prompt]"`
    2. `copilot -p --deny-tool='write' --deny-tool='shell' "[prompt]"`
  - If you are currently using Codex or GitHub Copilot:
    1. `claude -p --permission-mode plan "[prompt]"`
    2. `copilot -p --deny-tool='write' --deny-tool='shell' "[prompt]"`
- Never let the reviewer write files, edit code, or run unrestricted shell commands. `--sandbox read-only` lets it run read-only commands (grep, `git diff`, typecheck) but blocks writes — that self-checking makes findings concrete. (Note: a read-only sandbox can block temp-dir creation, so the reviewer may skip tests that need to write.)

### 2. Craft the prompt

- Ask for a review of the relevant changes and surrounding context only.
- Always include: `This is a review-only task. Do not edit, write, or modify any files. Only read and report findings.`
- Tell it how to see the change (e.g. "run `git --no-pager diff HEAD` and read the new files") rather than pasting diffs — it follows imports and cross-file behavior better that way.
- Ask the reviewer to look for:
  - Correctness issues
  - Future-proofing risks
  - Naming or design choices that will become awkward as the codebase grows
  - Hardcoded assumptions that may become misleading later
- Ask it to report **prioritized** findings (blocking vs non-blocking) and to **say so plainly if the code is correct** — this keeps re-reviews terminable.
- If the user has already declined or reverted something in this thread, add a short `Already decided / out of scope` section so the reviewer does not keep re-raising it.
- On a re-review, state which fixes were already applied so it focuses on what remains.

For a reusable prompt template, see `references/reviewer-prompt.md`.

### 3. Run it in the background, with streaming progress

- Launch the review in the **background** and capture output to a file; keep working while it runs. Read findings only when you need them to decide the next step.
- For `codex exec`, **always pass `--json`**. It streams JSONL events to stdout, which is the difference between a *live* review and a *silent hang*: a steadily growing event count means it's reading/reasoning; a file that stays flat for minutes means it's stuck.

  ```bash
  codex exec --json --sandbox read-only "$(cat prompt.txt)" > review.jsonl 2>review.err &   # full stream -> a file you can poll
  ```

- **Capture the FULL stream — never `tail`/`head`/`grep`-subset codex's output.** Redirect all of stdout straight to a file and poll that whole file. Piping codex through `tail`/`head` defeats liveness detection (the pipe buffers, so you can't tell if events are still arriving) and can truncate the final verdict. Subset only when *reading* a finished file, never on the live pipe.
- **Don't let the shell touch the prompt.** Backticks and `$(...)` inside a double-quoted shell argument are run as command substitution *before* codex starts — so a prompt that mentions `` `tar` `` or `` `git diff` `` silently executes them, mangling the prompt (you'll see stray errors like `tar: Must specify one of -c, -r, -t...` and **zero JSON events**). Write the prompt to a file and pass it as `"$(cat prompt.txt)"` — substitution results are not re-evaluated, so backticks in the file stay literal.
- A lightweight progress watch (event count over the whole file) tells you at a glance which reviews are alive vs frozen.
- **A progress watch must emit only TWO notifications, not one per tick.** A monitor that prints a status line every few seconds buries the conversation in noise. Emit exactly: (1) **once** when the streams first show life (event count > 1), and (2) **once** when every reviewer process has exited (the final verdict is ready). Stay silent in between — poll internally on a sleep loop, but only `echo` on those two transitions. Example monitor body:

  ```bash
  # Event 1: first sign of life.
  until [ "$(cat review*.jsonl 2>/dev/null | wc -l)" -gt 1 ]; do sleep 2; done
  echo "reviews alive"
  # Event 2: all reviewer processes have exited.
  while pgrep -f "codex exec --json --sandbox read-only" >/dev/null 2>&1; do sleep 5; done
  echo "reviews complete"
  ```


### 4. Extract the verdict from the `--json` stream

- The final answer is the **last** `item.completed` event whose `item.type` is `agent_message`. Codex emits *intermediate* `agent_message` narration as it works, so take the **last** one — not the first match.
- Watch for `error` events (e.g. `stream disconnected before completion`). If the last `agent_message` is narration rather than a findings list, the stream was cut mid-thought — relaunch that review.
- jq-free extraction:

  ```js
  let msg = null;
  for (const l of read(file).split("\n").filter(Boolean)) {
    try { const o = JSON.parse(l);
      if (o.type === "item.completed" && o.item?.type === "agent_message") msg = o.item.text;
    } catch {}
  }
  // msg = the final review; also scan for {"type":"error"} events.
  ```

### 5. Large change sets: fan out one review per section

- A single broad review of a big diff is shallower than several focused ones. Split the change into logical **sections** (each new command/module, each script, the CI/release config, a parity pair) and run **one review per section in parallel**, each scoped to its files.
- **Don't over-parallelize.** Many simultaneous `codex exec` processes can saturate the backend and hang. If reviews stall, run them in **smaller batches** (2–3 at a time).
- **Detect & recover from hangs.** With `--json`, compare each review's event count over ~30–60s. If one is flat while its siblings climb, it's hung — stop it (the task runner's stop, or `pkill -f "<unique substring of that prompt>"`) and relaunch **just that one**.

### 6. Apply findings thoughtfully

- Treat valid "non-blocking" feedback as real work, especially when it highlights design traps or future maintenance issues.
- Do not blindly accept every finding. If you disagree, explain why — and watch for fixes that would conflict with the design (e.g. a suggested guard that breaks a legitimate path).
- If a finding conflicts with an explicit user decision, follow the user and record that the issue was intentionally skipped.
- Re-validate after each batch of fixes (typecheck / lint / tests) before re-reviewing.

### 7. Re-review until it converges — before committing

- After applying fixes, **re-run the review on the updated state**, per section, not just once.
- Repeat until every section returns **no blocking findings**. Treat that convergence as the gate.
- **Review before you commit, not after.** Run the review on the working-tree changes, apply/triage findings, *then* commit — so a flaw can't land (or push) before anyone looks at it. This matters most where commits go straight to the main branch.
