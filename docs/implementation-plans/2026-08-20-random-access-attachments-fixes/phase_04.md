# Random-Access Attachment Fixes Implementation Plan

**Goal:** Close the real divergence between the two whole-object
verification paths, record the differences that are deliberate, and put
a differential test between them so a future divergence fails loudly
instead of silently.

**Architecture:** `openObject` (`object.ts:136-264`) and the streaming
reader (`decryptAttachmentStream`, `reader.ts:288-524`, with its
`...ForGroup` wrapper at 530-539) verify the same object
independently. The
original review framed this as duplication to be refactored away.
Investigation says otherwise, and this phase follows the
investigation.

The two paths run the same core algorithm: recompute each leaf as
`LH(ciphertext) || tag` and compare constant-time, fold leaves into an
epoch head and compare, fold heads into a root and compare against
`ref.snapshot`, then check the stored snapshot field against the root.
The difference is structural. `openObject` has the whole object
buffered and slices metadata inline; the reader splits the work across
`parsePrefix` (`reader.ts:39-80`), `verifyRoot`, `verifyEpochRun` and
`openBlock` so `range.ts` can call just the pieces a seek needs.
Merging them would force `openObject` to adopt streaming state
machinery it has no use for. The split stays.

Two corrections to the original framing, both found during plan review:

The `totalSize` check is **not** the divergence. The streaming reader
already enforces the byte count in both directions: trailing data at
`reader.ts:448-456` (`// Verify stream ended with no extra bytes`), and
truncation at `reader.ts:476-478`, where a `done` result mid-block
throws. Because `headerSize + gap + sum(segmentLength(i))` equals
`totalSize` by construction (`layout.ts:48-52`), that structural
enforcement is equivalent to `openObject`'s equality check. Tests
already exist at `test/attachment/streams.ts:2117` and `1736`.

The real divergence is **input validation**. `decryptAttachmentStream`
calls `validateAttachmentRef(ref)` at `reader.ts:295`, which enforces
the `version` field and the `objectId` length per
`reference.ts:62-71`. `openObject` takes a structural
`{ snapshot:Uint8Array, plaintextLength:number }` (`object.ts:140`) and
performs no equivalent check. Certifying the paths equivalent while
that stands would be worse than the current state, in which nothing
claims equivalence.

**Tech Stack:** TypeScript, `@substrate-system/tapzero`, Web Streams.

**Scope:** Phase 4 of 6. Independent of every other phase. An earlier
revision claimed a hard dependency on phase 2, on the grounds that task
1 added a throw site needing the reader's `doWipe`. That was a leftover
from a version of task 1 that touched `reader.ts`; after narrowing,
this phase touches only `object.ts`, `test/attachment/parity.ts` and
`src/attachment/AGENTS.md`, none of which phase 2 modifies except the
last, which both append to. Running after phase 1 is a mild convenience
because the padding fixtures overlap, not a requirement.

**Codebase verified:** 2026-08-20 by codebase-investigator and by
direct reading during plan review.

---

## Citations in this plan

Every `file:line` below was verified on 2026-08-20 against branch `ra`.
Line numbers drift as you edit. Re-locate by content, and if a citation
does not match what you find, trust the code and say so in the commit
message.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments-fixes.AC4: Verification parity

- **random-access-attachments-fixes.AC4.1 Success:** `openObject` and
  `decryptAttachmentStream` agree on the verdict for any mutation of a
  sealed object's bytes. Differences that arise from their differing
  input types are enumerated in `src/attachment/AGENTS.md` and are
  deliberate; no undocumented difference exists.
- **random-access-attachments-fixes.AC4.2 Failure:** All four attack
  shapes from the parent criterion
  `random-access-attachments.AC2.2` (drop, reorder, substitute, alter)
  are rejected by BOTH read paths, tested against each path
  explicitly.
- **random-access-attachments-fixes.AC4.3 Failure:** `openObject`
  rejects an out-of-range `objectId`, matching the bounds `sealObject`
  and `validateAttachmentRef` already enforce elsewhere. Malformed
  `plaintextLength` is already rejected on both paths and is covered
  here as a parity assertion over existing behaviour, not as a fix.
- **random-access-attachments-fixes.AC4.4 Failure:** Both paths reject
  a truncated object and an object with trailing bytes. This is
  existing behaviour in both; the criterion exists because no test
  previously exercised both paths from one fixture.

Abbreviated below to `AC4.1` and so on.

---

## Explicitly out of scope

Extracting a shared verification function. The investigation found the
duplication is a consequence of the streaming and buffered shapes
genuinely differing, and that unifying it adds indirection without
removing risk. If a future change makes the two shapes converge,
revisit it then. Do not attempt it as part of this phase.

## Differences that are deliberate

These are the asymmetries that will remain after this phase. Task 4
records them in `src/attachment/AGENTS.md`. They are not defects, and
the differential test in task 3 must not be written in a way that
flags them:

