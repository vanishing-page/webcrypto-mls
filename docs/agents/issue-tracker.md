# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`,
  never a single combined tickets file
- Triage state is recorded as a `**Status:**` line near the top of each
  issue file (see `triage-labels.md` for the role strings)
- Dependencies are recorded as a `**Blocked by:**` line near the top of
  each issue file, listing the numbers of the tickets that must complete
  first, or `None`
- Comments and conversation history append to the bottom of the file under
  a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory
if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path
or the issue number directly.

## Tickets are executed within hours, not weeks

Tickets in this tracker are run by an autonomous agent shortly
after they are written, with a fixed time budget and no
interview. This changes one upstream rule:

- Do include the file paths, module names, and exported symbols
  the ticket touches. Put them on a `**Touches:**` line directly
  under `**Blocked by:**`. The "avoid specific file paths" guidance
  in `to-tickets` exists for long-lived human trackers and does not
  apply here.
- Keep the `- [ ]` acceptance criteria phrased as observable
  behavior. The agent writes one failing test per criterion, so
  each criterion should be testable at a seam named in the spec's
  Testing Decisions.
