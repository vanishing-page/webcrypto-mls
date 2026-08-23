# Random-Access Attachment Fixes Implementation Plan

**Goal:** Make the interop suite tell the truth about what it proves,
pin the reason the epoch digest tree is untested so the gap closes
itself when upstream moves, and put the vector-determinism claim under
a command instead of in prose.

**Architecture:** The harness round-trips two parameter tuples,
`SEAL-RO-v1 + snap_id 0x0000` and `SEAL-RW-v1 + snap_id 0x0001`
(`scripts/interop-seal.ts:106-119`). The library always emits
`SEAL-RO-v1 + snap_id 0x0003`. So the epoch digest tree, the one
mechanism this subsystem adds over existing tooling and the stated
reason for not reusing crypto-stream, has no cross-implementation
coverage at all.

That cannot be fixed by pointing the harness at the real tuple.
Vendored swift-raae does not implement snap_id 0x0003. `Suites.swift`
defines `isKnownSnapID` as true for `0x0000` and `0x0001` only, and its
doc comment states that draft-02 additionally defines 0x0002 and 0x0003
and that "this build implements neither, so both are unknown here and
`PayloadSchedule.init` rejects them as `unsupportedSnapID`". There is
no epoch-tree code anywhere in `Sources/RAAE/`; `Snapshot.swift` carries
`MaskedMultisetHash` alone. There is no counterparty to test against.

Two things follow. First, the rejection happens at
`KeySchedule.swift:135-137`, before the profile-tuple guard at
`:152-158`, so swift-raae never evaluates our tuple for conformance and
says nothing about it either way. The design plan's conclusion that
`PROTOCOL_RO` is "probably incorrect for the attachment profile" reads
that rejection as a verdict on the tuple, which it is not. Second, since
a positive test is impossible, the honest move is a negative one: assert
the rejection and its specific reason, so the test flips red the day
upstream implements the authenticator, which is exactly when someone
should be told to write real coverage.

**Tech Stack:** TypeScript, Swift 6.3.2, esbuild, node.

**Scope:** Phase 5 of 6. Independent of phases 1 through 4.

**Codebase verified:** 2026-08-20 by codebase-investigator, and by
direct reading of the vendored Swift sources.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments-fixes.AC5: Interop and determinism

- **random-access-attachments-fixes.AC5.1 Success:** The interop
  harness documents with evidence that vendored swift-raae cannot
  accept snap_id 0x0003, and pins that fact as an assertion on the
  specific rejection reason rather than as a comment.
- **random-access-attachments-fixes.AC5.2 Success:** Re-running
  `scripts/generate-seal-own-vectors.ts` produces byte-identical
  output, and this is checked by a command wired into the standard test
  run rather than asserted in prose.
- **random-access-attachments-fixes.AC5.3 Success:** The parent
  criterion `random-access-attachments.AC5.2` is reworded to match what
  the harness actually verifies, so it stops overclaiming a range read
  and a tamper rejection it does not perform.

Abbreviated below to `AC5.1` and so on.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Correct the skip comment and its citations

**Verifies:** None directly (prepares task 2 and removes a false
claim).

**Files:**
- Modify: `scripts/interop-seal.ts:393-410` (the range-read skip
  comment)

**Prerequisite: restore the vendored checkout.**

The Swift sources cited throughout this phase live under
`interop/seal-cli/.build/checkouts/swift-raae/`, which is gitignored
(`interop/.gitignore`) and absent from `git ls-files`. They are build
artifacts, not committed sources, so on a fresh clone they do not
exist. Restore them before reading anything:

```sh
cd interop/seal-cli && swift build -c debug
```

Debug is required, not incidental: the CLI uses `@testable import
RAAE`, which is only available when the library is compiled with
`-enable-testing`. Release builds fail.

Because these paths are build artifacts pinned by `Package.resolved`,
their line numbers can move when the pin moves. Re-locate by content.

**Implementation:**

The comment currently attributes the rejection to
`KeySchedule.swift:152-158` and to our `PROTOCOL_RO + snap_id` pairing
being refused. Both halves are wrong. Rewrite it to say:

1. swift-raae does not implement snap_id 0x0003. Cite
   `Suites.swift` `isKnownSnapID`, which admits `0x0000` and `0x0001`
   only, and note that `Sources/RAAE/` contains no epoch-tree code.
2. The rejection therefore fires at `KeySchedule.swift:135-137` as
   `ScheduleError.unsupportedSnapID`, before the profile-tuple guard at
   `:152-158` is reached.
