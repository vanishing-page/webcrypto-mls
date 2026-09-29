# Audit 2026-09: attachment fixes

**Status:** ready-for-agent
**Source:** `docs/security-audit-2026-09.md` (M5, M7, L10, L11, the
attachment Informational items on CEK length and range input, and the
`AUDIT-ra.md` and `src/attachment/AGENTS.md` record corrections)

## Problem Statement

An application that decrypts an encrypted attachment trusts the
subsystem on two things: that cancelling a read leaves no key material
behind, and that a hostile storage server cannot make the read consume
unbounded memory or bandwidth. Neither holds today.

If the application cancels a stream while an epoch key is being
derived, the wipe runs first and the derivation then writes the real
epoch key into the already-wiped state. Nothing wipes it again, and the
reader goes on to run one more decryption with it after the cancel.
Under natural timing this happens in roughly one cancel in sixteen. The
existing tests gate exactly this step but make their assertions before
releasing the gate, so they pass.

A range read drains the server's response before checking its length.
A malicious server or network path can send hundreds of megabytes for a
128 KiB range, or an endless body that never settles. The sequential
reader similarly buffers the entire header before it checks the 64-byte
commitment, so a wrong-commitment object can cost around 100 MiB before
it is rejected.

The KDF also leaves copies of the CEK and payload key in scratch
buffers it allocated and never wiped, so wiping the CEK does not remove
it from memory.

## Solution

Cancelling a read at any point, including mid-derivation, leaves every
key the subsystem derived zeroed and performs no further decryption.
Range reads stop pulling and cancel the source as soon as the response
exceeds the expected length. The sequential reader rejects a wrong
commitment before buffering more than the fixed-size prefix, rejects a
tampered metadata run at its own epoch, and holds one copy of the
header's metadata instead of three. The KDF wipes the
buffers it allocates. The public entry points validate their inputs as
strictly as the internal ones.

## User Stories

1. As an application, I want a cancel that lands during epoch-key
   derivation to leave no live epoch key, so that cancelling a read
   actually reclaims its key material.
2. As an application, I want no decryption to run after I cancel a
   stream or close a range read, so that a cancelled read releases no
   more plaintext.
3. As an application reading a byte range, I want the read to fail and
   the source to be cancelled as soon as the server sends more than the
   range's length, so that a malicious server cannot exhaust memory or
   bandwidth.
4. As an application reading a byte range from a server that never
   ends the body, I want the read to settle with an error, so that it
   does not hang.
5. As an application whose range read fails for any reason, I want
   every source stream it opened cancelled, so that no connection is
   left draining in the background.
6. As an application opening an attachment with the wrong commitment,
   I want the rejection to happen after reading only the fixed-size
   prefix, so that a hostile object cannot make me buffer its whole
   header.
7. As an application opening a very large attachment, I want each
   epoch's metadata verified as it arrives and held only once, so that
   a tampered run is rejected at its own epoch and a member-signed
   `plaintextLength` cannot force three copies of an already large
   header.
8. As an application, I want the CEK and payload key to be absent from
   memory after I wipe my CEK, so that the KDF does not keep copies I
   cannot reach.
9. As an application, I want `decryptAttachmentStream` and
   `openAttachmentRange` to reject a CEK of the wrong length, and range
   requests to reject non-finite offsets and lengths, so that the
   public entry points fail fast and consistently.
10. As an application, I want `openAttachmentRange` to hand me ranges I
    can mutate without affecting the read, so that the read's internal
    plan is not shared with its caller.
11. As a maintainer reading `AUDIT-ra.md` and the subsystem's
    `AGENTS.md`, I want the records the 2026-09 audit proved inaccurate
    corrected, so that "closed" means closed.

## Implementation Decisions

- M5: `SealState` gains a `wiped` flag that `wipeSealState` sets. The
  segment-key path checks it after every await that precedes a write to
  the state: if the state was wiped meanwhile, the freshly derived key
  is zeroed (this call allocated it, so the ownership rule allows it)
  and the call throws rather than caching. The reader's `pull` and the
  range path treat that throw as the cancellation it is, not as a
  tamper error.
- M5 is a regression from the epoch-key cache that closed `AUDIT-ra.md`
  row 1.15. The fix keeps the cache; it only makes the cache respect a
  wipe that happened while a derivation was in flight.
- M7: the range path's drain takes the expected length. Once the bytes
  received exceed it, the drain cancels its reader and throws
  `AttachmentError`. A short body is still detected after the drain, as
  today. On any failure the range read cancels every source stream it
  has not finished draining.
- L11: the reader runs the commitment gate as soon as it has the
  fixed-size prefix (the 32-byte salt plus the nh-byte commitment),
  before buffering the rest of the header. The root check runs once
  the epoch heads have arrived, and each epoch's metadata run is then
  verified against its head as it streams in. The metadata region is
  held once; today it is held in the chunk list, the reassembled
  header and the metadata slice.
