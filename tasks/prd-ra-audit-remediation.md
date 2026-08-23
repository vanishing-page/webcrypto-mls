# PRD: Random-Access Attachments Audit Remediation

## Introduction

The `ra` branch adds random-access encrypted attachments (93 files,
about 25k lines). An audit of the branch (`AUDIT-ra.md`, 2026-08-21)
found the cryptographic core sound but identified three correctness
defects in the read paths, five places where key material leaks, a set
of structural gates that never run in CI, gaps in test coverage, stale
internal documentation, and a complete absence of consumer-facing
documentation for the feature.

This PRD covers closing every item in that audit. The branch does not
merge to `main` until all of it is done.

Read `AUDIT-ra.md` alongside this document. The audit is the evidence;
this PRD is the work list. Where the audit cites a line number, treat it
as a starting point rather than a fixed address -- lines move as fixes
land.

## Goals

- Close the six merge-blocking defects (audit section 1, "Must fix
  before merge"), each with a regression test that fails before the fix.
- Make CI actually enforce the branch's structural invariants: the
  attachment invariant checks, vector determinism, test typechecking,
  browser tests, and a non-skippable interop job.
- Remove every residual leak of key material identified in the audit,
  including the intermediate exporter-tree secrets.
- Give the three read paths (object, stream, range) identical observable
  behavior on the same input, and prove it in the parity test.
- Add the positive multi-epoch coverage the suite has never had, so a
  bug confined to segments at or past index 1024 cannot ship.
- Repair the tests that pass for a reason other than their title.
- Publish consumer documentation: a README section with a real
  end-to-end example, plus JSDoc on the public API surface.
- Make the example demo use the API a consumer should use, and fix its
  unawaited stream loop.

## User Stories

Stories are grouped into phases. Phases are ordered; stories within a
phase are mostly independent. Every story ends with typecheck and lint
passing (`tsc --noEmit`, `npm run lint`) and the full unit suite green
(`npm run test:unit`).

Where a story fixes a defect, write the failing test first, confirm it
fails against the current code for the stated reason, then fix.

---

## Phase 1: Merge blockers

### US-001: Range path enforces the header padding check
**Description:** As a user reading a byte range, I want the range reader
to reject a tampered padding region so that all three read paths agree
on what a valid object is.

The gap `[headerSize, firstBlockOffset)` must be zero. `openObject` and
`decryptAttachmentStream` check it with `isZeroRegion`; the range path
never fetches those bytes, so it never checks. A single flipped byte at
`l.headerSize` makes two readers throw and the range reader return
plaintext.

Resolution: the range path fetches and checks the gap, so all three
paths agree.

**Acceptance Criteria:**
- [ ] `rangesFor` emits a range covering `[headerSize,
      firstBlockOffset)` whenever that gap is non-empty, and the range
      read path verifies it is all zero before emitting any plaintext.
- [ ] A non-zero byte anywhere in that gap causes the range path to
      throw the same `AttachmentError` the other two paths throw.
- [ ] The empty-gap case (`headerSize === firstBlockOffset`) does not
      emit a zero-length range and does not throw.
- [ ] `test/attachment/parity.ts`'s tamper sweep runs the range path
      over the same offsets it already runs the object and stream paths
      over, and asserts all three paths agree at every offset, including
      `l.headerSize`.
- [ ] The parity test fails if the new check is removed.
- [ ] Any doc that describes the range path's fetched regions is
      updated to include the padding gap.

### US-002: Reader tolerates zero-length and multi-read stream endings
**Description:** As a user decrypting from a `TransformStream` or socket
adapter, I want a legal empty chunk not to be reported as an integrity
failure.

At the end-of-stream check the reader attempts exactly one `read()` and
tests `finalResult?.value` for truthiness. An empty `Uint8Array` is
truthy, so a legal empty non-final chunk, or an empty value delivered
alongside `done`, is rejected as "attachment integrity failure".

**Acceptance Criteria:**
- [ ] The end-of-stream check loops until `done` rather than reading
      once.
- [ ] Emptiness is decided by `value.length`, not by truthiness of
      `value`.
- [ ] A source that emits zero-length chunks (between real chunks, and
      as the final chunk before `done`) decrypts successfully. Test with
      an object large enough to span multiple blocks; the audit
      reproduced this at 70000 bytes.
- [ ] Genuine trailing bytes after the last block are still rejected.
- [ ] Genuine truncation is still rejected.
- [ ] Both regression tests fail against the current code.

### US-003: Locked input stream wipes the owned CEK
**Description:** As a caller of `decryptAttachmentStreamForGroup`, I
want a locked input stream to leave no key material behind and to
surface the library's single opaque error.

`ciphertext.getReader()` runs before the `try` whose `finally` wipes.
A locked stream throws a raw `TypeError` out of `start()`, `ownedCek` is
never zeroed, and the wrapper has already returned so its catch cannot
fire.

**Acceptance Criteria:**
- [ ] `getReader()` is inside the guarded region, so a lock failure
      routes through the same wipe path as any other `start()` failure.
- [ ] Passing an already-locked stream to
      `decryptAttachmentStreamForGroup` results in an `AttachmentError`,
      not a `TypeError`.
- [ ] A test asserts the owned CEK buffer is all zero after that
      failure.
- [ ] The test fails against the current code, and pins the error type
      rather than accepting any throw.

### US-004: Range read wipes the SealState when cancelled during start
**Description:** As a caller who cancels a range read early, I want the
derived keys zeroized no matter when the cancel lands.

`cancel()` wipes `ctx` only if it is set. A cancel that arrives while
`start()` is awaiting a drain finds `ctx` null; `start()` then carries
on, derives the state, assigns it and decrypts the window, and `pull()`
never runs. The audit reproduced live `payload_key`, `acc_key` and
`nonce_base` 500 ms after cancel. `reader.ts` solved the same problem
with two latches; `range.ts` did not get that fix.

**Acceptance Criteria:**
- [ ] Cancelling at any point during `start()` leaves `payloadKey`,
      `snapKey` and `nonceBase` zeroized, whether the cancel lands
      before, during, or after derivation.
- [ ] A cancel during `start()` does not leave the stream decrypting a
      window nobody will read.
- [ ] A test in `test/attachment/cek-wipe.ts` cancels during the
      `start()` await and asserts all three buffers are zero after the
      operation settles. It fails against the current code.
- [ ] The rationalizing comment in `test/attachment/streams.ts` (around
      :1642-1652) is replaced by the real test or by an accurate note
      pointing at it.
- [ ] `src/attachment/AGENTS.md`'s wipe-site list includes this path.

### US-005: startOpen wipes derived keys on commitment mismatch
**Description:** As a user opening a tampered object, I want no derived
key material left in memory after the commitment gate rejects it.

`startOpen` derives payloadKey, snapKey and nonceBase from the real CEK
and then throws on mismatch without calling `wipeSealState`. Every
tampered-commitment object takes this path.

**Acceptance Criteria:**
- [ ] The commitment-mismatch branch wipes the derived state before
      throwing.
- [ ] The thrown error is unchanged (same opaque `AttachmentError`, no
      new information about why it failed).
- [ ] A test asserts `payloadKey`, `snapKey` and `nonceBase` are zero
      after a commitment mismatch. Existing coverage checks only the
      CEK.
- [ ] The test fails against the current code.

### US-006: Structural check scripts run in CI
**Description:** As a maintainer, I want the invariant gates to run on
every push, not only when someone runs `npm test` locally.

`check-attachment-invariants.mjs` and `check-vector-determinism.mjs` are
only wired into `test:node`. CI runs `test:unit` and `test:matrix`, so
the `getRandomValues` ban, the layering checks, the vector inventory,
the wipe-presence checks and vector determinism are enforced locally
only. Two test plans state the opposite.

**Acceptance Criteria:**
- [ ] Both check scripts run in `.github/workflows/nodejs.yml` on every
      push, in a job or step that fails the build when they fail.
- [ ] A deliberate local violation (for example, a `getRandomValues`
      call under `src/attachment`) fails that CI step. Verify by running
      the step's command locally against the violation, then revert.
- [ ] The two test plans no longer claim the gates run on "every
      standard test run" where that is false; they describe what CI
      actually runs.

---

## Phase 2: CI hardening

### US-007: Interop job cannot go green by skipping
**Description:** As a maintainer, I want a missing Swift toolchain in CI
to fail the interop job rather than print `SKIP` and exit 0.

**Acceptance Criteria:**
- [ ] `scripts/interop-seal.ts` exits non-zero when the Swift toolchain
      is absent and the `CI` environment variable is set.
- [ ] With `CI` unset, the local skip behavior is unchanged, and the
      skip message says the run was skipped.
- [ ] The failure message names the missing toolchain.

### US-008: Tests are typechecked in CI
**Description:** As a maintainer, I want type errors in `test/` to fail
the build.

`tsconfig.build.json` excludes `test`, and no CI step runs
`tsc --noEmit` over it.

**Acceptance Criteria:**
- [ ] CI runs a typecheck that covers `test/`, `scripts/` and
      `example/`.
- [ ] The step passes on the current branch, or the type errors it finds
      are fixed as part of this story.
- [ ] A deliberate type error in a test file fails that step. Verify
      locally, then revert.

### US-009: Browser tests run in CI
**Description:** As a maintainer, I want `test:browser` to run on every
push, since the library targets the browser.

**Acceptance Criteria:**
- [ ] `npm run test:browser` runs in CI and fails the build on failure.
- [ ] The job has a timeout consistent with the existing jobs.
- [ ] If the browser suite cannot run in CI for a concrete technical
      reason, that reason is documented in the workflow file and the
      story is closed by documenting it, not by silence.

---

## Phase 3: Multi-epoch coverage

### US-010: Positive round-trip across an epoch boundary
**Description:** As a maintainer, I want at least one test that reads
real plaintext from a segment past the first epoch, so that a bug
confined to segments at or past index 1024 cannot ship.

Every existing multi-epoch test is an early rejection. Mutations that
force `verifyEpochRun` to always slice epoch 0, that stop the reader
re-verifying after epoch 0, that start the range read at epoch 0, and
that compare every head against head 0, all survive.

**Acceptance Criteria:**
- [ ] A round-trip of an object with at least 1025 segments succeeds
      through `openObject`, `decryptAttachmentStream`, and the range
      path, and the recovered plaintext matches byte for byte.
- [ ] The range case reads a window that lies entirely inside an epoch
      later than 0, and a window that straddles the boundary.
- [ ] Each of the four mutations named above is killed by the new tests.
      Confirm by applying each mutation, running the suite, and seeing
      it fail.
- [ ] The tests use a segment size that keeps runtime reasonable; note
      the chosen parameters and the runtime in the test file.

### US-011: Tamper detection past epoch 0
**Description:** As a user, I want a tampered epoch head or leaf in a
later epoch rejected on every read path.

**Acceptance Criteria:**
- [ ] For an object spanning more than one epoch, tampering with the
      epoch head of an epoch greater than 0 is rejected by all three
      read paths.
- [ ] The same for a leaf inside an epoch greater than 0.
- [ ] Each test pins `AttachmentError`.
- [ ] The tests fail if the corresponding verification is removed.

---

## Phase 4: Key hygiene and API hardening

### US-012: Intermediate exporter-tree secrets are zeroized
**Description:** As a user, I want the intermediate nodes of the
exporter tree wiped, since `componentSecret` derives the CEK for every
objectId in the epoch and is therefore worth more than the individual
CEKs the wrappers wipe so carefully.

`safeExportSecret` walks 16 nodes; none is wiped, and `attachmentCek`
holds `componentSecret` without wiping it.

**Acceptance Criteria:**
- [ ] Each intermediate node is zeroized once its child has been
      derived.
- [ ] `componentSecret` is wiped in a `finally`, so it is wiped on the
      throw path too.
- [ ] The caller's `applicationExportSecret` is NOT wiped (it is not
      owned by this code).
