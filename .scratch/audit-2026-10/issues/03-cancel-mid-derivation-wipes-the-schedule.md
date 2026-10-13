# 03: A cancel during the final derivation wipes the schedule

**What to build:** audit finding F4, spec story 13. A consumer that
cancels a sequential decrypt stream at the wrong moment leaves the
whole schedule live. If the object's first chunk holds all of it, and
the cancel lands while the final derivation of the commitment gate is
still settling, the cancel finds no state to wipe. The derivation then
completes, startup finishes from buffered bytes, and nothing pulls the
stream again. The CEK is wiped; the payload key, `acc_key` and nonce
base are not.

Fix: the sequential reader latches cancellation in one place, and
every point where it acquires a `SealState` across an await checks the
latch immediately after the await returns. On a cancelled latch it
wipes the state it just acquired and returns without continuing
startup. The existing two-latch arrangement (one for the state, one
for the CEK) stays; its comment explains why they must not merge, and
the new check sits beside them rather than replacing either.

Then check the other entry points that acquire a schedule across an
await while a cancel can land -- `decryptAttachmentStreamForGroup` and
the range reader's `start()` -- for the same shape. Any that has it
gets the same fix and the same regression test. Record in the ticket's
comments which ones were checked and what was found.

Use the recording KDF wrapper from ticket 02 and add a pause-at-label
gate to it (or reuse the gate in `test/attachment/cancel-epoch-key.ts`).
Races are made deterministic with the pause gate, never with timers.
Assertions are taken after the paused derivation is released and the
stream has settled, because the defect is in what happens once the
derivation resumes.

Read `src/attachment/AGENTS.md` before the first edit; its section on
awaits in `start()` describes the existing latches.

**Blocked by:** 02

**Touches:** `src/attachment/reader.ts` (`decryptAttachmentStream`
start/pull/cancel, `decryptAttachmentStreamForGroup`),
`src/attachment/range.ts` (`decryptRangeStream` `start()`/`cancel()`,
only if it shares the shape), the recording KDF wrapper from 02,
`test/attachment/cancel-epoch-key.ts` or a new test file under
`test/attachment/` (imported from `test/unit.ts`)

**Status:** done

- [x] Regression: a fully buffered object, the KDF paused on the last
      derivation of the commitment gate, the output stream cancelled,
      the KDF released, and the operation allowed to settle -- every
      buffer the KDF returned is all zeros, and the CEK is wiped.
- [x] After that cancel, the stream emits no plaintext chunk.
- [x] The same regression, with the same assertions, for each other
      entry point found to share the shape.
- [x] A cancel that lands at each other derivation label of the
      schedule (payload key, `acc_key`, nonce base) leaves every
      returned buffer zeroed as well.
- [x] An uncancelled read over the same fixture still returns the
      correct plaintext and the existing CEK-wipe and
      cancel-epoch-key suites still pass.
- [x] Every test is timing-independent: pause gates only, no sleeps or
      timers.
- [x] `npm run test:checks` passes.

## Comments

Entry points checked for the shape (a `SealState` acquired across an
await while a cancel can land, with no re-check after it):

1. `decryptAttachmentStream` -- had it. `openCommitment` was the one
   await in `start()` that hands over a state, and nothing looked at
   the cancel afterwards. Fixed with a `cancelled` latch set in
   `cancel()` and checked as soon as `openCommitment` returns.
   Red before the fix at `acc_key` and `nonce_base` (a cancel at
   `payload_key` was already caught, because the later keys derive
   from the wiped CEK and the root check fails into the catch).
2. `decryptAttachmentStreamForGroup` -- had it, through delegation:
   its own await (`attachmentCek`) finishes before the stream exists,
   and the stream is `decryptAttachmentStream`'s. Same fix, separate
   regression test; red before the fix at the same two labels.
3. `decryptRangeStream` `start()` (via `openAttachmentRange` and
   `openAttachmentRangeForGroup`) -- does not have it. `start()`
   assigns `ctx` and calls `throwIfCancelled()` immediately after
   `verifyRoot`, so the catch wipes. The range regression test was
   green before the fix and stays as a pin.

Tests: `test/attachment/cancel-schedule-wipe.ts`.
