# 20: CI runs a runtime dependency audit

**What to build:** spec story 26. A known vulnerability in a runtime
dependency (`@hpke/*`, `@noble/*`) fails CI on the push that
introduces it, instead of waiting for someone to run `npm audit` by
hand.

The `build` job in `.github/workflows/nodejs.yml` gains a step, after
`npm ci`, that runs `npm audit --omit=dev --audit-level=high`.
`--omit=dev` keeps the documented tooling findings under
`markdown-toc` and `wrangler` out of it. Give the step a comment in
the style of the job's other steps saying why. (Upstream `5f15ed0`.)

AGENTS.md's Dependencies section records the step. That section
currently holds two overlapping versions of the audit baseline (a
six-entry list, then a five-entry list in two chains), left by an
earlier merge. While adding the step, reconcile it against what plain
`npm audit` reports today, keeping the reasons each entry stays and
the warnings about `npm audit fix`.

This is a workflow and docs change; it has no test.

**Blocked by:** None (can start immediately)

**Touches:** `.github/workflows/nodejs.yml` (`build` job), `AGENTS.md`
(Dependencies section). Prior art:
`.scratch/audit-2026-10-24/issues/07-npm-audit-baseline-matches-agents.md`.

**Status:** done

- [x] The `build` job runs `npm audit --omit=dev --audit-level=high`
      after `npm ci`, and the command exits 0 on the current tree.
- [x] AGENTS.md's Dependencies section names the CI step and holds a
      single baseline, matching what plain `npm audit` reports today.
- [x] `npm run check:style` passes.
