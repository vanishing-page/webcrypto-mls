# 05: The KDF wipes its scratch buffers

**What to build:** audit finding L10, spec story 8. Once an
application wipes its CEK, no copy of the CEK or of the payload key
remains in any buffer the SEAL KDF allocated. Today `sealKdf` leaves
copies in its extract input and its PRK. The audit found four
extract-input buffers still holding the CEK, one per `sealKdf` call
that takes the CEK as input. Each call also leaves a second copy in the
framed part `encode` built with `frame()` before concatenating.

Each buffer is zeroed by the function that allocated it. `encode`
zeroes its framed parts once `concatAll` has joined them. `frame()`
always allocates through `concatAll`, so a framed part is never the
caller's input. `sealKdf` zeroes the extract input and the PRK in a
`finally`. Neither may zero the caller's `ikm` arrays or the returned
output.

The framed-part wipe cannot be observed from any seam, because those
buffers never reach the injected crypto. Give it a comment saying so,
in the style of the "untestable as such" notes in `range.ts`, rather
than a test. The extract input (the `ikm` handed to `kdf.extract`) and
the PRK (what `kdf.extract` returns) are both visible to the recording
crypto, and the criteria below pin them.

Record corrections belong in this ticket. Update the "CEK zeroization:
residual gaps" section of `src/attachment/AGENTS.md` to say the KDF
scratch buffers are now wiped.

**Blocked by:** None (can start immediately)

**Touches:** `src/attachment/kdf.ts` (`sealKdf`, `encode`),
`test/attachment/cek-wipe.ts`, `test/attachment/guards-kdf-schedule.ts`,
`src/attachment/AGENTS.md`

**Status:** done

- [x] Seal and then read an object through recording crypto that
      captures every buffer passed to or returned by `kdf.extract` and
      `kdf.expand`. Once the caller wipes the CEK and the stream ends,
      no captured buffer other than the caller's own still contains
      the CEK's bytes.
- [x] The same holds for the payload key: after the read ends, no
      captured KDF buffer contains it.
- [x] Every vendored and self-generated SEAL vector still matches
      (`scripts/check-vector-determinism.mjs` and
      `test/attachment/vectors-all.ts`).
- [x] The caller's `ikm` buffers are not modified by `sealKdf`.
- [x] `npm run test:checks` stays green.