- [ ] A test asserts the intermediate buffers are zero after
      `attachmentCek` returns, and after it throws.
- [ ] The derived CEK is unchanged for a fixed input. Existing vectors
      still pass.

### US-013: `opts.salt` is not a nonce-reuse footgun on the public API
**Description:** As a user, I want the public writer API not to offer an
option that silently enables catastrophic nonce reuse.

payloadKey, snapKey and nonceBase derive from `(cek, salt)` only;
objectId enters the commitment alone. Two `encryptAttachment` calls with
the same raw CEK and the same fixed salt produce identical AES-GCM key
and nonce per segment, so the two ciphertexts XOR to the two plaintexts.
Only `encryptAttachmentForGroup` is safe, because `attachmentCek` binds
objectId. `src/attachment/AGENTS.md` currently recommends `opts.salt`
for deterministic output, and the public JSDoc carries no warning.

**Acceptance Criteria:**
- [ ] The `...ForGroup` wrapper does not accept `salt`.
- [ ] On `encryptAttachment` and `sealObject`, `salt` is documented as
      test-and-vector use only, with an explicit statement of the
      consequence of reusing it with a reused CEK.
- [ ] `src/attachment/AGENTS.md` no longer recommends `opts.salt` for
      general deterministic output; it states the constraint.
