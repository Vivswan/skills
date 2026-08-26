# Reviewer Prompt Template

Use this as a starting point for the second-opinion reviewer:

```text
This is a review-only task. Do not edit, write, or modify any files. Only read and report findings.

Please review the relevant changes and surrounding code for:
- correctness issues
- future-proofing risks
- naming or design choices that may become awkward as the codebase grows
- hardcoded assumptions that may become misleading later
- workarounds propped up by long justification comments (if it takes a paragraph-long comment to argue the workaround is OK, the code is wrong; flag both the comment and the code for fixing)

Already decided / out of scope:
- <optional bullets>
```

Skills that declare a `## Review Criteria` section contribute extra
bullets when installed (in this collection, `/no-invalid-states`,
`/code-standards`, and `/never-twice`): expand each one's section
into the review list above.
