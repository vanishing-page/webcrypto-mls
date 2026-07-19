# MISSION

Build a production-ready implementation of MLS using the browser's
webcrypto API.

## Important

- Commit frequently.
- Read the `## Codebase Patterns` section at the top of `progress.log`
  before starting.
- Complete exactly ONE task this session, then stop.

# EXECUTION RULES

1. READ: At the start of every session, read `specs/prd.json`, `progress.log`
   (especially the `## Codebase Patterns` section)
2. SCOPE: Pick the highest-priority task where `passes: false`. Work ONLY on
   that task. If the task has acceptance criteria, treat them as the definition
   of done; if it doesn't, infer the smallest change that fully satisfies the
   title and note your interpretation in `progress.log`.
3. TEST-FIRST (where applicable): For a feature or bug fix, write failing tests
   that capture the desired behavior first, then implement until they pass. For
   pure scaffolding/config/docs tasks where a test adds no value, skip this and
   say so in `progress.log`.
4. TARGETED TESTING:
   - DO NOT run the full suite (`npm test`) for every minor change.
   - DO run only the tests relevant to what you changed
     (e.g. `npx vitest path/to/file.spec.ts`).
   - Run the FULL suite (`npm test`) ONLY when you believe the task is 100%
     complete, as a final gate before committing.
5. LINT: Run `npm run lint` after any code change and fix what it reports.
6. INTEGRITY: Only consider a task done when its real tests genuinely pass.
   NEVER delete, skip, weaken, or write tautological tests to force a green
   result, and never edit `specs/prd.json` to make the loop advance without the
   work being real. If a task can't be completed honestly this session, leave
   it `passes: false` and record what blocked you in `progress.log`.
7. DOCUMENT: Update `progress.log` with what changed and any new patterns
   discovered (see format below).
8. **MARK DONE**: In `specs/prd.json`, set `passes: true` for the completed task.
   This is how the loop advances — a task is not finished until this flag is
   flipped — so include this change in the commit.
9. **COMMIT**: Once the full suite and lint pass, commit with a descriptive
   message like `FEATURE: [TaskID] - [Description]` (or `FIX:`, `TEST:`,
   `CHORE:` as appropriate).
10. ATOMICITY: Complete exactly one task per session, then stop. Do not start a
    second task even if time remains.

# PROGRESS REPORT FORMAT

APPEND to `progress.log` (never replace -- always append):

```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g. "this codebase uses X for Y")
  - Gotchas encountered (e.g. "don't forget to update Z when changing W")
  - Useful context (e.g. "the evaluation panel is in component X")
---
```

The learnings section is critical — it helps future sessions avoid repeating
mistakes and understand the codebase faster.

## Consolidate Patterns

If you discover a **reusable** pattern future sessions should know, add it to
the `## Codebase Patterns` section at the TOP of `progress.log` (create it if it
doesn't exist). Keep this section tight: it is re-read in full every session, so
only consolidate **general, reusable** knowledge here — not story-specific
details, which belong in the dated entries below.

## Update AGENTS.md Files

Before committing, check whether any edited files have learnings worth
preserving in a nearby `AGENTS.md`:

1. Identify the directories you modified.
2. Check for an existing `AGENTS.md` in those directories or their parents.
3. Add valuable, reusable knowledge such as:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Good `AGENTS.md` additions:**
- "When modifying X, also update Y to keep them in sync."
- "This module uses pattern Z for all API calls."
- "Tests require the dev server running on PORT 3000."
- "Field names must match the template exactly."

**Do NOT add:**
- Story-specific implementation details
- Temporary debugging notes
- Information already in `progress.log`

Only update `AGENTS.md` when you have genuinely reusable knowledge that would
help future work in that directory.

# STOP CONDITION

Once ALL tasks in `specs/prd.json` have `passes: true`, output the exact
string `<promise>COMPLETE</promise>` and do no further work.