- [ ] Existing vector generation still works (it is the legitimate
      caller).
- [ ] Typecheck catches any in-repo caller that passed `salt` to the
      wrapper.

### US-014: `AttachmentRangeRead.close` is required
**Description:** As a user, I want the type to match the contract, which
says `close` is always present.

`close?:` is optional in the type while the JSDoc says "Always present
-- do NOT use `if (read.close)`". The tests themselves write
`rangeRead.close?.()`.

**Acceptance Criteria:**
- [ ] `close` is a required member of `AttachmentRangeRead`.
- [ ] Every in-repo call site drops the optional-call `?.()`.
- [ ] The JSDoc and the type agree.

### US-015: CEK length is validated
**Description:** As a user, I want a wrong-length CEK rejected rather
than silently weakening derivation.

`sealObject`, `openObject` and `encryptAttachment` accept any
`cek.length`; `attachmentCek` always yields 32.

**Acceptance Criteria:**
- [ ] All three entry points reject a CEK whose length is not
      `CEK_LENGTH`, with `AttachmentError`.
- [ ] Tests cover too short, too long, and empty.
- [ ] The correct length still passes, and vectors are unaffected.

### US-016: `validateAttachmentRef` checks snapshot length
**Description:** As a maintainer, I want the length check made explicit
rather than relying on a downstream comparison.

