# Reviewer Prompt Template

Use this as a starting point for the second-opinion reviewer:

```text
This is a review-only task. Do not edit, write, or modify any files. Only read and report findings.

Please review the relevant changes and surrounding code for:
- correctness issues
- demonstrable defects: a correctness finding earns work when it names a concrete input or state and the wrong output, crash, or data loss it produces in the change under review; a maintainability finding earns work when it points at something concrete in this change, per the next bullet
- naming or design choices that are already awkward in this change: a name that misleads about what the code does today, or duplication and structure introduced here
- workarounds propped up by long justification comments: if it takes a paragraph-long comment to argue the workaround is OK, the code is wrong. Flag both the comment and the code for fixing.

Speculative hardening is not a finding: hostile callers that cannot reach the code, races in single-user tools, deadlines already bounded by an outer timeout, defensive checks for inputs the code never receives. List such items under `recorded_not_built` instead; you never decide whether one is built; the driving agent applies its skill's step 6 (not built unless the user asks, or, in a repository with more than 100 GitHub stars, after the user confirms). A small, obvious hardening that rides along in the change under review (an exit-code check beside a version check) is fine to keep; do not propose a wider one to replace it.

Already decided / out of scope:
- <optional bullets>

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