- L11 cannot bound the sequential reader to one epoch's metadata. The
  layout puts every segment's leaf and tag in the header ahead of block
  0, and `openBlock` needs a segment's stored leaf and tag when that
  block arrives, so the reader must hold all of it by block 0. That
  O(nSeg) buffer is recorded as a remaining gap in
  `src/attachment/AGENTS.md`.
- L10: every KDF buffer that can hold key material is zeroed by the
  function that allocated it. `encode` zeroes the framed parts it built
  with `frame()` once it has concatenated them (`frame()` always
  allocates through `concatAll`, so a framed part is never the caller's
  input). `sealKdf` zeroes the extract input and the PRK in a
  `finally`. Neither touches the caller's `ikm` or the returned output.
- The framed-part wipe inside `encode` cannot be observed from any
  seam: those buffers never reach the injected crypto. It carries a
  comment saying so, in the style of the existing "untestable as such"
  notes in `range.ts`, rather than a test.
- The two public entry points that currently skip it call the existing
  CEK length assertion. Range planning rejects `NaN` and other
  non-finite values with `AttachmentError`. `openAttachmentRange`
  returns a copy of its range plan, not the array the read uses.
- Every existing structural gate in `npm run test:checks` must stay
  green: `src/index.ts` stays attachment-free, no module calls
  `getRandomValues`, and every module that owns a `SealState` still
  wipes it. No new gate is needed.
- Record corrections: `AUDIT-ra.md` resolution rows 1.4, 2.2 and 1.15
  are amended to state that the cancel-in-`start()` guarantee did not
  cover epoch-key derivation until this spec, and row 1.12 is amended
  to note the two entry points fixed here. The corrections change row
  text only; no finding is added to the `AUDIT-ra.md` body, so
  `check-audit-closed` keeps its one-row-per-finding invariant without
  new rows. `src/attachment/AGENTS.md` "Two gaps remain" is updated so
  it lists what actually remains after this spec.

## Testing Decisions

- A good test drives a public stream entry point -- the sequential
  reader, the group reader, or a range read -- and asserts only what an
  application can observe: whether the stream errors or completes,
  which error class, how many bytes the source was asked for, whether
  the source was cancelled, and whether the key material handed in or
  exposed by the injected crypto is zero afterwards.
- One seam: the public stream entry points, with two injected test
  doubles that already exist. The gated recording crypto provider
  pauses a derivation by its label so a cancel can land inside it; the
  hostile `ReadableStream` is a source the test controls (oversized,
  endless, or counting what was pulled).
- M5 tests gate the `epoch_key` derivation, cancel while it is paused,
  release the gate, and only then assert: the epoch key the recording
  crypto produced is zero, and no AEAD decryption was recorded after
  the cancel. This is exactly the step the existing gated tests
  exercise; they are corrected to assert after release, and the
  schedule-wipe assertion is extended to cover the epoch key. Both the
  reader and range paths are covered.
- M7 tests serve an oversized body and an endless body to a range read
  and assert the read rejects, the source is cancelled, and the bytes
  pulled stay within one chunk of the expected length.
- L11 tests serve a wrong-commitment object behind a counting source
  and assert rejection after at most the prefix plus one chunk. A
  second L11 test tampers with epoch 0's metadata run in the
  multi-epoch fixture and asserts rejection before the source has
  handed over epoch 1's run.
- L10 is tested through the recording crypto: after the caller wipes
  its CEK, no buffer the KDF was handed or produced still holds it.
- Tests are timing-independent: they use gates and counting sources,
  never sleeps or natural-timing races.
- Prior art: `test/attachment/streams.ts` (gated recording crypto,
  the cancel-during-derivation cases), `test/attachment/epoch-key-cache.ts`,
  `test/attachment/cek-wipe.ts`, `test/attachment/range-close-type.ts`,
  `test/attachment/reader-header.ts`, and `test/attachment/cek-length.ts`.
  New files are imported from `test/unit.ts`.

## Out of Scope

- A closeable handle for a reader stream that is constructed and never
  read or cancelled. That is the documented known limitation in the
  subsystem's `AGENTS.md` and needs a breaking API change.
- Binding the CEK to the sender. The audit recommends applications
  dedupe on `(objectId, snapshot)`; documenting that is welcome but
  not required here.
- A layout change that would let the sequential reader hold less than
  the whole metadata region. See the second L11 decision above.
- Every core-library and demo finding (see the sibling specs).

## Further Notes

- The audit measured the M5 race at 12 of 200 natural-timing cancels;
  the gated tests make it deterministic, which is why they, not a
  timing loop, are the regression guard.
- `drainStream` in the test helpers is unrelated to the range path's
  internal drain; do not conflate them when reading the audit.
