# Spawn Briefs

Every subagent spawn brief is self-contained. The agent may lack the task board, the plan, and the session history, so the brief carries everything. A brief, and any report a person reads back, follows the `/working-text` skill for its shape.

## The Owner's Standing Rules

Every brief to any builder or reviewer opens with the owner's standing rules, verbatim, before the task. The owner checks for them. The block below is the generic form: the lead pastes it as is, and no session path or identifier goes into it.

```text
OWNER'S STANDING RULES (verbatim at the top of every brief)
- Write for a reader who takes in pictures faster than prose. Everything the owner reads (PR title and body, page text, replies, your report) leads with a picture: a table, a before/after, a strip, a code block. Short sentences. No paragraph over 70 words. Explanations sit beside what they explain. Plain ASCII punctuation.
- Commits carry the identity the repository's AGENTS.md states, never a work account. No Co-Authored-By or "Generated with" trailers anywhere.
- Conventional Commit subjects. PRs open as drafts and are squash-merged. Never flip ready, never merge.
- Rubber-duck review with codex before every commit (the /rubber-duck-review skill), two rounds cap. Build only a finding with a concrete input and a wrong output inside the stated operating envelope. Reply to and record everything else.
- The pre-commit hook runs the reached tests. Never run the full check locally. Run the repository's static gates (typecheck, lint, docs check, smoke, validate) before pushing.
- Caps: 256 characters per code line, 70 words per Markdown paragraph, 3200 lines per test file. Skill scripts are .mts run with bun. No node_modules, nothing generated in git.
- PII grep over the diff, the commit message, and the PR text with the session's needle file prints nothing.
- Never touch the owner's configs: no ~/.codex, no ~/.claude settings, no dotfile of theirs.
- No CI watcher of your own: the lead's daemon watches every PR. Read back every write (push, reply, resolve). A thread reply counts only when its review state is COMMENTED, not PENDING.
- Read your inbox before every commit. One bundled brief per commit. When asked, confirm the list back to the lead before building.
- Clean up every temp file and worktree you create. Report with read-back facts (sha, counts, exit codes), never intentions.
```

The checklist below is what the rest of the brief carries. Items 16 and 17 name the needle file the PII line refers to, and item 19 the read-back commands.

## Checklist

Every brief includes:

1. **The full task contract inline.** Goal, acceptance criteria, and the definition of done. Never say "see task #N", because subagents may lack the board tools.
2. **An explicit file whitelist and do-not-touch boundary.** The territory the agent owns, plus any shared files with region-level grants (e.g. one CSS file's disjoint regions). This is what lets sibling branches merge without conflicts.
3. **The gates to run, targeted,** and the instruction to run its own review loop before signaling done.
    - A typecheck where the language has one, then only the tests the change and its proof touch: the changed files' tests, the named census or proof target, one e2e slice when a scenario is the target. Never the full suite, the repository's aggregate check command, or a lint-plus-build sweep: CI runs those. A wider local run states its reason (an unknown target) and happens at most once per PR.
    - The brief says whether CI minutes are metered or scarce (for example a private repository on a metered plan). Where they are, the full check runs locally once before the push instead. A brief that does not say is a question back to the lead, and a lead who is not sure asks the user.
    - Only as many gates run at once as the machine and the reviewer backend handle without stalling (about three is a safe start), every long run carries an explicit timeout, and a process is killed by the PID the agent spawned, never by pattern.
    - The install comes first. A fresh worktree has no installed dependencies. Hooks may fail without them, and some runners resolve the parent checkout's binaries and pass anyway, so the brief's first command after item 14's worktree preflight is the repository's own install (for example `npm ci`, `bun install --frozen-lockfile`, `uv sync`).

      After a lead directive, the builder's re-review prompt states what changed since the last round. When the directive changed the diff's shape, the builder rewrites the amended commit's body to match (the directive can say so explicitly): `--amend --no-edit` left stale bodies twice in one wave.
4. **How to signal completion** (e.g. message the lead) and the handoff contract: commit finished work to the worktree's branch (never push unless the brief says so) and include the branch name, commit subjects, and any escalations in the signal. The final signal is the only permitted stop.

    In PR-per-track mode the brief NAMES THE ACTOR: either the builder pushes its branch, opens the PR, and signals the URL and head, or it stays no-push and the lead does both. In a fleet the lead's own daemon has the PR, so a builder never runs `watch`; outside a fleet the default recipe stands.
5. **For a teammate-style (named) agent whose REPORT matters, the delivery mechanism itself:** the brief REQUIRES an explicit SendMessage to the lead carrying the report, as the agent's final act, and says why.

    In Claude Code the harness delivers nothing else for a named (teammate) spawn. An unnamed one-shot spawn's output comes back to the spawner automatically, but a named agent's final text reaches nobody. A teammate that ends its turn with the report as prose has reported to no one.

    Five silent strandings in one production session, and it bit again in a later one whose briefs only said "report to the lead".

    Codex hands a named agent's final output to the spawner on its own. The explicit message costs nothing there and keeps one brief shape across harnesses.
6. **The stop-and-wait ban** (below).
7. **The comment rules and the TODO ban** (below). Comments only for what code cannot show. Where the `/code-standards` skill is installed, the brief points builders at it for the full house standards.
8. **The out-of-territory rule:** anything broken or wrong found outside the agent's file whitelist is reported in the completion signal, never fixed silently. A silent out-of-territory edit collides with another agent's territory, and a silently dropped finding is lost.
9. **The inbox-reconciliation rule** (below): the final signal enumerates every lead message received, with one line of evidence per directive.
10. **The idempotency rule** (below): every directive and every briefed step is safe to arrive twice, late, or after the fact. A late arrival is also checked for supersession before acting, and genuinely non-idempotent operations are named in the brief.
11. **For a long-horizon watcher the lead still spawns (over something no daemon polls): the standing-state channel.** The brief names the session ledger as where standing state arrives, re-read on every check, and requires every lead directive received as a message to be acknowledged in the NEXT report, the per-report form of rule 9. The lead's side is `references/fleet-monitor.md`, Reporting Discipline.
12. **Scratch files go to /tmp, never the worktree, at a unique per-agent path.** A review prompt or helper script written into the worktree blocks the clean-tree landing criterion and is one `git add -A` away from riding into the commit.

    The /tmp path is a `mktemp -d` taken once or an agent-named directory, never a fixed name like `/tmp/commit-msg.txt`. Three builders in one session wrote their commit messages to that same path, and one track's commit carried another track's message (content unaffected).
13. **Prompt and scratch files are written with the harness's file-writing tool, one plain command per step.** Where the harness sandbox refuses heredocs or compound commands mentioning `git` (some Claude Code sandbox setups do, even for `git` inside a quoted prompt, as too complex to verify they stay inside the worktree), each refusal costs the builder a step. Five builders in one wave each rediscovered it.

    So the brief says: write prompt and scratch files with the harness's file-writing tool, or with one plain command where it has none, and restore a mutated source with `cp` from a `/tmp` backup rather than a git command chained into the mutation. The rule costs nothing where the sandbox is lenient.
14. **Every git command in the brief names the worktree: `git -C <absolute worktree path> ...`**, never `cd <worktree> && git ...`. The compound form trips item 13's sandbox rule where it applies, and `git -C` is one command. A shell's cwd is not a fact about the worktree: a teammate's cwd reset to the main checkout between turns, and its `git reset --soft` moved local main (restored, nothing pushed).

    The same holds for every cwd-sensitive tool: package scripts run as `bun run --cwd <worktree> <script>`, and `bunx` has no `--cwd`, so a formatter runs as `cd <worktree> && bunx biome check --write <files>` in one call. From another directory, `bunx biome check --write <absolute paths>` skipped the repository's biome.json and retabbed whole files (restored from the index), and `bun run test` fell through to the shell's `test` builtin.

    The builder's FIRST command is the preflight `git -C <worktree> rev-parse --show-toplevel`, before any install or edit. It must print back the ABSOLUTE worktree path the brief declares: never the main checkout's path, and never a mere "somewhere under the harness's default worktree directory" test (Claude Code's `.claude/worktrees/` is one harness's default, not a fact about the worktree).

    A worktree-isolated spawn once did not materialize, and the builder was editing the main checkout.
15. **The test rule: red-then-green for BEHAVIOR changes only.** A deletion with no behavior of its own (an unused setting, a dead path) is proved by a census, grep counts before and after, in the PR body or in the landing report with no PR. Never by a test manufactured so that something goes red.

    Every new test says in its name or first line what would drift silently without it, and one that restates the source it reads is deleted, not committed. Where the `/code-standards` skill is installed, its `references/tests.md` owns the rule. Briefs demanding red-then-green for every change produced eleven PRs of yaml-restating workflow tests in one day.
16. **The PII rule, in every builder brief, and applied by the lead to the brief itself.** Nothing the builder publishes (commits, PR title and body, code, test fixtures, docs, review replies, CI comments) tells a reader who the owner is, how they work, or how their machine is set up.

    The `/pr-and-issue-discipline` skill's `references/redaction.md` owns the definition, the one substitute per kind, and what stays. The brief points there rather than listing them. A builder treats brief text as safe to copy, so the lead redacts before pasting.

    Production: one builder lifted the owner's real account login from terminal output in its brief into test fixtures and a PR body (replaced with `work-bot`).

    The lead never pastes a value measured from the owner's environment into a brief. A figure the brief needs comes from a synthetic scratch corpus, per the `/code-standards` skill's `references/tests.md`, which also keeps the deletion census of item 15 real.

    Production: a statistical profile measured from the owner's real sessions sat committed as a test fixture until a later sweep found it. Replacing it took a hand-written fixture, a fingerprint grep of every old figure over the PR, and a history rewrite.

    The rule governs what the builder publishes, not the brief's plumbing: item 14's absolute worktree path stays in the brief as is, and the builder keeps it out of commits, PR text, and fixtures.
17. **The PII step, in every gate brief (the landing-gate review and any reviewer the lead spawns).** The gate greps the frozen content's added lines, the commit messages, the PR title and body, and the review replies with the session's needle file, per the `/pr-landing-discipline` skill's READY check.

    The needle file holds the real identifiers of the user and of anyone whose machine or accounts the session touches plus, when the change replaces a fixture measured from real data, every full-precision ratio and 4+ digit integer of the old file.

    The lead writes the needle file once at session start, outside the repository (`/tmp/fleet-<sessionId>/pii-needles.txt`), and the brief names its path. A provenance comment naming real data on a fixture is a finding whose fix is a hand-written fixture.

    The reviewer prompt in the `/rubber-duck-review` skill's `references/reviewer-prompt.md` carries the reading side of the same rule, which catches what a grep cannot (a quoted real configuration or log).
18. **The library check, in every builder brief that adds, moves, touches, reuses, or depends on a library-shaped category (parsers, fetchers, retry loops, and the rest of the list the `/code-standards` skill's `references/design.md` owns).** The lead fills it BEFORE spawning: `Library check: searched <registries or the repo's own tools>; <package> covers <what>, use it` or `...; nothing fits because <reason>`.

    The builder may not write the hand-rolled version while the line is empty, and reports a library it finds that the lead missed.

    The brief states the rule in one line (the `/code-standards` skill's "prefer a library over hand-rolling") instead of pointing at the whole skill. A concrete instruction such as "follow the sibling script" or "fix in place" never overrides it.

    The brief frames the outcome and names the library check, never the function the builder is to write. A brief that specifies behaviour at the function level ("refuse past the count-word max", "a parse-render round trip") pre-empts the search.
19. **Read-back reporting: every completion signal and every status claim states what the agent READ BACK from the system after acting**, never what it intended or ran. The brief names the read-back command for each claim it asks for, and the signal quotes that command's output beside the claim.

    ```text
    threads resolved    -> the GraphQL read: every node `isResolved: true` AND `hasNextPage: false` (else page on with `after:`; the API decides, never the reply you posted):
                           gh api graphql -f query='{repository(owner:"OWNER",name:"REPO"){pullRequest(number:N){reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}'
    a thread reply      -> the reply's own review state, since `gh api .../pulls/<n>/comments/<id>/replies` can file it into a PENDING review nobody else sees (replies from several builders sat unpublished while the threads showed resolved):
                           gh api graphql -f query='{node(id:"<the node_id the reply call returned>"){... on PullRequestReviewComment{pullRequestReview{id state}}}}'
                           `state` is COMMENTED, not PENDING; a PENDING one is submitted, `mutation{submitPullRequestReview(input:{pullRequestReviewId:"<id>",event:COMMENT}){pullRequestReview{state}}}`, then read back again
    a watch subscribed  -> the daemon's `status` line, quoted, naming the new target
    a push              -> `git -C <worktree> ls-remote origin refs/heads/<branch>`, equal to the HEAD it was meant to carry (never `rev-parse origin/<branch>`: a rejected push leaves that cached ref where it was)
    a PR opened/flipped -> `gh pr view <n> --json state,isDraft,url`
    worktree clean      -> `git -C <worktree> status --porcelain=v1 --untracked-files=all` prints nothing
    tests green         -> the launcher's own summary line, quoted (`bun run --cwd <worktree> test <files>` ends `N pass` / `0 fail` here), plus its exit code
    a merge             -> `git -C <worktree> fetch <base-remote> <mainline>` (the remote the PR merges into, never a fork remote), then
                           `git -C <worktree> merge-base --is-ancestor <track-tip> FETCH_HEAD`: exit 0 means a merge commit or fast-forward kept the ids and it landed, done.
                           Exit 1 is a squash or nothing landed, so prove content with a three-way merge, never a two-endpoint diff (a later mainline edit of a file the track touched fails that diff on a landed track):
                           `git -C <worktree> merge-tree --write-tree FETCH_HEAD <track-tip>` exits 0 and prints the id that `git -C <worktree> rev-parse 'FETCH_HEAD^{tree}'` prints = landed, the track adds nothing the mainline lacks.
                           A different id = not landed; name the paths: `git -C <worktree> diff --no-renames --name-only <FETCH_HEAD tree> <printed id>`. Exit 1 with a tree printed = a conflict; say so and name the paths it lists.
                           Exit 1 with no tree ("not something we can merge"), or any other exit, is a broken read, never a pass
                           (`--write-tree` needs git 2.38; plain commands only, since item 13's sandbox refuses `xargs` or `$(...)` around git)
    ```

    Three times in one session, each costing the lead a discovery cycle: a builder signaled "nothing pending" with four briefed review threads still open; a relay acknowledged two watch subscriptions the daemon never took (its `status` listed only the old target), so a merge went unseen; a builder reported threads "replied and resolved" before the API said so.

    The `/verify-with-controls` skill's rule 4 (the postcondition is the truth) is the general bar, and this item is its brief-side wiring. A claim with no read-back beside it is not a claim, and the lead bounces the signal. Item 9's one line of evidence per directive is a read-back too, never a restatement of the directive.

## The Stop-and-Wait Ban

In harnesses like Claude Code, a subagent's idle notification fires only when it has zero live children, so "I'll be woken when they complete" is always said to an already-complete state. Builders that stop to "wait for my background children" strand until someone nudges them.

If your harness has different notification semantics, verify them before relying on this. The ban on stopping to wait stands either way.

Every brief therefore states:

- Run gates, hooks, and reviews FOREGROUND.
- After fanning out sub-editors, the next action on wake is to read their output, never to wait again.
- No idle stop is permitted before the final signal.

When a stranded agent must be nudged anyway, the nudge states the mechanism ("this notification fires only with zero live children, so your child is done; read its output"). A bare "continue" lets it re-strand at the next seam.

One nuance from production: a notification can occasionally fire while an untracked grandchild (e.g. a git hook's process tree) is still alive. An agent acting on a "finished" child should verify the outcome it reads is settled, not trust the notification alone.

**The named-spawn trap (Claude Code):** an Agent-tool spawn WITH a `name` detaches and runs in the background even when the brief said `run_in_background: false`. Only unnamed spawns honor the synchronous flag. This single fact produced five strands across three builders in one production session, and each builder believed its reviewer was synchronous.

Briefs that tell a builder to run reviews synchronously must therefore say: spawn the reviewer UNNAMED, or use a foreground CLI invocation (`codex exec` in a foreground Bash call) that cannot detach.

## Report-First for Watchers and Reviewers

A watcher or reviewer's entire value is its report. The single most common failure is a silent idle stop at the report seam, observed repeatedly even in agents whose brief ended with a report instruction.

- **State the deliverable FIRST, not last:** "your ENTIRE value is one SendMessage to the lead; a stop without it is total failure".
- **Require that message in EVERY branch:** success, failure, empty output, tooling error ("report tooling trouble as tooling trouble, never as a red pipeline").
- **Briefs shaped this way reported unprompted.** Briefs with the instruction buried needed a nudge per run.

Better still, remove the seam: spawn one-shot watchers and gate reviewers UNNAMED where the harness delivers a completed agent's output to the spawner automatically (Claude Code does). A named watcher must remember to SendMessage at exactly the seam where agents strand.

Two report-seam strands in one production session were both named spawns whose harness would have delivered the same output for free. Reserve names for agents the lead must address mid-run.

## Test Fixtures That Touch Git

Two incident classes from one production session, each observed twice. Every brief for a track whose tests create or run git repositories carries both rules:

- **Fixture repos live in `mkdtemp` under `os.tmpdir()`, never inside the worktree, and fixture commits never land on the track's branch.** A test that runs `git init`/`git commit` in (or resolves paths into) the working tree wrote fixture commits onto the real branch and wiped the worktree twice when the fixture's cleanup ran against the enclosing repo.
- **Hermetic git env belongs in a launcher** that builds it before the test process starts: scrub `GIT_*`, set `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to `/dev/null`, set `GIT_CEILING_DIRECTORIES` over the repo root and tmpdir, a fixture identity, cwd outside the repository.
  - **The brief names the repository's launcher,** and the test entry point refuses a run launched any other way (a preload that checks the environment it was born with).
  - **A repository without one gets one as the first task,** since a per-suite scrub cannot reach a child spawned with the default environment.

  Git hooks export `GIT_DIR` and `GIT_INDEX_FILE` to anything they run, so tests run from a hook see the real repository: two corruption incidents in one session. Plus one canary escape that proved per-suite scrubbing cannot cover children spawned with a default env, since they inherit the environ from process birth, which no preload or in-process mutation reaches.

  Suites that build child envs by hand keep the same hygiene as belt-and-suspenders: scrub GIT_*, pin the /dev/null configs, set identity AFTER the scrub (`GIT_AUTHOR_NAME=fixture`, `GIT_AUTHOR_EMAIL=fixture@example.com`, `GIT_COMMITTER_NAME=fixture`, `GIT_COMMITTER_EMAIL=fixture@example.com`). But the launcher, not suite discipline, is what contains a leaky test.

## Territory Binds Children

A builder's file whitelist binds every subagent the builder spawns, and the brief must say so.

Production case: a builder's docs subagent silently edited an out-of-territory policy file to satisfy a fail-closed guard. The builder then reported the edit as "the lead's uncommitted amendment", an attribution invented by inference from a stale observation.

Two rules follow:

1. Out-of-territory events are escalated in the builder's own name with writer evidence (the child's transcript shows the Edit call), never attributed by inference.
2. Fail-closed guards can couple docs to code ATOMICALLY (a bidirectional registry sweep makes "code here, docs are lead territory" literally uncommittable). When a guard demands an out-of-territory file, the resolution is an explicit lead grant, not a silent edit and not a doomed ordering plan.

## Final Signals Reconcile the Full Inbox

A directive sent to a worker mid-turn queues invisibly and delivers only at its next tool round. The worker cannot see it while its long turn runs.

The dominant coordination failure this produces: the worker finishes its planned round, signals "done", and the queued directive silently drops. In one production session this cost a full extra round on four different builders, each of which sincerely reported completion while a lead message sat unread in its inbox.

The rule every brief carries: a FINAL SIGNAL must re-read the full inbox first and enumerate every lead message received since the last signal, with one line of evidence per directive ("fixed at file:line", "declined because X", "already done, see Y").

A signal that omits a pending directive is not a final signal. The lead bounces it, and the bounce costs more than the enumeration ever does.

The lead's side of the same rule: verify a signal against the directives actually sent, by probe, not by trusting the enumeration.

## Directives and Steps Are Idempotent

Messages cross constantly in a fleet: a directive can arrive twice, arrive late, or arrive after the worker already did the thing. Every directive and every briefed step is therefore written to be safe on re-arrival. The worker checks current state before acting, and an already-applied directive is a no-op to report ("already done, see Y"), never an error and never a redo.

Idempotency covers repeats, not ordering. A stale directive applied once can still overwrite newer intent (a late "add X" undoes a newer "remove X" even though both are individually idempotent). So a late arrival is also checked against the newest directive on the same subject: when a newer one supersedes it, the worker reports it as superseded and does not apply it.

The exception class is named, never assumed: genuinely non-idempotent operations (version bumps, counters, anything append-only) are called out in the brief and coordinated through the lead. Their directives state the target postcondition (bump to 1.7.0, never bump by one), so a repeat or late arrival verifies the postcondition and no-ops instead of redoing.

Production shape: two stacked builders each bumped the same manifest version by one. The double bump was absorbed only because a later rebase happened to collapse the two edits. The brief clause makes that coordination explicit instead of lucky.

## The TODO Ban

Builders may never leave TODO or FIXME markers. The work either happens in the same change or is surfaced as an escalation in the completion signal, for the lead to queue or put before the user. A TODO found in a diff at review time is a review finding.

## Example Brief

```text
OWNER'S STANDING RULES (verbatim at the top of every brief)
- Write for a reader who takes in pictures faster than prose. Everything the owner reads (PR title and body, page text, replies, your report) leads with a picture: a table, a before/after, a strip, a code block. Short sentences. No paragraph over 70 words. Explanations sit beside what they explain. Plain ASCII punctuation.
- Commits carry the identity the repository's AGENTS.md states, never a work account. No Co-Authored-By or "Generated with" trailers anywhere.
- Conventional Commit subjects. PRs open as drafts and are squash-merged. Never flip ready, never merge.
- Rubber-duck review with codex before every commit (the /rubber-duck-review skill), two rounds cap. Build only a finding with a concrete input and a wrong output inside the stated operating envelope. Reply to and record everything else.
- The pre-commit hook runs the reached tests. Never run the full check locally. Run the repository's static gates (typecheck, lint, docs check, smoke, validate) before pushing.
- Caps: 256 characters per code line, 70 words per Markdown paragraph, 3200 lines per test file. Skill scripts are .mts run with bun. No node_modules, nothing generated in git.
- PII grep over the diff, the commit message, and the PR text with the session's needle file prints nothing.
- Never touch the owner's configs: no ~/.codex, no ~/.claude settings, no dotfile of theirs.
- No CI watcher of your own: the lead's daemon watches every PR. Read back every write (push, reply, resolve). A thread reply counts only when its review state is COMMENTED, not PENDING.
- Read your inbox before every commit. One bundled brief per commit. When asked, confirm the list back to the lead before building.
- Clean up every temp file and worktree you create. Report with read-back facts (sha, counts, exit codes), never intentions.

Task: Add rate limiting to the API gateway (worktree branch: wt/rate-limit, worktree /repo/.claude/worktrees/wt-rate-limit).
Done means: middleware added, unit tests pass, gateway docs section updated.
Territory: src/gateway/** and tests/gateway/** only. Do NOT touch src/core/** or shared configs; report needed changes there in your signal instead of making them.
Environment (substitute the repository's own install, typecheck, and test commands): FIRST run `git -C /repo/.claude/worktrees/wt-rate-limit rev-parse --show-toplevel` and require that exact path back (a spawn's worktree can fail to materialize). Then `bun install --frozen-lockfile --cwd /repo/.claude/worktrees/wt-rate-limit` (a fresh worktree has no installed dependencies; hooks may fail without them). Every git command names the worktree the same way, `git -C <that path> ...`, never `cd && git`.
Gates: CI minutes are not metered here, so run TARGETED checks FOREGROUND until green: `bun run --cwd /repo/.claude/worktrees/wt-rate-limit typecheck`, then the repo's test launcher on the files your change and its proof touch (`bun run --cwd /repo/.claude/worktrees/wt-rate-limit test tests/gateway/`) with an explicit timeout. Never the whole suite or the repository's aggregate check command; CI runs those on the push or the PR. Stop a process by the PID you spawned, never by pattern. Then run your own review loop and fix findings before signaling. Red-then-green for behavior changes only; a deletion with no behavior of its own is proved by a census in the PR body (the landing report with no PR), not a test. Every new test names what would drift silently without it; one that restates the source it reads is deleted. In Claude Code spawn reviewers UNNAMED (named spawns detach there); write scratch/prompt files under your own `mktemp -d` in /tmp with the harness's file-writing tool, never here, never a fixed name like /tmp/commit-msg.txt, and never via a heredoc where the sandbox refuses heredocs and compound commands that mention git.
Handoff: commit finished work to wt/rate-limit (do not push). Your final act is one SendMessage to the lead (in Claude Code a named agent's final text reaches nobody) with the branch name, commit subjects, any escalations, and one line per lead message you received. Every claim in it quotes what you READ BACK after acting (the commit: `git -C /repo/.claude/worktrees/wt-rate-limit log -1 --format=%H`; a clean tree: `git -C /repo/.claude/worktrees/wt-rate-limit status --porcelain=v1 --untracked-files=all` printing nothing; a green gate: the launcher's summary line and exit code), never what you ran. Re-read your FULL inbox first: a signal that omits a pending directive is not a final signal.
Library check: searched npm and the repo's own tools; `rate-limiter-flexible` covers the fixed-window counters and the per-key limits, use it; the `/code-standards` skill's "prefer a library over hand-rolling" rule holds over every instruction above.
Rules: no TODO/FIXME markers; do the work or escalate it. Comments only for what code cannot show. No PII in anything you publish: nothing that tells a reader who the owner is, how they work, or how their machine is set up. The `/pr-and-issue-discipline` skill's `references/redaction.md` owns the definition, the one substitute per kind, and what stays. Read it before your first commit. Directives and your own steps must be safe to arrive or run twice or late: check current state first, report an already-applied one as a no-op, and report one superseded by a newer directive as stale instead of applying it. Never stop to "wait" for background children: after fanning out, your next action on wake is reading their output. The only permitted stop is your final signal.
```
