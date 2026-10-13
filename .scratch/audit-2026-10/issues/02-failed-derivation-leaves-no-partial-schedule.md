# 02: A failed derivation leaves no partial schedule

**What to build:** audit finding F7, spec stories 14, 15 and 16. Two
paths drop derived keys without wiping them when a crypto provider's
KDF rejects partway.

Schedule construction (`deriveSchedule`, reached through `startSeal`
and `startOpen`/`openCommitment`) derives the commitment, payload key,
snapshot key (`acc_key`) and nonce base one after another. If a later
derivation rejects, the buffers already derived are dropped unwiped.
Fix: wipe every buffer this call has already derived, then rethrow the
original error. Never wipe the CEK, which the schedule borrows.

`verifyRoot` holds a complete schedule from the moment
`openCommitment` returns. If the root check rejects for any reason
other than a mismatch, the schedule is neither wiped nor handed to the
caller. Fix: `verifyRoot` owns the schedule until it returns it, and
wipes it and rethrows on any rejection. The mismatch-specific cleanup
that exists today then becomes redundant and folds into this.

This ticket also builds the test seam the attachment area shares: a
real ciphersuite wrapped so that its KDF can be made to reject at a
named label, and that keeps a reference to every buffer the KDF
returns. Assertions are that each recorded buffer is all zeros once
the operation has settled; the test never reaches into a `SealState`.
Build it so ticket 03 can add a pause-at-label gate to the same
wrapper (the gated suite in `test/attachment/cancel-epoch-key.ts`
already pauses a derivation by label; reuse its approach).

Read `src/attachment/AGENTS.md` before the first edit. The invariants
in `scripts/check-attachment-invariants.mjs` must still hold. No new
public API, and the KDF labels and their order do not change.

**Blocked by:** None (can start immediately)

**Touches:** `src/attachment/schedule.ts` (`deriveSchedule`,
`wipeSealState`), `src/attachment/reader.ts` (`openCommitment`,
`checkRoot`, `verifyRoot`), `src/attachment/range.ts` (the call to
`verifyRoot` in `start()`, only if the redundant cleanup lives there),
`test/attachment/helpers.ts` or a new test helper for the recording
KDF wrapper, a new test file under `test/attachment/` (imported from
`test/unit.ts`)

Note: ticket 03 also edits `src/attachment/reader.ts`, which is why it
is blocked on this one.

**Status:** done

- [x] A KDF that rejects at the `nonce_base` derivation during schedule
      construction makes the public stream entry point reject, and
      every buffer the KDF returned before the rejection is all zeros
      afterwards.
- [x] The original KDF error is what the operation rejects with (same
      class), not a wrapper or a cleanup error.
- [x] A KDF that rejects at the snapshot epoch root during a range
      read's root check makes the range read reject, and every buffer
      of the schedule the KDF returned is all zeros afterwards.
- [x] A root mismatch (tampered root, honest KDF) still rejects with
      `AttachmentError` and still leaves the schedule zeroed.
- [x] A caller-owned CEK passed to a borrowing entry point is
      byte-for-byte unchanged after each of the failures above.
- [x] A successful seal, sequential read and range read over the
      existing fixtures still return the correct plaintext.
- [x] `npm run test:checks` passes, including
      `check-attachment-invariants.mjs`.
