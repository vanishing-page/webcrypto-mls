# 17: `decodeMlsMessage` refuses input over 64 MiB

**What to build:** spec story 23. A peer cannot make a member parse an
arbitrarily large buffer: the top-level message decoder refuses input
longer than 64 MiB before parsing it.

`decodeMlsMessage` checks the length of the bytes it is given, from
the offset to the end, against 64 MiB and fails the same way any
malformed input fails, so every caller's existing error mapping
applies unchanged. Name the limit as a constant beside the decoder.
Read upstream `8e58578` for intent only.

The test cannot observe parsing directly, so it compares two inputs
that differ only in length: build a message that decodes at exactly 64
MiB (for example a PrivateMessage whose ciphertext fills it, or a
valid message plus whatever padding the decoder accepts), then the
same input one byte longer. Each allocation is 64 MiB, which the
browser run tolerates, but the browser run treats three silent seconds
as a stall (see AGENTS.md), so keep the case fast.

**Blocked by:** None (can start immediately)

**Touches:** `src/message.ts` (`decodeMlsMessage`),
`test/codec/message.ts`. Prior art: `test/codec/roundtrip.ts`,
`test/validation/peer-input-errors.ts`.

**Status:** done

- [x] An input of exactly 64 MiB that is otherwise a valid message
      decodes.
- [x] The same input one byte longer is refused the way a malformed
      message is refused.
- [x] Every existing codec suite passes unchanged.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style`, `npm test` and `npm run test:browser`
      pass.
