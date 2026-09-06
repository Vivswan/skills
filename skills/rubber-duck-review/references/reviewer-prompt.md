# Reviewer Prompt Template

Use this as a starting point for the second-opinion reviewer:

```text
This is a review-only task. Do not edit, write, or modify any files. Only read and report findings.

Please review the relevant changes and surrounding code for:
- correctness issues
- demonstrable defects only: name a concrete input or state and the wrong output, crash, or data loss it produces in this change; a finding that cannot name the input or state is out of scope
- naming or design choices that are already awkward in this change: a name that misleads about what the code does today, or duplication and structure introduced here
- workarounds propped up by long justification comments: if it takes a paragraph-long comment to argue the workaround is OK, the code is wrong. Flag both the comment and the code for fixing.

Speculative hardening is out of scope as a finding: hostile callers, races in single-user tools, deadlines already bounded by an outer timeout, "consider validating". List such items under the `Recorded, not built` heading below instead; whether any of them is built is the driving agent's call, not yours.

Already decided / out of scope:
- <optional bullets>

Report format:
- Blocking: <findings, each with the input and the wrong output>
- Non-blocking: <findings, each with the input and the wrong output>
- Recorded, not built: <speculative hardening, one line each; not findings>
- Or state plainly that the code is correct.
```

Skills that declare a `## Review Criteria` section contribute extra bullets when installed: expand each one's section into the review list above. In this collection, `/no-invalid-states`, `/code-standards`, `/never-twice`, and `/verify-with-controls` declare it.
