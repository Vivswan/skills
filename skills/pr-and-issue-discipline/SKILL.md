---
name: pr-and-issue-discipline
description: Use when opening a pull request, writing or changing its body or title, writing an issue, or replying to an issue reporter or outside contributor.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# PR and Issue Discipline

> Show the change, do not describe it: a fenced block is the text form of a picture, so the reader skims it and gets the change; the fewest words after, in the shape that fits the change; anything written for a tool or another agent sits in one collapsed section at the bottom.

These rules apply to any session that opens or updates a PR, writes an issue, or replies to an issue reporter or outside contributor. "The author" below is whoever prepared the change, human or agent, working alone or in a multi-agent session. What happens after the PR exists (draft flips, review rounds, who merges, the gates before landing) is the `/pr-landing-discipline` skill's moment.

## When to Apply

- Opening a pull request, or writing or changing its body or title
- Writing a bug report or issue
- Replying to an issue reporter or outside contributor
- Re-reading the body before the PR is offered to its reader

Open every PR as a DRAFT; from there the `/pr-landing-discipline` skill owns it: the draft flips, the babysit loop, who merges, and the gates before landing.

## PR Bodies: Show the Change, Shaped to It

Show the change rather than describe it. A PR body is text, so its picture is a fenced block: real captured output wherever behavior is observable, a diagram, table, or the contract's own shape where nothing runs. The reader skims the blocks and gets the change without reading a paragraph. Shape the body to the change; never force every PR through one template.

**Two parts.** Part one is for a human skimming: the change shown (the opening block, in one of the shapes below), then the fewest words. Part two, at the BOTTOM, is a single collapsible section, collapsed by default, for anything written for another agent or tool rather than the human reader:

```markdown
<details>
<summary>Technical details</summary>

...

</details>
```

- **Into part two:** reviewer guidance for bot reviewers such as Copilot, mechanism detail beyond `## How`, the recorded-not-built and accepted-deviation lists, gate and codex round counts, file-by-file notes, line counts that fit the stated purpose.
- **The test is the reader, not the item type.** Part one holds whatever the human needs to know or decide about this change; part two holds everything else. The list above is the default sorting, decided case by case: the codex round count is part two, but a finding from that round that changed what the change does, or left something undone, is part one.
- **Nothing in part one depends on part two.** A PR whose detail fits in part one has no part two.
- **The summary line is a heading.** The Readability rules below govern it: "Technical details" names content.

**Readability rules**, for PR bodies and issue replies alike (the Replies section below points here rather than restating them):

- **No blob of text.** No paragraph over three sentences.
- **Short bullets with bold lead-ins.** Tables and fenced blocks carry structure.
- **Headings name the content** ("What changed", "What the report shows"), never the reader's level: "In plain words", "Simple version", and "Non-technical summary" read as talking down.
- **As short as the change allows.** The blocks carry the change, the words only what no block can.

**Template check, once per session, at plan time.** Before the first PR or issue of the session, while still planning, resolve the choice once and reuse it for every PR and issue in that session:

1. Look for templates in the target repository, case-insensitively and at any extension (`.md`, `.txt`, none): `pull_request_template*` and `PULL_REQUEST_TEMPLATE*` at the repository root, in `.github/`, and in `docs/`, plus `.github/PULL_REQUEST_TEMPLATE/` and `.github/ISSUE_TEMPLATE/`.
2. None found: the shapes below apply directly. Do not ask.
3. Any found: ask the user once, in these words, "Use this repository's templates, or this skill's shapes?" Name the repository, say whether it is theirs or someone else's, and list the templates found by filename. A user who installed this skill often prefers its shapes, and a third party's maintainers usually expect their own, so ask rather than assume either way.
4. Carry the answer for the rest of the session, for every PR and every issue in it. Answer "the skill's shapes": use the shapes below throughout. Answer "the repository's templates": use the template whose purpose matches each artifact, without asking again; where the repository ships no template for that artifact (issue templates but no PR template, or the reverse), the shapes below fill the gap.

Whichever is chosen, the repository's `CONTRIBUTING` guidance still applies: honor its rules on title conventions, required sections, and linked issues inside the body you write.

### Additive feature

Its detail fits in part one, so it has no part two.

````markdown
## What this adds

```text
$ bun run shards --changed
manifest build/image-sets.json v3: 5 contexts, files and dependencies validated against the checkout
changed: api -> dependency closure {base, api} -> shards: [base, base+api]
```

## How

The resolver validates the manifest against the checkout, closes changed contexts over their dependencies, and emits the GitHub Actions matrix.

