---
name: reply-and-review-discipline
description: Use when replying to an issue reporter or outside contributor, or reviewing someone else's pull request.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Reply and Review Discipline

> Someone else's thread: the reader skims it and does not know the code, and whatever is written there publishes under the user's name. Plain words first, the reader's own log lines with arrow notes, questions only when the report does not answer them, and on a PR one pending review the user publishes.

These rules apply to any session writing on a thread it does not own: an issue reply, or a review of someone else's PR. The user's own PR or issue is the `/pr-and-issue-discipline` skill's moment. Its Readability rules and its redaction rule apply here unchanged; they are stated there, once.

`/unslop`, where installed, runs last over every reply and staged comment: it publishes under the user's name, so no AI tells.

## When to Apply

- Replying to an issue reporter or outside contributor
- Reviewing someone else's PR under the user's account

## Replies to Issue Reporters: Plain First

An issue reply to an outside contributor is read by someone skimming a thread who does not know the code. Write a plain-language part that stands alone. Add a technical part, collapsed so it costs nothing to skip, only when it carries information the plain part cannot: when everything fits in plain words, the plain part is the whole reply.

A staged review comment on someone else's PR follows the Each comment rules below and borrows only this section's voice.

**The report decides the opening**: read the reporter's log before writing a word. A question is asked only when the report does not already answer it, so the two shapes open differently: cause visible, diagnosis and steps; cause unknown, questions. Defaulting to questions is the failure the specimens were written against.

```text
cause visible in the log                    cause not in the log
------------------------------------        ------------------------------------
## What the report shows                    ## Questions   (3 at most; say which helps most)
   their log lines, with arrow notes        ## What the report shows
## What to do                                  their log lines, with arrow notes
   1. ...  2. ...  3. ...                      a guess, labeled a guess, last
   one fallback line: what to paste next    <details> Technical details </details>   (only when it adds something)
```

Full specimens of both shapes, and the two-language layout: `references/issue-replies.md`.

- **Cause visible: `## What the report shows`, then a numbered `## What to do`.** The reader's own log lines with arrow notes carry the diagnosis, and each numbered step carries its exact click path or command when one exists. One fallback line closes part one, saying what to paste if the steps do not fix it, and no `## Questions` heading appears.
- **Cause unknown: `## Questions` first.** A `## Questions` heading exists only when the diagnosis genuinely depends on the answers. Ask them as questions: a numbered list, three at most, and say which one would help most.
  - Give the exact click path or command when one exists.
  - "What would help" rather than "what we need": the reporter is doing you a favor. The reader may stop after the list.
- **Part one is plain language, and never says so** (the Readability rules own the heading rule).
  - Say what the reader did and what they see: "the server you removed" rather than "the tombstoned server entry". When a mechanism has no plain name, show its effect instead of naming it.
  - Quote the reader's own log line with an arrow note rather than paraphrasing it.
- **Part two is the technical reading, collapsed, and only when it adds something.** The same collapsible as a PR body's part two in the `/pr-and-issue-discipline` skill, its summary line in the half's language (`Technical details`, `Détails techniques`).
  - Inside a `<details>` block: the mechanism names, the log lines mapped to code paths, docs links, and what a future maintainer would want when re-reading the thread. Nothing in part one depends on it.
  - A reply that says everything in plain words has no part two. The visible-cause specimen has none; the mid-request one's exists because the buffer size and timeout explain why the log stops where it does.
- **A guess goes last in part one and is labeled a guess.** It saves a round trip without steering the reader before they answer.
- **The reporter's language first, then English.** When the reporter writes in another language, or their pasted text reveals one (a localized error message, a UI label), the reply carries both: the full reply in the reporter's language, then the full reply in English.
  - Each half is complete on its own, with its own details block when the reply has one. Neither half is a summary of the other.
  - The two halves sit in one comment, a rule between them; layout in `references/issue-replies.md`.
- The Readability rules and the redaction rule apply unchanged, to both halves of a two-language reply.

## Reviewing Someone Else's PR: One Pending Review

The agent reviews under the user's account, so publishing is the user's act: they publish the staged review themselves, or they tell the agent to post a verdict they have decided. Every comment goes into ONE pending review for the user to edit and publish. Never a standalone comment on someone else's PR: it publishes at once, under the user's name, unedited.

**Pick the lenses before reading, once per PR.** Who owns the repository sets the recommendation, not who wrote the PR:

- **The user's repository, or one in an organization they own:** the full house standards, as on their own PR, where the `/rubber-duck-review` skill folds every installed `## Review Criteria` section in without asking. Recommend the whole set.
- **A repository they do not own:** that repository's conventions come first, and which house standards a colleague's PR is held to is the user's call. Recommend the correctness lenses and offer the rest.

