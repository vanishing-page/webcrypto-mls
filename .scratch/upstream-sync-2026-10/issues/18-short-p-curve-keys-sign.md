# 18: P-curve signing accepts a private key with leading zeros trimmed

**What to build:** spec story 24. An application importing a P-256,
P-384 or P-521 private key from a source that trims leading zero bytes
can sign with it. One key in 256 has a leading zero byte (far more for
P-521, whose top byte holds a single bit).

Start with the test, run against the current code. The audit could
not confirm whether noble 2.4 rejects a short key. If it already
accepts one, the ticket reduces to committing the test as a pin, plus
the over-long-key refusal below, and saying so in the commit message.

Otherwise, the noble signature implementation, used for P-256, P-384
and P-521 by both the default provider and `nobleCryptoProvider`,
left-pads a key shorter than the field length (32, 48 and 66 bytes)
before signing. The padded copy is allocated by the call and wiped
after signing, in a `finally`; the caller's key is never touched (the
zeroization ownership rule in AGENTS.md). A key longer than the field
length is refused with a `UsageError` in either case. Verification
does not change. Read upstream `ff55ddd` for intent only.

Build the short key deterministically: a valid scalar whose first byte
is zero, its public key derived from the full-length form, then the
leading zero dropped.

**Blocked by:** None (can start immediately)

**Touches:** `src/crypto/implementation/default/make-noble-signature-impl.ts`,
`src/crypto/implementation/noble/make-noble-signature-impl.ts`,
`test/crypto/signature.ts`. Prior art:
`test/crypto/signature-interop.ts`, `test/crypto/key-match.ts`.

**Status:** done

- [x] For each of P-256, P-384 and P-521, in both providers, a private
      key with its leading zero byte trimmed signs, and the signature
      verifies under the public key of the full-length key.
- [x] The caller's key bytes are unchanged after signing.
- [x] A key one byte longer than the field length is refused with a
      `UsageError`, in both providers.
- [x] Full-length keys sign and verify as before, and
      `signature-interop.ts` passes unchanged.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style`, `npm test` and `npm run test:browser`
      pass.
