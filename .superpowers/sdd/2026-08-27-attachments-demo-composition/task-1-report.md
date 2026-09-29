# Task 1 report

## Implementation summary

Added pure attachment scope construction and comparison helpers to
`example/attachment-plan.ts`. Missing group or epoch values produce an
unusable scope, and usable scopes compare group ID bytes and bigint epochs.

Added the discriminated `DemoPage` route result and `selectDemoPage` to
`example/routing.ts`. It delegates route matching to the existing predicates,
preserving base paths, queries, and trailing slashes.

Added focused assertions for scope behavior and all page selections. The
existing `test/unit.ts` entry already imported both focused test files.

## Tests and output

* `npm run test:unit` -- passed, exit 0; TAP completed through assertion
  3474.
* `npm run typecheck` -- passed, exit 0.
* `git diff --check` -- passed, exit 0.
* `npm run check:style` -- passed, exit 0.

## Files changed

* `example/attachment-plan.ts`
* `example/routing.ts`
* `test/example/attachment-plan.ts`
* `test/example/routing.ts`
* This report

Pre-existing edits in `.gitignore` and the approved design plan were
preserved and are not included in the task commit.

## Self-review

The scope comparison is structural and bytewise, including distinct arrays
with equal contents. Null and undefined scopes are handled without accessing
their fields. Route selection uses the existing route predicates, so it does
not duplicate their path normalization or query handling. The route union is
closed over the three page variants and carries `showAttachments` only on the
main variant. No hooks, rendered HTML, or `ClientState` imports were added.

## Concerns

None identified for Task 1. The application integration is intentionally left
for later tasks.