1. **Ref version checking.** `openObject` takes a structural object,
   not an `AttachmentRef`, so it has no `version` field to check. The
   streaming path checks it because it receives a real ref. Task 1
   aligns the two on `objectId` and `plaintextLength`, which
   `openObject` does receive; the `version` check has no counterpart
   and cannot be added without changing `openObject`'s signature. That
   signature change is not in scope here.

2. **When leaf runs are verified.** `openObject` verifies every leaf
   and every epoch head before decrypting anything
   (`object.ts:182-221` precedes `241-258`). The streaming reader
   verifies the root against the stored heads up front in `verifyRoot`,
   then verifies each epoch's leaf run lazily in `verifyEpochRun` as it
   reaches that epoch. A consumer who cancels partway never verifies
   the leaf runs of epochs it never read.

   This is correct, and the reason is worth writing down because it
   looks alarming: the root is bound to the stored heads, so a tampered
   head fails the root check up front on both paths. Lazy verification
   defers only the leaf-run-to-head binding, and only for data the
   consumer never receives. A partial read that returns no bytes from
   epoch 5 owes no guarantee about epoch 5.

3. **Emission before detection.** For a mutation inside segment N, the
   streaming reader legitimately emits segments 0 through N-1 before
   erroring. `openObject` emits nothing. Both reject; they differ in
   what the consumer saw first. Any test asserting "no plaintext
   emitted" must be restricted to mutations detectable from the header.

---

<!-- START_TASK_1 -->
### Task 1: Align openObject's input validation

**Verifies:** AC4.3.

**Files:**
- Modify: `src/attachment/object.ts` (inside `openObject`, near the
  existing length check at line 155)
- Test: `test/attachment/parity.ts` (integration, new file)

**Implementation:**

The gap is narrower than the original finding suggested, so read this
before writing code.

`plaintextLength` is **already validated** in `openObject`. It calls
`layout()` at `object.ts:152`, and `layout()` throws
`AttachmentError` for a non-safe-integer or non-positive
`plaintextLength` at `layout.ts:37-40`. Adding a second check would be
dead code, which is the same mistake an earlier revision of this plan
made elsewhere. Do not add one.

`objectId` is the real gap. `sealObject` rejects a zero-length or
over-255-octet `objectId` at `object.ts:31-33`; `openObject` accepts
anything. Read both `object.ts:31-33` and `reference.ts:62-71` before
writing, so the bounds you enforce match the ones already in force
rather than a third set.

Add to `openObject`, before any key derivation, the same `objectId`
length bounds `sealObject` enforces, throwing `new AttachmentError()`
per the subsystem rule.

Do not change `openObject`'s signature to take an `AttachmentRef`. That
is a larger change with callers to update, and the `version` field it
would bring is recorded above as a deliberate remaining asymmetry.

Because this adds throw sites, confirm they sit before any `startOpen`
call so no key material is derived for an input that was never valid.

**Testing:**

Create `test/attachment/parity.ts` and register it in `test/unit.ts`
inside the attachment block, which runs from line 18 to line 28,
**before** the `// Example app tests` marker at line 30.

Tests must verify AC4.3:
- `openObject` rejects a zero-length `objectId`. New behaviour.
- `openObject` rejects an `objectId` longer than 255 octets. New
  behaviour.
- `openObject` rejects a non-positive and a non-safe-integer
  `plaintextLength`. These pass before your change, via `layout()`;
  they are here to assert parity, and a comment should say so, so that
  a later reader does not mistake them for coverage of the new guard.
- For each, assert the streaming path rejects the equivalent input, so
  the test documents the parity rather than only the new behaviour.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

**Commit:** `fix: validate openObject inputs to match the reader`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: The four attack shapes against both paths

**Verifies:** AC4.2, AC4.4.

**Files:**
- Test: `test/attachment/parity.ts` (integration)

**Implementation:**

No source change expected. Both paths are believed to reject all four
shapes already; a prior review ran them by hand against
`decryptAttachmentStream` and saw correct rejections, and the parent
criterion's existing tests cover `openObject`. This task turns that
into one standing test driven from shared fixtures.

If any shape turns out not to be rejected, stop and report it before
writing a fix. That would be a live vulnerability rather than a
coverage gap, and it should be triaged as one.

**Testing:**

Build one fixture object and derive six tampered variants:
- Drop the final segment.
- Reorder two segments (swap segment 0 and segment 1).
- Substitute a segment with the segment at the same index from a
  different object sealed under a different CEK.
- Alter a byte inside a segment ciphertext.
- Truncate the object by a few bytes (AC4.4).
- Append trailing bytes (AC4.4).

Run each variant through both `openObject` and
`decryptAttachmentStream`, asserting `AttachmentError` from each.

