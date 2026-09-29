# 01: A cancel during epoch-key derivation leaves no live key

**What to build:** audit finding M5, spec stories 1 and 2. When an
application cancels a sequential read, a group read, or a range read
while an epoch key is being derived, the derived key ends up zeroed
and no AEAD decryption runs after the cancel. Today `wipeSealState`
runs first, the in-flight derivation then writes the real key into the
already-wiped `epochKeys` map, nothing wipes it again, and `pull` runs
one more `aead.decrypt` with it.

The fix keeps the epoch-key cache (it closed `AUDIT-ra.md` row 1.15).
`SealState` gains a `wiped` flag that `wipeSealState` sets.
`segmentKey` checks it after the `sealKdf` await and before it caches
the key. If the state was wiped while the derivation was in flight,
`segmentKey` zeroes the key (this call allocated it, so the ownership
rule allows the wipe) and throws. The reader's `pull` and the range
path's `start()` treat that throw as a cancellation, not as tampering.

Record corrections belong in this ticket. Amend `AUDIT-ra.md`
resolution rows 1.4, 2.2 and 1.15 to say that the cancel-in-`start()`
guarantee did not cover epoch-key derivation until this fix. Change row
text only and add no finding to the body, so `check-audit-closed`
stays green. Update the "The epoch key cache" section of
`src/attachment/AGENTS.md` to describe the `wiped` check.

**Blocked by:** None (can start immediately)

**Touches:** `src/attachment/schedule.ts` (`SealState`, `segmentKey`,
`wipeSealState`), `src/attachment/reader.ts` (`decryptAttachmentStream`
`pull`/`cancel`), `src/attachment/range.ts` (`decryptRangeStream`),
`test/attachment/streams.ts` (`assertScheduleWiped`,
`gatedRecordingCrypto`, the gated `epoch_key` cases near :1653 and
:1807), `test/attachment/epoch-key-cache.ts`, `AUDIT-ra.md`,
`src/attachment/AGENTS.md`

Note: ticket 02 also edits `start()` in `range.ts`. The two tickets
are independent, so expect a merge conflict there if they run in
parallel.

**Status:** done

- [x] Sequential reader: gate the `epoch_key` derivation, cancel the
      stream while it is parked, release the gate, and only then
      assert. The epoch key the recording crypto produced is all
      zero, and no `aead.decrypt` was recorded after the cancel.
- [x] Group reader (`decryptAttachmentStreamForGroup`): the same
      gated cancel yields a zeroed epoch key and no decryption after
      the cancel.
- [x] Range read: the same gated cancel, landing during the
      `epoch_key` derivation inside `start()`, yields a zeroed epoch
      key and no decryption after the cancel.
- [x] The existing gated cancel tests in `test/attachment/streams.ts`
      make their assertions after `gate.release()`, not before, and
      `assertScheduleWiped` checks the epoch key alongside
      `payloadKey`, `snapKey` and `nonceBase`.
- [x] A read that is never cancelled still derives each epoch key
      once and reuses it for the whole epoch. The derivation count in
      `test/attachment/epoch-key-cache.ts` is unchanged.
- [x] Every test is timing-independent: gates only, no sleeps and no
      loops that count natural-timing races.
- [x] `npm run test:checks` stays green (every module that owns a
      `SealState` still wipes it, and the `AUDIT-ra.md` table keeps
      one row per finding).
