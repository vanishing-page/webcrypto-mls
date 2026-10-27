<!-- nightralph:review from=48a8f6f8402ecd5a5c113cfa03892f5f06cdfa9c to=d5ee20da1f763d1ab7a1be2210a4d320c3897278 status=fixed -->
## 2026-10-27 09:53 -- review 48a8f6f..d5ee20d -- 1 of 2 fixed
- [ ] A 23,558-line esbuild bundle was committed at the repository root
    .tmp-seed.cjs -- added by 011d313 ("nightralph: auto-commit 01-seeded-agreement-suite.md remaining changes"). It is a scratch bundle of the seeded-agreement test that nothing references, and `.gitignore` has no `.tmp*` pattern. It stays in the repo and goes stale against src/ with the next change.
- [x] The node test run exits 0 with a green result when a suite stalls partway (an older flake, but it hides this branch's tests too)
    scripts/run-tests.mjs:47-55 checks only the exit status. At db111bf, `npm test` stopped at "approvals - a dropped removal the room logged finishes the removal" (test/example-realistic-demo/approvals.ts:1550, `await removing` never settles). It printed no plan or totals and exited 0, and nothing registered after that point ran. The root cause is the fixed 200 ms sleep in `longEnoughToHaveFinished` (test/example-realistic-demo/async-helpers.ts:40-42), which loses the race under CPU load. 32 parallel runs stall at 48a8f6f too: 6 of 32 at the base, 7 to 12 of 32 at HEAD. So the flake is older than this branch, but the node runner never checks the TAP plan the way scripts/run-browser-tests.mjs does, so a truncated run reads as a pass.

### Fix
- attempts: 1 of 4
- effort: medium
- agent exit code: 0
- result: merged

# Review-fix notes

## Finding 1: .tmp-seed.cjs committed
- Removed .tmp-seed.cjs (git rm); added `.tmp*` to .gitignore beside
  `.test-bundle*.cjs`. Covers AGENTS.md's one-file `.tmp.cjs` run too.
- "Test": `git check-ignore --no-index .tmp-seed.cjs` exited 1 before,
  0 after. `git ls-files -ci --exclude-standard` gained no entries.

## Finding 2: node run exits 0 when a suite stalls
- Confirmed: a test awaiting a never-settling promise -> node prints no
  plan, exits 0.
- New scripts/tap-outcome.ts (`tapRunOutcome(output, exitCode, runName,
  truncatedHint)`), the plan/totals check moved out of
  scripts/browser-tap.ts; `browserRunOutcome` now delegates, same
  messages. test/tap-outcome.ts (registered in test/unit.ts) covers the
  node cases; red first (module missing), then green.
- scripts/run-tests.mjs: spawn with stdout piped and tee'd, bundles
  tap-outcome.ts like run-browser-tests.mjs does, sets process.exitCode.
  `.test-outcome-*.mjs` added to .gitignore.
- End-to-end: splicing a stalling test into test/unit.ts made
  `node scripts/run-tests.mjs unit` exit 1 with a FAIL message; clean
  run exits 0.
- Read the finding as also covering its named root cause, because a
  strict runner would otherwise turn `npm test` flaky red. approvals.ts:
  the five dropOnCommit tests now `await until(() =>
  h.room.dropOnCommit === null, ...)` instead of a 200 ms sleep before
  reconnecting; the negative sleep stays where a "nothing happened"
  assertion follows (1500, 1566). The "room gone mid-approval" test's
  two Promise.race-against-200ms waits became `until` with a 10 s
  deadline (it failed 2 of 64 loaded runs that way).
- Stress (32 parallel runs of the bundled approvals.ts): before 1/32
  stalled; after 0/96 stalled, 0/96 with a `not ok`.
- check:style violations reported are all pre-existing (.scratch,
  WHOLE_FILE entries), none in files changed here.
---