## Proof

- **Tests and gate:** manifest validation and shard-resolution cases pass (2 new), `bun run check` green.
````

### Existing behavior change or bug fix

Open with `Before` / `After` as real captured output; the comparison is the visualization. When nothing observable changes (a pure refactor), open with `## What this changes` and the same `## How` and `## Proof`.

````markdown
## Before

```text
$ bun run check
scripts/sweep.mts: probe timed out after 120s; agent marked dead (it was mid-build)
```

## After

```text
$ bun run check
scripts/sweep.mts: probe extended 120s -> 300s while the build lock is held; agent alive
```

## How

```text
before: probe start -> fixed 120s -> timeout -> agent marked dead (mid-build)
after:  probe start -> 120s up -> build lock held? -> extend to 300s -> live verdict
```

## Proof

- **Tests and gate:** 34 green (2 new), `bun run check` green.

<details>
<summary>Technical details</summary>

- **Reviewer note (Copilot):** the 300s ceiling is a constant in `scripts/sweep.mts`, not a flag; a flag was recorded, not built, since no second caller exists.
- **Proof detail:** one new test pins the extension while the lock is held, the other the plain 120s verdict without it.
- **Files:** `scripts/sweep.mts` (the probe), `tests/sweep-script.test.ts` (the two cases).

BEGIN_COMMIT_OVERRIDE
fix(sweep)!: extend the probe while the build lock is held

BREAKING CHANGE: `--probe-timeout` is removed; the probe extends itself while the build lock is held.
The probe's dead verdict can arrive up to 300s after start instead of at 120s; callers that raced it must re-read.
END_COMMIT_OVERRIDE

</details>
````

The block closing the details section is the commit-override rule below at work: this specimen's merge carries two breaks, so one `BREAKING CHANGE` footer lists them on two lines.

### Contract or documentation PR

Use `## What this specifies` when the PR defines a contract rather than executable behavior. Nothing runs, so show the contract itself (its schema, table, or layout) in a block, not in prose.

````markdown
## What this specifies

```text
SKILL.md                    disable-model-invocation: true
agents/openai.yaml          policy.allow_implicit_invocation: false   <- must pair with the line above

agents/openai.yaml          .codex-plugin/plugin.json
interface.display_name      == interface.displayName
interface.short_description == interface.shortDescription   (25-64 chars)
interface.brand_color       == interface.brandColor
```

## How

The smoke test reads the three files per skill and fails the build on any drift.

## Proof

- **Smoke test:** the mirrored-block and invocation-pairing cases pass.

<details>
<summary>Technical details</summary>

- **Accepted deviation:** `longDescription` is not mirrored; the codex manifest carries the long form alone.
- **Gates:** `bun run check` green; codex review converged in one round.

</details>
````

For every form:

- Blocks show, prose tells. Where behavior is observable, the opening block is an actual command and its actual output, complete enough to stand alone; never manufacture output or add it only to satisfy a format. Where nothing runs, the block is a diagram, a table, or the contract shape itself.
- `## How` has no mandated carrier. Use terse bullets, a small diagram, a table, or two short paragraphs, whichever explains the mechanism fastest. One carrier per point: a diagram followed by a paragraph re-explaining it means the diagram failed.
- `## Proof` names focused behavioral tests or stable checks, with numbers where they exist (tests, gates). Do not turn it into transient CI, approval, or review status.
- Write programmer to programmer: what changed, how the flow changed, in the reader's technical vocabulary, under the Readability rules above. The diff carries the detail; part one never narrates the implementation process, reduction history, transient status, future work, or the entire diff, and carries line counts only when they contradict the stated purpose (the `/pr-landing-discipline` skill's line accounting says when, and the reason comes with them). Reviewer guidance and gate or review round counts go in part two or nowhere; a scope caveat follows the reader test, part one when the reader must act on it or would be misled without it, part two otherwise.

**Redact captured output before publishing, and publish no PII anywhere.** Strip secrets, tokens, and credentials. PII is anything that tells a reader who the author is, how they work, or how their machine is set up. The rule covers everything a PR or issue publishes: titles, bodies, commit messages, code, test fixtures, docs, captured Before/After blocks, review replies, CI comments, and issue replies. Redaction is not paraphrase: the command and the output structure stay verbatim. This paragraph is the single definition; the skills that gate on it point here.