Today a wrong-length snapshot is caught only because
`constantTimeEqual` rejects unequal lengths, and that behavior has no
test of its own.

**Acceptance Criteria:**
- [ ] `validateAttachmentRef` rejects a snapshot whose length is not the
      KDF output size.
- [ ] A separate test pins `constantTimeEqual`'s unequal-length
      behavior, so the defense in depth is covered at both layers.
- [ ] Both tests fail if their respective check is removed.

### US-017: Epoch and lifetime caveats are visible at the API
**Description:** As a user reading the JSDoc, I want to learn that an
attachment stops being decryptable after a commit, and that abandoning a
stream leaks the CEK, without reading internal docs.

`AttachmentRef` carries no epoch and `applicationExportSecret` is not
retained, so an attachment opened after any commit fails the commitment
gate with the same opaque error as tampering. That is documented in
FDR-003 and AGENTS.md but not at the API. Separately, on the success
path `decryptAttachmentStreamForGroup` wipes only when the consumer
reads to the end or cancels; `range.ts` documents this and `reader.ts`
does not.

**Acceptance Criteria:**
- [ ] The `...ForGroup` JSDoc on the writer, reader and range entry
      points states that a ref is only decryptable within the epoch it
      was created in, and that a post-commit failure is
      indistinguishable from tampering.
- [ ] `reader.ts`'s JSDoc states that a stream abandoned without being
      read to the end or cancelled leaves the owned CEK in memory, and
      names the way to avoid it.
- [ ] No behavior change in this story.

---

## Phase 5: Performance defects

### US-018: Block assembly is linear in chunk count
**Description:** As a user decrypting from a source that emits small
chunks, I want block assembly not to be quadratic.

The reader re-sums the whole chunk array with `buffer.reduce` on every
`read()`, making assembly O(chunks^2) per 64 KiB block. A 1-byte-chunk
source did not finish a two-segment object in 8 seconds.

**Acceptance Criteria:**
- [ ] A running byte count replaces the per-read `reduce` at both sites.
- [ ] A two-segment object from a 1-byte-chunk source decrypts in well
      under the test timeout, and the recovered plaintext is correct.
- [ ] A test covers the small-chunk source so the regression cannot
      return silently.

### US-019: Segment key derivation is cached per epoch
**Description:** As a user of large objects, I want the per-segment key
derived once per epoch rather than once per segment.

`segmentKey` re-runs HKDF extract and expand per segment although the
output is identical for all 1024 segments of an epoch. A 128 GiB object
does about 2M redundant derivations.

**Acceptance Criteria:**
- [ ] The expanded key is cached per epochIndex on `SealState`.
- [ ] `wipeSealState` zeroizes the cache, and a test asserts it.
- [ ] Derived keys are byte-identical to before; existing vectors pass
      unchanged.
- [ ] Crossing an epoch boundary produces a different key (covered by
      the Phase 3 tests).

---

## Phase 6: Test suite repair

### US-020: `MAX_SEGMENTS` is actually exercised
**Description:** As a maintainer, I want the `MAX_SEGMENTS` guard tested
by an input that reaches it.

The guard is never rejected in the suite.
`test/attachment/reader-header.ts` claims `MAX_SAFE_INTEGER + 1` hits
it, but that value hits `isSafeInteger` first, and those tests call
`layout()` rather than `verifyHeader`.

**Acceptance Criteria:**
- [ ] A test supplies a `plaintextLength` that is a safe integer and
      still exceeds `MAX_SEGMENTS`, and asserts rejection.
- [ ] The test fails if the `MAX_SEGMENTS` check is removed.
- [ ] The misleading comments in `reader-header.ts` are corrected to
      describe which guard each case actually reaches.