Write the fixtures once and drive both paths from the same bytes. Two
sets of fixtures is how the paths drift apart in the first place. Note
that the two entry points take different ref shapes: `openObject` wants
`{ snapshot, plaintextLength:number }` and the streaming path wants an
`AttachmentRef` with `plaintextLength:bigint` (`reference.ts:29`).
Build both from one source of truth in a helper so they cannot fall out
of step.

For the streaming assertions, assert no plaintext was emitted only for
shapes detectable from the header. Do not assert it for a mid-object
alteration; see "Differences that are deliberate" item 3.

The existing tests at `test/attachment/streams.ts:2117` (extra bytes)
and `1736` (truncation) already cover the streaming half of AC4.4. Do
not delete them. This task adds the `openObject` half and the shared
fixture; overlapping coverage from a different angle is fine.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

**Commit:** `test: drive all attack shapes through both read paths`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Differential test between the two paths

**Verifies:** AC4.1.

**Files:**
- Test: `test/attachment/parity.ts` (integration)

**Implementation:**

No source change. This is the test that will catch the next divergence.

**Testing:**

Write a differential test that mutates a sealed object and asserts the
two paths agree on the verdict:

- Seal one fixture object large enough to span several segments and at
  least two epochs.
- For a deterministic list of byte offsets, flip a byte and run the
  result through both paths.
- Assert both accept or both reject. Never assert on which verdict; the
  property under test is agreement, not correctness, and pinning the
  verdict would make the test brittle to legitimate change.
- On disagreement, fail with a message naming the offset and which path
  accepted, so the failure is diagnosable without a debugger.

Choose offsets deterministically, not randomly. Cover at least: inside
the salt, inside the commitment, inside the stored snapshot, inside an
epoch head, inside the metadata leaf run, inside the padding gap,
inside a segment ciphertext, and inside a segment tag. Derive every
offset from `layout()` rather than hard-coding, so the test follows a
parameter change instead of silently testing the wrong region.

A random-offset sweep is tempting here and should be avoided: a test
that fails only on some runs teaches people to re-run it.

This test mutates **bytes only**. It does not vary the ref, so it
cannot detect the ref-validation asymmetry task 1 closes or the
`version` asymmetry that remains. That is why AC4.1 is scoped to
mutation agreement and why the remaining asymmetries are documented in
task 4 rather than left implicit.

If the test finds a disagreement the plan did not anticipate, stop and
report it. Do not paper over it by adding an exemption.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass, with the differential test reporting
agreement at every offset.

Then confirm the test can fail, and pick the falsification carefully.

Do **not** use the `bytes.length !== l.totalSize` guard at
`object.ts:155`. This sweep flips bytes at fixed offsets and never
changes the object's length, so removing a length guard changes no
verdict and the test stays green. A falsification that cannot falsify
is how a completion gate gets signed off on nothing.

Use one that bites: temporarily weaken one of `openObject`'s
constant-time comparisons, either the leaf check around
`object.ts:198-205` or the epoch-head check around `214-219`, so that
the corresponding offsets in the sweep are accepted by `openObject`
while the streaming path still rejects them. Confirm the test reports
disagreement and names the offset. Restore afterwards.

Do not rely on reverting phase 1's padding check either. Phase 4 is
independent of phase 1, so phase 1 may not have landed when this task
runs, and an observation that depends on it is not reproducible. The
requirement is that you have watched this test fail once, by a means
available in the tree as you find it.

**Commit:** `test: assert both read paths agree under mutation`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Record the parity contract and its exceptions

**Verifies:** The documentation half of AC4.1.

**Files:**
- Modify: `src/attachment/AGENTS.md`

**Implementation:**

Add a passage stating:

1. `openObject` and the streaming reader verify independently on
   purpose. The reader's helpers are factored for `range.ts`, not for
   `openObject`.
2. The safeguard against drift is the differential test in
   `test/attachment/parity.ts`. Name the file, so a future reader
   considering the refactor can find the thing that makes the
   duplication survivable.
3. All three deliberate asymmetries from the "Differences that are
   deliberate" section above, with the reasoning for each. Item 2, the
   lazy leaf-run verification, is the one most likely to be mistaken
   for a bug; write it carefully enough that the next reader does not
   have to rediscover why it is safe.

House style: no em dashes, use `--`; no arrow characters, use `->`.
Keep lines at or under 80 columns.

**Verification:**

Run: `npm run test:node`
Expected: unchanged, still passing. Documentation only.

**Commit:** `docs: record read-path parity and its exceptions`
<!-- END_TASK_4 -->

---

## Phase complete when

- `npm run test:node` passes, including the differential test.
- `npx tsc -p tsconfig.json --noEmit` is clean.
- `npm run lint` is clean.
- The differential test has been observed failing once, deliberately,
  per task 3's verification step, and restored.
- `src/attachment/AGENTS.md` enumerates all three deliberate
  asymmetries. If execution discovered a fourth, it is listed too, and
  is reported rather than quietly added.