1. **Collect the candidates:** every installed skill declaring a `## Review Criteria` section, found the way the `/rubber-duck-review` skill's companion-skills step finds them; that skill itself, for a read-only cross-model pass over the PR's diff; and `/working-text` when the PR touches working text (a page, a comment, a description).
2. **Read the memories first:** the memory index and this project's memories. A standing correction about this repository, a rule the user gave the last time a PR like this was reviewed, a library the user prefers over hand-rolling: each one adds a lens, drops one, or sharpens the recommendation.
3. **Ask once, the recommendation first**, with the reason for each lens inside the dialog itself, since text outside a dialog is lost:

   ```text
   Lenses for PR #123 on octocat/fetcher, a repository you do not own (adds a retry loop in src/fetch.ts and a page docs/retries.md). Apply which?

   [x] /rubber-duck-review on the PR diff (Recommended)   a second model, read-only, before staging
   [x] /never-twice criteria (Recommended)                the retry loop repeats a fix from PR #98
   [ ] /code-standards criteria                           their repository, their standards; memory: prefer a library
                                                          over hand-rolling, if you hold this PR to it
   [ ] /working-text                                      docs/retries.md is a new page
   [ ] /no-invalid-states                                 no lifecycle flags or repeated guards in the diff
   [ ] /verify-with-controls                              the body claims no zero, alarm, or success reading
   ```

4. **Carry the answer for the PR**, through every revision of the pending review. A `/rubber-duck-review` pass on this PR expands only the `## Review Criteria` sections the user chose here, not every installed one: that skill's every-section rule is for the user's own change, and this choice scopes it. Then read the PR's linked document and the code, and only then write.

**Stage:** one JSON body, the head commit inside it, no `event` field. `commit_id` belongs in the file: with `--input`, a `-f` field goes to the URL query string. The heredoc is quoted, since comment bodies carry backticks an unquoted one would run as commands, so the SHA goes in afterwards. The file lives in a `mktemp` directory, removed in the same shell call like the `/pr-and-issue-discipline` skill's PR-body fallback.

A finding that spans several lines is anchored on its whole range with `start_line` and `line` (`start_side` and `side` both `RIGHT`). A single-line anchor only when one line is the whole finding.

```bash
review_dir=$(mktemp -d "${TMPDIR:-/tmp}/pr-review-XXXXXX"); trap 'rm -rf "$review_dir"' EXIT
cat > "$review_dir/review.json" <<'EOF'
{
  "commit_id": "HEAD_SHA",
  "comments": [
    {"path": "src/metrics.ts", "line": 42, "side": "RIGHT", "body": "Review summary (copy into the summary box)\n\n[comment, not approve yet]\n\n**Works:** ...\n**Blocks:** ..."},
    {"path": "src/metrics.ts", "start_line": 84, "start_side": "RIGHT", "line": 88, "side": "RIGHT", "body": "[blocking] The two headline metrics disagree on unparseable answers. Count them the same way in both."}
  ]
}
EOF
head_sha=$(gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid)
sed -i.bak "s/\"commit_id\": \"HEAD_SHA\"/\"commit_id\": \"$head_sha\"/" "$review_dir/review.json"   # the whole property, so a body saying HEAD_SHA is untouched
gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews --input "$review_dir/review.json" --jq .id   # no "event": stays pending
```

**Revise:** GitHub keeps one pending review per author per PR, so a second POST fails. Read the pending review's comments as they are now, since the user may have edited them in the web UI, and rebuild the full set from that text. Then delete it, confirm none remains, recreate, and tell the user the id changed:

```bash
# --paginate: a PR with many reviews spreads them over pages, and the pending one is the newest
gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews --jq '.[] | select(.state == "PENDING") | .id'   # the id to delete
gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews/<id>/comments --jq '.[] | {path, start_line, start_side, line, side, body}'   # the current text, web edits included, with each anchor's range; rebuild from this (position alone would collapse a ranged comment to one line)
gh api -X DELETE repos/<owner>/<repo>/pulls/<n>/reviews/<id>
gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews --jq '.[] | select(.state == "PENDING") | .id' | wc -l   # must print 0 before the new POST
```

**The verdict lives on the PR, never in a document.**

- **The summary is a staged inline comment** on the first changed line, headed `Review summary (copy into the summary box)`, then a bracketed recommendation (`[LGTM]`, `[comment, not approve yet]`, `[request changes]`), then `Works:` and `Blocks:` lines only. A nit that would need a third line is not staged at all. The web dialog drops an API-set review body, so the user pastes this one into the summary box.
- **A verdict the user has decided and told the agent to post** goes out directly, with `event` (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) and `body`, instead of staged. That instruction is the publication; without it, everything stays pending.
- **The report to the user is one chat line** with the recommendation: no findings document, no copy-paste file, no dashboard row.

**Each comment:**

- **One or two sentences, plain English, as short as possible.** Open with a bracketed hint for the publisher (`[blocking]`, `[small ask]`, `[question]`), then the exact change asked for. No background, no restating what the code does. Accepted: "[blocking] The linked comment has only headline and per-type tables, not the 100-task paired table the body promises. Please post it or link to it."
- **Plain human voice:** the Replies section's words (plain language, no internal names), not its two-part layout or language pairing. Rejected: "PARSING_ERROR maps to COULD_NOT_EXTRACT_ANSWER, which is trainable, so the rollout arrives as a CompletedRollout with reward 0". At most one code identifier per comment, one comparison, no chained numbers. Technical detail only when the author cannot act without it.
- **A re-review stages comments only for what is still open or partly open.** An item the author addressed gets no comment of its own; the summary may list the resolved ones in one line.
- **Only what changes behavior, reliability, or the truth of a stated fact.** Test-coverage, YAGNI, and tidying nits are not staged: the user drops them at publish time, so staging them only costs their editing pass.
- **Never a finding: anything that matters only on Windows** (newline translation, path separators, case-insensitive filesystems). The teams this serves run Linux and macOS only.
- The redaction rule applies: a staged comment publishes under the user's name.