### US-021: Wrong CEK and wrong objectId at every read entry point
**Description:** As a maintainer, I want the commitment gate covered at
the API surface, not only at `startOpen`.

**Acceptance Criteria:**
- [ ] `openObject` and `decryptAttachmentStream` each reject a wrong CEK
      and a wrong objectId, pinning `AttachmentError`.
- [ ] The range path is covered too.
- [ ] The error is the same opaque error in all cases.

### US-022: Untested guards get tests
**Description:** As a maintainer, I want the guards the mutation pass
found unprotected to be covered.

**Acceptance Criteria:**
- [ ] Each of these has a test that fails when the guard is removed:
      the `frame()` long-field branch in `kdf.ts`; `sealCryptoFromIds`
      with bad ids; the salt length check in `schedule.ts`; the
      `locator` passthrough in `writer.ts`; the byte-length guards in
      `parsePrefix` and `verifyHeader`.
- [ ] Verify each by applying the mutation, running the suite, and
      seeing the new test fail.

### US-023: Vendored vector fields are asserted
**Description:** As a maintainer, I want every field in the vendored
vectors checked, not commented on.

`F16.negative_snapverify`, `rewrite_segment_0` (F16 and F17) and
`stored_object_hex` (F23) are never asserted; `vectors-all.ts` only
`t.comment`s the last two.

**Acceptance Criteria:**
- [ ] All three fields are asserted, replacing the `t.comment` calls.
- [ ] The "9 total" vector inventory reflects reality; if three engine
      files are byte-identical to core, the count and its description
      say so.
- [ ] The check script's inventory count agrees with the doc.

### US-024: Block-boundary round-trips
**Description:** As a user, I want objects of exactly one and one-plus
block to round-trip on every path.

**Acceptance Criteria:**
- [ ] Positive round-trips for exactly 65536 and 65537 bytes through
      the stream path and the range path, matching byte for byte.
- [ ] The object path is covered too if it is not already.

### US-025: Error-swallowing tests pin the error type
**Description:** As a maintainer, I want a `TypeError` never to pass a
test that is supposed to prove an `AttachmentError`.

Six sites in `test/attachment/cek-wipe.ts` use `catch { t.ok(true) }`,
and `scripts/interop-seal.ts` has a bare `catch (_e) { // Expected }`
that lets any error pass the tamper case.

**Acceptance Criteria:**
- [ ] Every one of those catches asserts the thrown value is an
      `AttachmentError`.
- [ ] The interop tamper case fails if the thrown error is not the
      expected one.
- [ ] No test in the attachment suite accepts an unpinned throw.

### US-026: Tests that pass for the wrong reason are fixed
**Description:** As a maintainer, I want each test's title to match what
its failure would actually tell me.

The audit found: two "range zeroization on cancel" tests that die when
the pull wipe is removed rather than the cancel wipe (they read a chunk
first, so the stream has already closed); a tag-length and a huge-index
test that pass with the named guard deleted because another guard throws
first; a `verifyEpochRun` test and an `openBlock` leaf test that are
redundant with each other; a "missing segment data rejects" test that
passes with two `range.ts` checks removed; and a wipe test that works
only because the read-ahead has not run, making it fragile against
high-water-mark changes.

**Acceptance Criteria:**
- [ ] Each listed test either fails when its named check is removed, or
      is retitled and re-scoped to describe what it does test.
- [ ] The cancel tests exercise cancel before the stream closes.
- [ ] The read-ahead-dependent test no longer depends on the queuing
      strategy's high-water mark, or asserts that dependency explicitly.
- [ ] Verify each by removing the named check, running the suite, and
      seeing the test fail.

---

## Phase 7: Documentation

Note: no test asserts on documentation content. These stories are
verified by reading and by running the example code, not by new tests
over prose.

### US-027: README section for encrypted attachments
**Description:** As a library user, I want to learn from the published
README that this feature exists, how to import it, and how to use it end
to end.

Today the only README change is a two-link "See Also"; everything else
is internal. The API is reachable only through the `./*` subpath export,
and that fact lives in AGENTS.md.

**Acceptance Criteria:**
- [ ] A README section, "Encrypted attachments", covers: what the
      feature is; the subpath import form
      (`@vanishing.page/webcrypto-mls/attachment/writer` and siblings).
- [ ] One end-to-end example against a real group: take
      `state.keySchedule` from a `ClientState`, call
      `encryptAttachmentForGroup`, upload `EncryptedAttachment.bytes` or
      `.readable`, send the ref via `createApplicationMessage(...,
      authenticatedData)` using `refToAuthenticatedData`, receive with
      `refFromAuthenticatedData`, then decrypt with
      `decryptAttachmentStreamForGroup` or
      `openAttachmentRangeForGroup`.