- **Identity.** Names, employers, real account logins and usernames, hostnames and machine names, home paths under a real user, emails. One substitute per kind: `octocat`, `work-bot`, or `example-user` for a login or username; `example.com` for an employer, a domain, or a hostname; `example-user@example.com` for a whole email, never just its host; `/home/user` or `~` for a home path; `/repo/...` for the checkout path (a captured row published with `/repo/...` in place of the machine's real checkout path is the worked example).
- **Anything measured or copied from the author's real environment.** Figures, statistics, and profiles computed from real logs or sessions; real settings, configuration, transcripts, and logs; inventories of what the author has installed or uses. All of it identifies the author with no name in it. Substitute: hand-written example values that show only what the text discusses, and the text says they are examples.

What follows from the second kind:

- **Fixtures are hand-authored, never derived from real data.** A fixture recorded from real data is PII the moment it is committed, and only a history rewrite removes it. The `/code-standards` skill's `references/tests.md` owns the fixture rule and the output-path rule for tools that measure real data.
- **A CI check posts no figure derived from real data.** It reports pass or fail and points at the artifact.

Specimens: a real account login copied from pasted terminal output into a test fixture and a PR body, shipped as `work-bot`; a statistical profile measured from the author's real sessions and committed as a test fixture, replaced by a hand-written one, every figure of the old file grepped out of the replacing PR, and the history rewritten to drop the original.

A product file name that happens to contain a vendor's word (a PowerShell profile filename, a devcontainer base image), a repository's own `owner/repo` coordinate in its install command, and the repository's own tooling and gates (the review tool a body's Gates line names, a check's run count) are facts about the repository, not the author, and stay.

**Release-please reads the body.** In a repository released by release-please, footers travel in the PR body as a commit-override block, whatever the squash setting put in the commit message. Release-please reads the merged PR's body at run time and, when it holds the block, parses that block in place of the commit message; a commit whose message it cannot parse is dropped from the changelog.

- **The marker words appear nowhere else in the body.** Release-please splits the body at the first occurrence of the opening marker, so a prose mention before the block ("the block below", spelled with the marker) becomes the message, fails to parse, and drops the commit from the release. Call it the commit-override block in prose; spell the markers only as the block itself.
- **One `BREAKING CHANGE` note per commit** (the last footer wins): several breaks go into one footer whose value spans several lines, one break per line, or into one `BEGIN_NESTED_COMMIT` / `END_NESTED_COMMIT` block per break.
- **A bad block is repaired after the merge** by editing the merged PR's body; release-please re-reads it on its next run, and the dropped commit returns to the release.

The override changes release-please's parsed message, not the git commit: a repository whose release tool reads the squash commit itself keeps its footers in that commit message, under its own rules. The block is written for a tool, so it is the last element inside the Technical details section; release-please matches the markers inside a `<details>` element. In a release-please repository, a PR whose merge must carry Conventional Commit footers (`BREAKING CHANGE`, `Release-As`) closes its details section with:

```text
BEGIN_COMMIT_OVERRIDE
<conventional subject line>

<footer>: <value, one line per break>
END_COMMIT_OVERRIDE
```

**Hand the body to `gh` on stdin, never through a guessable file.** A body drafted at `/tmp/<repo>-pr-body.md` was the specimen: two sessions on one machine picked the same name, and the second overwrote the first's. `gh pr create` and `gh pr edit` take `-` as the body file and read stdin, so a quoted heredoc carries the body with nothing to race over or clean up:

```bash
gh pr create --draft --title "<type(scope): subject>" --body-file - <<'EOF'
## What this changes
...
EOF
```

When the sandbox refuses the heredoc (an agent worktree can reject one whose text contains git commands, and captured output often does), stage the body in a directory `mktemp` minted, at the literal path it printed, and remove that directory in the same command that publishes, whatever `gh` returns:

```bash
# 1. Mint the directory; a harness that starts a fresh shell per tool call loses $body_dir, so copy the printed path by hand:
mktemp -d "${TMPDIR:-/tmp}/pr-body-XXXXXX"   # prints e.g. /tmp/pr-body-Kq3mZp
# 2. Write the body to <that path>/body.md with your Write tool.
# 3. Then, in one shell call, publish and remove the directory on every exit, success or failure:
body_dir="/tmp/pr-body-Kq3mZp"
trap 'rm -rf "$body_dir"' EXIT
gh pr create --draft --title "<type(scope): subject>" --body-file "$body_dir/body.md"
```

## Re-read Before the Human Reads

The body is written when the PR opens and read when the PR is offered; the diff moves in between. Before the offer (the flip to ready, the "ready to merge" report), re-read the body against the final diff as a reader who did not watch the session. How hard to look depends on how far the PR moved: a one-commit PR gets a glance at the Proof numbers, a PR that went through eight review rounds gets every claim re-checked. What usually drifts:

- **Every claim still true.** The opening block is still accurate (its After side, or its only side, is what the code does now), the Proof numbers are the final run's, and every file named as current still exists under that name.
- **Scope drift.** Work the review rounds added or removed is in the body, or its absence is deliberate.
- **Sorting.** Part one holds what the reader needs about the change as it is now. Anything that became detail moved down; anything that became important (a review finding that changed the change, a line count that contradicts the purpose) moved up.
- **Title.** Type and subject name what landed, not the opening plan.

A body that no longer matches is edited before the flip, never after the reader finds it.

## Issues: Same Principle

What breaks, shown first; then the minimum around it, under the Readability rules above.

The session's template answer, resolved at plan time above, covers issues too: fill the chosen issue template's fields and apply this principle inside them, or use the shape below when the answer was the skill's shapes or no template exists.

````markdown
## What breaks

```text
$ npx skills add Vivswan/skills --skill some-skill
installed: SKILL.md, README.md          (metadata.json silently missing)
```

## Repro

1. Add a `metadata.json` inside any skill folder.
2. Install with `npx skills add`.

## Expected vs actual

- **Expected:** every file in the skill folder installed
- **Actual:** `metadata.json` dropped without a warning
````

Include environment only when it matters: a version-specific parser bug names the version; a pure logic bug does not. When an issue includes captured output, the redaction rule above applies unchanged.

## Replies to Issue Reporters and Outside Contributors: Plain First

An issue reply or a review comment to an outside contributor is read by someone skimming a thread who does not know the code. Write a plain-language part that stands alone. Add a technical part, collapsed so it costs nothing to skip, only when it carries information the plain part cannot: when everything fits in plain words, the plain part is the whole reply.

Specimen: a diagnostics-only bug report whose log ended mid-request. The first reply opened with three paragraphs on hidden provider groups, tombstones, and silent refreshes. The rewrite:

`````markdown
## Questions

1. **What went wrong?** One or two sentences, or a screenshot.
2. **Is `https://<host>/@<user>` a LiteLLM proxy?** If yes, does it need an API key?
3. **Can you paste the log lines after the last request?** In VS Code: `View > Output`, pick `LiteLLM`, copy everything after the line starting with `Fetching from::`.

Number 3 would help the most. The rest of this comment explains why, if you are curious.

## What the report shows

**The report was sent before anything failed.** The last log line is the extension asking your server for its model list. No answer had arrived yet:

```
Fetching from:: "https://<host>/@<user>/v1/model/info"    <- last line, still waiting
```

- **The server you removed** pointed at `https://<host>/`. The extension remembers that and keeps its models out of the picker. That is expected, not an error.
- **The server you added** is at `https://<host>/@<user>` with no API key.

**A guess, to save a round trip:** a URL with `/@username` in it and no API key usually is not a LiteLLM proxy.

<details>
<summary>Technical details</summary>

- **Hidden provider group:** `Provider group is hidden by an explicit user removal` means the `servers` entry was removed. VS Code cannot delete a provider group, so the extension tombstones it and answers with an empty model list. Docs: [Lifecycle: renames, removals, hidden groups](...).
- **Where the log stops:** `Fetching from:: .../v1/model/info` is the first discovery request. The log buffer holds 50 lines and no error was recorded, so the report was built inside this request's 30 second timeout.

</details>
`````

The rules the specimen follows:

- **Questions first, under a `## Questions` heading.** They are questions, so ask them as questions: a numbered list, three at most, and say which one would help most.
  - Give the exact click path or command when one exists.
  - "What would help" rather than "what we need": the reporter is doing you a favor. The reader may stop after the list.
- **Part one is plain language, and never says so** (the Readability rules above own the heading rule).
  - Say what the reader did and what they see: "the server you removed" rather than "the tombstoned provider group". When a mechanism has no plain name, show its effect instead of naming it.
  - Quote the reader's own log line with an arrow note rather than paraphrasing it.
- **Part two is the technical reading, collapsed, and only when it adds something.** The same collapsible as a PR body's part two, with the same summary line.
  - Inside a `<details>` block: the mechanism names, the log lines mapped to code paths, docs links, and what a future maintainer would want when re-reading the thread. Nothing in part one depends on it.
  - A reply that says everything in plain words has no part two. An "expected behavior, here is the setting" answer needs no details block; the specimen's does, because the buffer size and timeout explain why the log stops where it does.
- **A guess goes last in part one and is labeled a guess.** It saves a round trip without steering the reader before they answer.
- The Readability rules and the redaction rule above apply unchanged.