3. Consequently swift-raae expresses no opinion on our
   `SEAL-RO-v1 + 0x0003` pairing. Per `Spec/NOTES.md:139-145`, draft-02
   defines SEAL-attachment as a named instantiation over `SEAL-RO-v1`
   with exactly that snap_id, so the pairing is the conformant one and
   the gap is an upstream implementation gap.

Keep the comment factual and short. It is load-bearing: it is the
reason a reader trusts a skipped test.

House style applies to comments: no em dashes, use `--`; no arrow
characters, use `->`.

**Verification:**

Run: `npm run test:interop`
Expected: exits 0, output unchanged apart from nothing. This task
changes a comment only. If Swift is not installed the run prints
`SKIP: swift toolchain not found` and exits 0; that is not sufficient
verification for this phase, so install Swift or run it where Swift
exists before claiming the phase done.

**Commit:** `docs: correct the interop skip rationale`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Assert the 0x0003 rejection reason

**Verifies:** AC5.1.

**Files:**
- Modify: `scripts/interop-seal.ts` (add a case after the existing
  mode loop)

**Implementation:**

Add an interop case that sends a `schedule` op with the parameters the
library actually emits, and asserts on the failure.

The CLI's error contract, confirmed by reading
`interop/seal-cli/Sources/seal-cli/main.swift`: `sendError` at lines
147-149 is only `sendResponse(["error": message])`. It does not add a
prefix and does not exit. The `error: ` prefix and the `exit(1)` come
from individual call sites, so the exact text varies: `main()`'s catch
produces `error: <description>`, while guard failures emit plain
messages such as `{"error":"invalid payload_info"}`.

The assertion in this task is unaffected, because an unsupported
snap_id surfaces through `main()`'s catch and therefore carries the
Swift error description. Do not generalise from this one case when
documenting the contract in phase 6 task 5; document what `sendError`
and its call sites actually do.

The harness helper already tolerates exit status 1
(`interop-seal.ts:82` accepts `0` and `1`), so no change to the spawn
helper is needed.

The case must:
- Send `op: 'schedule'` with `protocol_id` set to `PROTOCOL_RO` and
  `payload_info.snap_id` set to `0x0003`, with the remaining fields
  matching what the library emits.
- Assert the response has an `error` field. A success here is a
  failure of this test.
- Assert the error text names `unsupportedSnapID`. This is the whole
  point of the case. An assertion that merely checks "it failed" would
  still pass if swift-raae started rejecting for a different reason,
  including rejecting our tuple as non-conformant, which is the one
  outcome we would most want to hear about.
- Print a clear line on success saying what was pinned, in the style of
  the harness's existing output lines, and explaining that a failure
  here means upstream capability changed and real round-trip coverage
  should now be added.

Do not mark this case as a skip. It is a passing assertion about a
known limitation, not an absent test.

**Testing:**

The harness is the test. Verify by hand, once, that the assertion is
real: change the expected substring to something swift-raae would not
emit, confirm the harness fails, then change it back. An assertion
nobody has watched fail is not yet an assertion.

**Verification:**

Run: `npm run test:interop`
Expected: exits 0, `All interop tests passed!`, with the new case's
line present in the output.

**Commit:** `test: pin the swift-raae snap_id 0x0003 rejection reason`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Make the vector generator target a chosen directory

**Verifies:** None directly (enables task 4).

**Files:**
- Modify: `scripts/generate-seal-own-vectors.ts`

**Implementation:**

The generator currently writes to `test_vectors/seal/own/`
unconditionally. A determinism check needs it to write somewhere else
so the committed vectors are never touched by the check itself.

Add an output-directory override, read from `process.argv[2]` and
falling back to the current hard-coded path when absent. Keep the
default exactly as it is, so every existing manual invocation keeps
working.

Do not have the check overwrite the committed vectors and diff
afterwards. A check that mutates the thing it is checking will one day
be interrupted halfway and leave the repository in a state nobody
ordered.

**Verification:**

Run the generator with no argument and confirm
`git diff --exit-code test_vectors/seal/own/` is empty.

Run it with a temporary directory argument and confirm the files appear
there instead, and that `test_vectors/seal/own/` is untouched.

**Commit:** `chore: let the vector generator target a directory`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire determinism into the standard test run

**Verifies:** AC5.2.

**Files:**
- Create: `scripts/check-vector-determinism.mjs`
- Modify: `package.json` (the `test:node` script)

**Implementation:**

