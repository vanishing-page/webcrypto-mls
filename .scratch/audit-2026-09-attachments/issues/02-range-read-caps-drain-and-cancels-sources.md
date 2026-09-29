# 02: A range read caps its drain and cancels its sources

**What to build:** audit finding M7, spec stories 3, 4 and 5. A range
read stops pulling and fails with `AttachmentError` as soon as a
source sends more bytes than its range is long. A source whose body
never ends therefore settles with an error instead of hanging. Today
the internal `drainStream` in `range.ts` reads each source to the end
before it compares lengths, so a hostile server can send hundreds of
megabytes for a 128 KiB range, or an endless body that never settles.

The range path's drain takes the expected length. Once it has received
more than that, it cancels its reader and throws. A short body is still
caught after the drain, as it is today. When the range read fails for
any reason, including a consumer cancel that arrives mid-drain, it
cancels every source stream it has not finished draining, so no
connection keeps draining in the background.

Do not confuse the internal drain with the `drainStream` helper in the
test files. They are unrelated.

**Blocked by:** None (can start immediately)

**Touches:** `src/attachment/range.ts` (`drainStream`,
`decryptRangeStream` `start()`/`cancel()`, `openAttachmentRange`),
`test/attachment/range-close-type.ts` or a new
`test/attachment/range-drain.ts` (a new file is imported from
`test/unit.ts`)

Note: ticket 01 also edits `start()` in `range.ts`. The two tickets
are independent, so expect a merge conflict there if they run in
parallel.

**Status:** done

- [x] Oversized body: a range read whose source keeps sending after
      the range's length rejects with `AttachmentError`. The source is
      cancelled, and the bytes pulled stay within one chunk of the
      expected length.
- [x] Endless body: a range read whose source never closes settles
      with `AttachmentError`, and the source is cancelled.
- [x] Short body: a source that closes before the range's length is
      still rejected with `AttachmentError`.
- [x] When source i fails or overruns, every source after i that has
      not been drained is cancelled.
- [x] When the consumer cancels the output stream while a source is
      still being drained, that source and every later one are
      cancelled.
- [x] A well-formed range read over the multi-epoch fixture still
      returns the correct plaintext.
- [x] Every test is timing-independent: counting and controllable
      `ReadableStream` sources only, no sleeps.
