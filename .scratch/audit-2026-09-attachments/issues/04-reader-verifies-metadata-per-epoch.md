# 04: The reader verifies metadata per epoch, holding one copy

**What to build:** second half of audit finding L11, spec story 7.
Once the commitment gate from 03 has passed, the sequential reader
checks the root as soon as the epoch heads have arrived. It then
verifies each epoch's metadata run against its head as that run
streams in, so a tampered run is rejected at its own epoch instead of
after the whole header. The metadata region is held once, not three
times.

Why the bound is one copy rather than one epoch (the audit's "stream
metadata per epoch" reads as the latter, and the spec's second L11
decision explains why that cannot be done): every segment's metadata
(leaf and tag) sits in the header ahead of block 0, and `openBlock`
needs a segment's stored leaf and tag when that block arrives. So by
the time the sequential reader reaches block 0 it must hold all the
metadata. What can be bounded is the number of copies. Today the
header sits in `totalBytes`, again in `headerTotal`, and again in the
`HeaderContext.metadata` slice, so the peak is about 3x the metadata
size. Record the remaining O(nSeg) cost as a gap. Only a layout change
could remove it, and that is out of scope.

Keep the lazy-verification guarantee documented in
`src/attachment/AGENTS.md` ("Lazy leaf-run verification", "Which
heads the root is computed from"): the root still folds in the stored
heads before any plaintext is released. All reader buffering still
goes through `pushChunk` and `consumeFront` ("The reader's chunk queue
must stay O(1) per byte").

Record corrections belong in this ticket. Update the "Two gaps remain"
section of `src/attachment/AGENTS.md` so it lists what actually remains
after this spec: the two existing gaps, plus the sequential reader's
O(nSeg) metadata buffer and why the layout forces it. Note that M5 and
L10, which the 2026-09 audit said were missing from that list, are
closed by tickets 01 and 05.

**Blocked by:** 03 (restructures the same header-buffering loop)

**Touches:** `src/attachment/reader.ts` (`decryptAttachmentStream`
`start()`/`pull()`, `verifyHeader`, `verifyEpochRun`, `openBlock`,
`HeaderContext`), `test/attachment/reader-header.ts`,
`test/attachment/multi-epoch-tamper.ts`,
`test/attachment/multi-epoch-fixture.ts` (read-only),
`src/attachment/AGENTS.md`

**Status:** done

- [x] Take the multi-epoch fixture, tamper with a byte in epoch 0's
      metadata run, and put it behind a counting source. The
      sequential reader rejects it with `AttachmentError` before the
      source has handed over epoch 1's metadata run, and the source is
      cancelled.
- [x] A tampered stored epoch head is still rejected before any
      plaintext is emitted.
- [x] The multi-epoch fixture still decrypts correctly end to end, and
      so do partial reads that cancel inside epoch 0.
- [x] `test/attachment/small-chunks.ts` stays within its wall-clock
      budget.
- [x] `test/attachment/parity.ts` (reader vs `openObject`) stays green.
- [x] `npm run test:checks` stays green.