`test-requirements.md` records generator re-run stability as convention
item 5, at lines 34-39: vectors under `test_vectors/seal/own/` "are
byte-identical on re-run" and changing them "is a conscious re-freeze".
It states this as a standing property of the repository, but nothing
enforces it. Two separate reviewers verified determinism by hand; CI
never has.

Note the wording carefully when you get to task 5: the document calls
this a convention, not a gate. An earlier revision of this plan quoted
it as a gate that "must hold on every standard test run", which is not
text that appears in the file. The substance was right and the quote
was invented. Do not reproduce it.

There is no TypeScript runner in `devDependencies`, so the new script
must bundle the generator with esbuild and run the bundle, the same way
`scripts/run-interop.mjs` handles `scripts/interop-seal.ts`. Read that
script first and follow its approach rather than inventing a second
one.

The check must:
- Create a temporary output directory outside the repository tree.
- Bundle and run the generator against that directory.
- Compare every produced file byte for byte against its counterpart in
  `test_vectors/seal/own/`.
- Fail with a message naming the first file that differs, and clean up
  the temporary directory on both the pass and the fail path.
- Fail, not pass, if the generator produces a file that has no
  committed counterpart or omits one that exists. A determinism check
  that only compares the intersection would miss a vector being
  dropped.

Then add it to `test:node`, which currently reads:

```
node scripts/check-attachment-invariants.mjs && node scripts/run-tests.mjs all
```

Put the determinism check alongside the invariants check, before the
test run, so a re-freeze that was not intended stops the suite before
anything else runs.

Note the cost: this bundles and runs the generator on every
`npm run test:node`. If that proves slow enough to be annoying, the
right answer is to make the generator faster or to gate the check on CI
only, not to drop it. Measure before deciding; do not pre-optimise.

**Verification:**

Run: `node scripts/check-vector-determinism.mjs`
Expected: exits 0.

Run: `npm run test:node`
Expected: invariants pass, determinism passes, tests pass.

Then break it deliberately: edit one byte of a committed vector, re-run,
confirm non-zero exit and that the message names that file. Restore the
byte with `git checkout` afterwards and confirm a clean tree.

**Commit:** `test: enforce vector regeneration determinism`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Reword the overclaiming interop criterion

**Verifies:** AC5.3.

**Files:**
- Modify: `docs/design-plans/2026-08-19-random-access-attachments.md`
  (the `random-access-attachments.AC5.2` entry, around lines 167-171)
- Modify:
  `docs/implementation-plans/2026-08-19-random-access-attachments/test-requirements.md`
  (the AC5.2 section, around lines 381-420)

**Implementation:**

AC5.2 currently promises a live cross-implementation round-trip
"including a range read and a tamper rejection". The harness performs
the tamper rejection. It does not perform a range read; that leg is
skipped, and the human test plan already records `range read: skip` as
expected. The criterion was never amended to match.

Reword AC5.2 to state what is actually verified: a live
cross-implementation round-trip of the SEAL core in both directions,
including epoch crossing, final-segment handling and tamper rejection,
under the two parameter tuples swift-raae implements. State explicitly
that it does not cover snap_id 0x0003, and point at the negative case
from task 2 as the thing that will signal when it can.

Then correct the matching AC5.2 section of `test-requirements.md`,
around lines 381-420. It contains two concrete falsehoods, and leaving
either would defeat the point of this task:

1. Its list of cases "the harness must run and report per line"
   includes a range read that assembles a full aligned object and
   compares against the plaintext slice. The harness does not do this.
   The leg is skipped, as `interop-seal.ts:393-410` records and as the
   human test plan already expects.
2. Its Configurations line states `snap_id 3`. The harness runs
   `snap_id 0x0000` and `0x0001` (`interop-seal.ts:106-119`). `0x0003`
   is the value the library emits and the one swift-raae rejects, so
   naming it as a harness configuration is exactly backwards.

Fix both, and add the negative case from task 2 to the list of what the
harness does run. Leave the traceability table's row structure alone
other than the wording.

Do not delete the criterion or mark it unverified. It verifies
something real and valuable; it just verifies less than it says.

**Verification:**

Run: `npm run test:interop`
Expected: exits 0. Documentation only, but re-run it to confirm the
described behaviour matches the wording you just wrote.

**Commit:** `docs: scope AC5.2 to what interop actually proves`
<!-- END_TASK_5 -->

---

## Phase complete when

- `npm run test:interop` passes with Swift present, including the new
  negative case. A `SKIP` line does not count as verification for this
  phase.
- `npm run test:node` passes with the determinism check wired in.
- The determinism check and the 0x0003 assertion have each been
  observed failing once, deliberately, and then restored.
- `git status` is clean.
