# Reviewer Prompt Template

Use this as a starting point for the second-opinion reviewer:

```text
This is a review-only task. Do not edit, write, or modify any files. Only read and report findings.

Please review the relevant changes and surrounding code for:
- correctness issues
- demonstrable defects: a correctness finding earns work when it names a concrete input or state and the wrong output, crash, or data loss it produces in the change under review; a maintainability finding earns work when it points at something concrete in this change, per the next bullet
- naming or design choices that are already awkward in this change: a name that misleads about what the code does today, or duplication and structure introduced here
- workarounds propped up by long justification comments: if it takes a paragraph-long comment to argue the workaround is OK, the code is wrong. Flag both the comment and the code for fixing.
- hand-rolled code whose whole job a good library already does (a parser, a fetcher, a schema, a format converter, a retry loop): a finding that names the library and what it covers. A large library or an unclear fit is a `non_blocking` entry whose claim begins `Ask the owner:` and names the library; the driver puts it to the user instead of building.
- each NEW test in the change: name the fact it pins that the source does not already say (an external fact the platform does not enforce, a cross-file consistency the source cannot express, or a regression with a named incident). A test that restates the source it reads is a finding whose fix is deletion. Never ask for a test without naming that fact; a deletion with no behavior of its own is proved by a census in the PR body or landing report, not a test.
- a test of a single constant, or of a variable that is itself the source of its value (a default, a key name, an argv literal, a path): it restates the source and grows with it. Its fix is a pin at the file, line, or request where the value leaves the program, and only when that boundary is an external contract.
- PII anywhere the change publishes (the diff and commit messages you read, plus the PR title, body, and comments pasted below): anything that tells a reader who the author is, how they work, or how their machine is set up. Identity: a name, an employer, a real account login or username, a hostname or machine name, a home path under a real user, a real email. Anything measured or copied from the author's real environment: figures, statistics, or profiles computed from real logs or sessions; a quoted real configuration, transcript, or log; an inventory of what the author has installed or uses. The example substitutes are never findings: `octocat`, `work-bot`, `example-user`, `example.com`, `example-user@example.com`, `/home/user`, and hand-written example values the change says are examples. A hit is blocking; quote the string and where it sits. A product file name that contains a vendor's word, a repository's own `owner/repo` coordinate in its install command, and the repository's own tooling and gates (a review tool named on a Gates line, a check's run count) are facts about the repository, not PII.
- each test fixture in the change: it is hand-authored. A fixture whose values were measured or recorded from real data, or a provenance comment saying so, is a blocking finding whose fix is a hand-written fixture. A tool in the change that measures real data requires an explicit output path outside the repository and refuses a path inside it; a default output path inside the repository is a blocking finding.

Speculative hardening is not a finding: hostile callers that cannot reach the code, races in single-user tools, deadlines already bounded by an outer timeout, defensive checks for inputs the code never receives. List such items under `recorded_not_built` instead; you never decide whether one is built; the driving agent applies its skill's step 6 (not built unless the user asks, or, in a repository with more than 100 GitHub stars, after the user confirms). A small, obvious hardening that rides along in the change under review (an exit-code check beside a version check) is fine to keep; do not propose a wider one to replace it.

Already decided / out of scope:
- <optional bullets>

PR title, body, and review comments (pasted by the driver when the change is a PR; a sandboxed reviewer may not reach GitHub):
- <title>
- <body>
- <each review, issue, commit, and CI comment, one bullet>

Report format: your final message is one JSON object and nothing else.
{
  "blocking": [ { "where": "<file:line or symbol>", "claim": "<what is wrong>", "evidence": "<the input or state and the wrong output, crash, or data loss, or the concrete maintainability cost in this change>" } ],
  "non_blocking": [ <same shape> ],
  "recorded_not_built": [ "<speculative hardening, one line each; not findings>" ],
  "summary": "<what you reviewed and how you checked it; with no findings, state plainly that the code is correct>"
}
Read the change before you answer: a report with no reads behind it is not a review.
```

## How the report is enforced

- `scripts/run-review.mts` hands `scripts/verdict-schema.json` to codex (`--output-schema`) and claude (`--json-schema`), so their final message cannot be anything but that object. The block above still tells the model what each field means.
- copilot has no schema flag, so for copilot the block above is the only thing asking for the object. The script parses the plain-text answer as JSON (a ```json fence is fine) and fails the review when it is not the object.
- The script also refuses a verdict with no tool call before it in the same turn. codex fills its narration into the schema too, so "I will review now" comes back as an empty, valid verdict; the missing reads are what give it away.

Skills that declare a `## Review Criteria` section contribute extra bullets when installed: expand each one's section into the review list above. In this collection, `/no-invalid-states`, `/code-standards`, `/never-twice`, and `/verify-with-controls` declare it.
