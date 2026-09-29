# 03: The sequential reader checks the commitment on the fixed prefix

**What to build:** first half of audit finding L11, spec story 6. The
sequential reader rejects an object with the wrong commitment after
reading only the fixed-size prefix (the 32-byte salt plus the nh-byte
commitment). Today `decryptAttachmentStream` buffers the whole header,
roughly 100 MiB at the design's 128 GiB target, before `verifyHeader`
calls `startOpen`. A hostile object therefore costs its full header
size before it is rejected.

The reader runs the commitment gate (`startOpen` through the existing
`verifyRoot`/`parsePrefix` split) as soon as it has 32 + nh bytes, and
only then buffers the rest of the header. The snapshot and root checks
keep their current order after the gate. `range.ts` imports
`parsePrefix`, `verifyRoot`, `verifyEpochRun` and `openBlock` from
`reader.ts`, so keep those exports working for it. `reader.ts` must
still not import `range.ts` (enforced by
`check-attachment-invariants`).

**Blocked by:** None (can start immediately)

**Touches:** `src/attachment/reader.ts` (`decryptAttachmentStream`
`start()`, `verifyHeader`, `parsePrefix`, `verifyRoot`),
`test/attachment/reader-header.ts`, `test/attachment/commitment-gate.ts`

**Status:** done

- [x] Put an object with the wrong commitment behind a counting
      source. The sequential reader rejects it with `AttachmentError`
      after the source has handed over at most 32 + nh bytes plus one
      chunk, and the source is cancelled.
- [x] The group reader (`decryptAttachmentStreamForGroup`) rejects a
      wrong-commitment object within the same bound.
- [x] After that rejection, the owned CEK and every seal-state key the
      recording crypto produced are zero.
- [x] Well-formed objects still decrypt from both a single-chunk source
      and a one-byte-per-chunk source (`test/attachment/small-chunks.ts`
      stays within its budget).
- [x] `npm run test:checks` stays green.