- [ ] The range case shows using `ranges` to drive HTTP Range requests
      and passing one stream per range to `decrypt`.
- [ ] The section states: objectId rules (1 to 255 bytes, unique per
      epoch, never reused); that attachments become undecryptable after
      a commit and that this is indistinguishable from tampering; that
      abandoning a stream without reading to the end or cancelling
      leaves the CEK in memory; the `close()` contract; and that
      `openObject` takes a `number` `plaintextLength` while
      `AttachmentRef.plaintextLength` is a `bigint`.
- [ ] The example compiles. Extract it to a file under `example/` or
      `test/` that CI typechecks, or otherwise prove it is not
      hand-written pseudocode that drifts.
- [ ] The section links the working demo (see US-034).
- [ ] All lines are within 80 columns; no em dashes; no arrow
      characters.

### US-028: JSDoc on the public API surface
**Description:** As a user reading types in an editor, I want the
contract at the call site.

**Acceptance Criteria:**
- [ ] JSDoc on `sealObject`, `openObject`, `EncryptedAttachment`,
      `SealCrypto`, `encodeAttachmentRef` and `validateAttachmentRef`.
- [ ] Each documents its parameters, what it throws, and what memory it
      owns and wipes.
- [ ] `opts.salt`, `opts.locator` and `ownedCek` are each explained
      where they appear (`salt` per US-013).
- [ ] The `plaintextLength` number-versus-bigint difference is stated on
      `openObject`.

### US-029: Internal documentation cites are corrected
**Description:** As a maintainer, I want the internal docs to point at
code that exists.

**Acceptance Criteria:**
- [ ] `src/attachment/AGENTS.md` names `sealCryptoFromCiphersuite`, not
      `sealCrypto`.
- [ ] `src/attachment/AGENTS.md` no longer labels the writer wipe
      "success path only"; `writer.ts` wipes in a `finally`.
- [ ] `docs/security-audit.md`'s cites for the wrapper CEK wipe and for
      the `validateAttachmentRef` call point at the current lines.
- [ ] `test_vectors/seal/own/README.md` and ADR-002 cite the current
      `keys.ts` line range.
- [ ] The `close` JSDoc and type agree (closed by US-014).
- [ ] Every line reference touched in this story is verified by opening
      the file at that line.

### US-030: test-requirements.md matches the tests
**Description:** As a maintainer, I want the requirements document to
stop claiming coverage that does not exist.

**Acceptance Criteria:**
- [ ] The AC3.4 cite no longer claims those tests assert `verifyHeader`
      rejects `MAX_SAFE_INTEGER + 1` (they call `layout()`); it points
      at the real test from US-020.
- [ ] The "chunked helper" cite points at `stream-helpers.ts`.
- [ ] The zeroization assertion cite points at the real lines.
- [ ] AC4.2's range parameters match the test, or the test matches the
      document.
- [ ] AC5.1's "every per-segment field asserted" is true (closed by
      US-023) or the claim is narrowed.
- [ ] The "18 of 18 criteria verified by mutation" header is true after
      Phases 3 and 6, or is restated with the actual number and a list
      of what is not mutation-verified.

### US-031: House style sweep
**Description:** As a maintainer, I want the branch to satisfy the
project's line-length rule.

**Acceptance Criteria:**
- [ ] No line over 80 columns in: `README.md`, `docs/adr/INDEX.md`,
      `docs/fdr/INDEX.md`, `docs/security-audit.md`,
      `src/key-schedule.ts`, `test/attachment/seal-core.ts`,
      `example/attachments-demo.ts`, and the test-requirements and
      test-plan documents.
- [ ] Verified by a command over the branch's changed files, not by
      inspection.
- [ ] No em dashes and no arrow characters were introduced.

---

## Phase 8: Example demo

### US-032: The demo awaits its stream loop
**Description:** As a demo user, I want playback state and key wiping to
be correct, rather than firing after the first chunk.

`scheduleFrom`'s recursive `loop()` is not awaited, so `await loop()`
resolves after the first chunk. The `finally { cek.fill(0) }` in
`handlePlay` and `handleSeek` then runs while the stream is still being
pulled, and a mid-stream error leaves `playing` true.

**Acceptance Criteria:**
- [ ] The recursion is awaited (or restructured to a loop) so the
      promise settles only when the stream is done.
- [ ] The CEK is wiped after the stream finishes, not during.
- [ ] A mid-stream error clears `playing` and surfaces the error in the
      UI.
