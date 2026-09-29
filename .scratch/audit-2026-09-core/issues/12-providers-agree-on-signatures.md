# 12: Providers agree on Ed25519 signatures; small-order keys rejected

**What to build:** audit findings M4 and L12, spec stories 18 and 19.
The noble provider's EdDSA verify uses noble's default
`{ zip215: true }`, which accepts a non-canonical R. The default
provider's Ed25519 is WebCrypto, which is RFC 8032 strict. A member
signing with a non-canonical R therefore forks a group that mixes
providers. Separately, both providers accept the identity point as a
signing key, and with it (R = identity, S = 0) verifies for every
message: a universal-forgery leaf key.

After this ticket:
- Both noble EdDSA verifies use strict (`zip215: false`) verification.
- LeafNode and KeyPackage validation reject a signature public key
  that is the identity point or of small order, for Ed25519 and Ed448,
  with `ValidationError`.
- L12 is documented, not enforced. WebCrypto's ECDSA verify accepts
  high-S, so enforcing low-S in the noble provider alone would recreate
  the fork M4 fixes. Add to the README's "Security Considerations":
  signed bytes are malleable in `s`, so applications must not key
  anything on a hash of a signature. Follow the AGENTS.md rule on
  fenced code inside bullets there.

**Blocked by:** None (can start immediately)

**Touches:**
`src/crypto/implementation/default/make-noble-signature-impl.ts`
(`makeNobleSignatureImpl`), `src/client-state.ts`
(`validateLeafNodeCommon`, `validateKeyPackage`),
`test/crypto/signature-interop.ts`,
`test/scenario/mixed-provider-interop.ts`, `README.md`,
`CHANGELOG.md`

**Status:** done

- [x] At `verifyWithLabel`: a signature with a canonical key but a
      non-canonical R verifies to the same result (false) under the
      noble and WebCrypto providers.
- [x] At `verifyWithLabel`: with the identity point as the key and
      R = identity, S = 0, both providers return false.
- [x] A KeyPackage whose Ed25519 signature key is the identity point
      (or another small-order point) is rejected with `ValidationError`
      when it is added, and so is an Update or commit leaf carrying one.
- [x] The same holds for Ed448 on the suites that use it.
- [x] Honest groups on every Ed25519 and Ed448 suite, under both
      providers, still join and exchange messages.
