# 06: The public entry points validate their inputs strictly

**What to build:** the attachment Informational items from the
2026-09 audit, spec stories 9 and 10. `decryptAttachmentStream` and
`openAttachmentRange` reject a CEK of the wrong length up front, as
`sealObject`, `openObject` and `encryptAttachment` already do.
Today they fail later, at the commitment gate. Range planning rejects
`NaN`, `Infinity` and other non-finite offsets and lengths with
`AttachmentError`. `openAttachmentRange` hands back a copy of its
range plan, so a caller that mutates the returned `ranges` does not
change the read.

Both entry points call the existing `assertCekLength` from `keys.ts`.
`decryptAttachmentStream` returns its stream synchronously, so the
check throws synchronously there, matching how `validateAttachmentRef`
already fails.

Record corrections belong in this ticket. Amend `AUDIT-ra.md`
resolution row 1.12 to name the two entry points fixed here. Change row
text only and add no finding, so `check-audit-closed` stays green.

**Blocked by:** None (can start immediately)

**Touches:** `src/attachment/reader.ts` (`decryptAttachmentStream`),
`src/attachment/range.ts` (`openAttachmentRange`),
`src/attachment/layout.ts` (`rangesFor`),
`src/attachment/keys.ts` (`assertCekLength`, read-only),
`test/attachment/cek-length.ts`, `test/attachment/layout.ts`,
`AUDIT-ra.md`

**Status:** done

- [x] `decryptAttachmentStream` throws `AttachmentError` for a CEK
      that is too short and for one that is too long, before it reads
      the source (a counting source reports zero pulls).
- [x] `openAttachmentRange` rejects with `AttachmentError` for a CEK
      of the wrong length.
- [x] `openAttachmentRange` and `rangesFor` reject `NaN`, `Infinity`
      and `-Infinity` as either the offset or the length, with
      `AttachmentError`.
- [x] Mutating the `ranges` array returned by `openAttachmentRange`,
      or one of its entries, does not change what a later `decrypt`
      fetches or returns.
- [x] Correct CEK lengths and finite ranges still read correctly.
- [x] `npm run test:checks` stays green.