- [ ] Verify in the browser: play through a full track, seek mid-track,
      and trigger an error path.

### US-033: Sequential signal writes are batched
**Description:** As a maintainer, I want the demo to follow the house
rule on signals.

Unbatched pairs sit at roughly lines 243-244, 285-287, 304-305 and
376-378; lines 126, 187, 218 and 396 already batch.

**Acceptance Criteria:**
- [ ] Every sequential multi-signal write in
      `example/attachments-demo.ts` is wrapped in `batch`.
- [ ] No behavior change.
- [ ] Verify in the browser that the demo still works.

### US-034: The demo uses the API a consumer should use
**Description:** As a library user reading the demo, I want it to show
the recommended path.

The demo calls the low-level API with a random epoch secret and a
caller-owned CEK instead of the `...ForGroup` wrappers, so it does not
demonstrate what a consumer should do.

**Acceptance Criteria:**
- [ ] The demo drives a real group and uses
      `encryptAttachmentForGroup`, `decryptAttachmentStreamForGroup` and
      `openAttachmentRangeForGroup`.
- [ ] The demo no longer constructs a random epoch secret or manages a
      raw CEK by hand.
- [ ] The demo is linked from the README section (US-027).
- [ ] Verify in the browser: the demo plays and seeks as before.

### US-035: The demo wiring is covered
**Description:** As a maintainer, I want the 472 lines of real wiring
covered rather than only a 37-line helper.

`test/example/attachment-audio.ts` covers a small helper and contains a
constant-equals-literal assertion and an unpinned throw.

**Acceptance Criteria:**
- [ ] Tests cover the demo's pure logic: range planning for a seek,
      schedule construction, and the error and cleanup paths. Test
      behavior through the exported functions, not DOM text.
- [ ] No assertion compares a constant to its own literal value.
- [ ] The throw case pins `AttachmentError`.
- [ ] No test asserts on rendered HTML text.

---

## Functional Requirements

Correctness:
- FR-1: The range read path must verify that
  `[headerSize, firstBlockOffset)` is all zero, and must reject a
  non-zero byte there with the same error the object and stream paths
  raise.
- FR-2: The three read paths must accept and reject identical inputs.
  The parity test must run all three paths over the full tamper sweep.
- FR-3: The stream reader must treat a zero-length chunk as legal and
  must read until `done` when checking for trailing bytes.
- FR-4: Truncated input and trailing bytes must still be rejected.

Key hygiene:
- FR-5: A locked input stream must produce `AttachmentError` and must
  wipe the owned CEK.
- FR-6: Cancelling a range read at any point, including during
  `start()`, must zeroize `payloadKey`, `snapKey` and `nonceBase`.
- FR-7: A commitment mismatch in `startOpen` must wipe the derived state
  before throwing.
- FR-8: `safeExportSecret` must wipe each intermediate tree node, and
  `attachmentCek` must wipe `componentSecret` in a `finally`.
- FR-9: A cached per-epoch segment key must be wiped by
  `wipeSealState`.

API:
- FR-10: `encryptAttachmentForGroup` must not accept `salt`.
- FR-11: `encryptAttachment` and `sealObject` must document `salt` as
  test-and-vector use only, with the nonce-reuse consequence stated.
- FR-12: `AttachmentRangeRead.close` must be required.
- FR-13: `sealObject`, `openObject` and `encryptAttachment` must reject
  a CEK whose length is not `CEK_LENGTH`.
- FR-14: `validateAttachmentRef` must reject a snapshot of the wrong
  length explicitly.
- FR-15: All errors raised on these paths must remain the single opaque
  `AttachmentError`; no new error type and no distinguishing message.

Performance:
- FR-16: Block assembly must be O(bytes), not O(chunks^2).
- FR-17: Per-segment key derivation must run once per epoch, not once
  per segment.

CI:
- FR-18: `check-attachment-invariants.mjs` and
  `check-vector-determinism.mjs` must run in CI on every push.
- FR-19: The interop script must exit non-zero when `CI` is set and the
  Swift toolchain is missing.
- FR-20: CI must typecheck `test/`, `scripts/` and `example/`.
- FR-21: CI must run `test:browser`.

Tests:
- FR-22: Each of items 1 to 5 in the audit must have a regression test
  that fails before its fix.
- FR-23: The suite must include a positive round-trip of at least 1025
  segments on all three read paths.
- FR-24: The suite must include tamper cases on an epoch greater than 0
  for head and leaf on all three read paths.
- FR-25: No test in the attachment suite may accept an unpinned throw.
- FR-26: Every test named in the audit's "pass for a different reason"
  list must fail when its named check is removed, or be retitled.

Docs:
- FR-27: The README must document the feature, the subpath import, one
  compiling end-to-end example, the epoch caveat, the objectId rules,
  the abandonment leak, and the `close()` contract.
- FR-28: Public API JSDoc must cover the entry points and types named
  in US-028.
- FR-29: Every stale line-number cite named in the audit must point at
  current code.
- FR-30: No line on the branch may exceed 80 columns; no em dashes or
  arrow characters.

Demo:
- FR-31: The demo must await its stream loop and wipe the CEK only
  after the stream settles.
- FR-32: The demo must use the `...ForGroup` wrappers.
- FR-33: Sequential signal writes in the demo must be batched.

## Non-Goals

- No change to the wire format, the vector format, or any derivation
  output. Every existing test vector must still pass byte for byte
  after this work, with the sole exception of a vector that is itself
  proven wrong (none is currently known).
- No new public API beyond removing `salt` from the `...ForGroup`
  wrapper and making `close` required.
- No change to the single-opaque-error design. Errors do not gain
  messages, codes, or subclasses.
- No epoch field added to `AttachmentRef`. The epoch-less design is
  FDR-003 decision 5; this PRD documents the consequence rather than
  revisiting the decision.
- No redesign of the exporter-tree derivation or the commitment gate.
  The audit found both sound.
- No mutation-testing harness added to CI. Mutation runs stay a manual
  audit technique; the acceptance criteria call for verifying specific
  mutations by hand.
- No performance work beyond items 14 and 15. No streaming
  architecture rewrite.
- No visual redesign of the demo. US-032 through US-035 change wiring
  and correctness, not appearance.
- No new dependencies.

## Technical Considerations

- `range.ts` depends on `reader.ts` and not the reverse. The audit
  verified that one-way dependency; keep it. US-004's fix should mirror
  the two-latch pattern already in `reader.ts` rather than inventing a
  third shape.
- `getRandomValues` is banned under `src/attachment` and the ban is
  enforced by `check-attachment-invariants.mjs`. Any new test helper
  that needs randomness must take an injected RNG.
- `src/index.ts` must stay attachment-free. The feature is reachable
  only through the `./*` subpath export, which maps to `dist/*`.
- The wipe-presence checks in `check-attachment-invariants.mjs` may
  need updating as wipe sites move; update the check, do not weaken it.
- US-010's multi-epoch tests are the most expensive addition. Pick
  parameters that cross an epoch boundary without inflating suite
  runtime; note the tradeoff in the test file.
- Phase 4's `salt` removal is a breaking change to an unreleased API on
  this branch, so no deprecation cycle is needed. Confirm nothing
  outside this repo consumes it before merge.
- The Swift interop suite runs on macOS in CI. US-007 must not make the
  job fail on a machine where the toolchain is legitimately absent and
  `CI` is unset.

## Success Metrics

- Every one of the audit's numbered items is either closed or has a
  written, reviewed justification for why it stays open.
- The five leak defects each have a test that fails against the
  pre-fix code and passes after.
- The four surviving mutations named in audit test-item 1 are killed.
- All three read paths agree at every offset in the parity tamper
  sweep, including `l.headerSize`.
- CI fails when a structural invariant is violated. Demonstrated once
  per gate by a deliberate violation.
- `npm run test:unit`, `npm run test:matrix`, `npm run test:browser`,
  both check scripts, `tsc --noEmit` over src, test, scripts and
  example, and `npm run lint` all pass.
- A developer who has never seen the branch can encrypt, send, receive
  and range-read an attachment using only the published README.

## Open Questions

1. US-009: does `test:browser` run headless in CI today, or does it
   need a browser installed in the workflow? If the latter is
   disproportionate, the fallback in that story's criteria applies.
2. US-010: what segment size keeps a 1025-segment round-trip inside the
   existing 10-minute job timeout? Measure before committing to
   parameters; if it does not fit, the story may need its own job.
3. US-013: is there any caller of `encryptAttachmentForGroup` with
   `salt` outside this repository? If the branch is unreleased, no.
   Confirm before removing.
4. US-019: caching the expanded key per epoch changes `SealState`'s
   shape. Does anything serialize `SealState`? If so, the cache must be
   non-enumerable or excluded.
5. US-027: should the compiling example live in `example/` (shipped and
   linked) or in `test/` (typechecked only)? The first is better for
   users, the second is cheaper to keep passing.
6. Audit item 10: post-commit failures are indistinguishable from
   tampering by design. This PRD documents it. Is documenting it
   sufficient, or should a follow-up consider a caller-side epoch hint
   that improves the error without weakening the security property?
   Out of scope here either way.
