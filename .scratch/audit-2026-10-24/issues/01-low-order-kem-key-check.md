# 01: Low-order X25519 and X448 key check

**What to build:** the prefactor for spec stories 8 and 9 (F3). The
small-order module learns to recognize low-order KEM public keys, so
that leaf validation can refuse them in ticket 02. No library behavior
changes in this ticket; the helper is exercised only by its own unit
test.

Add an X25519 check and an X448 check beside the existing EdDSA ones,
following their shape. X25519: read the u coordinate little-endian,
mask the top bit of the last byte (RFC 7748 section 5), reduce mod p,
and compare against 0, 1, p - 1 and the two order-8 u values. X448:
reduce mod p and compare against 0, 1 and p - 1. A key of the wrong
length answers false (import decides that case). Add a dispatcher keyed
on the KEM algorithm that routes the two Montgomery KEMs to these
checks and answers false for the P-256, P-384 and P-521 KEMs, ML-KEM
and X-Wing, where the provider's import is the whole check.

**Blocked by:** None (can start immediately)

**Touches:** `src/crypto/small-order.ts` (new exports beside
`isSmallOrderEd25519` / `isSmallOrderEd448`), the KEM algorithm type
the dispatcher keys on (wherever `CiphersuiteImpl.hpke` names it), a
new unit test under `test/crypto/` registered in `test/unit.ts`

**Status:** done

- [x] Each listed X25519 low-order u value answers true, and so does
      its encoding with the top bit of the last byte set.
- [x] Each listed X25519 value plus p (the non-canonical encoding of
      the same point, where it fits in 255 bits) answers true.
- [x] Each listed X448 low-order value, and its non-canonical
      encoding plus p where it fits in 56 bytes, answers true.
- [x] A freshly generated X25519 public key and a freshly generated
      X448 public key answer false.
- [x] A key of the wrong length answers false for both curves.
- [x] The dispatcher answers false, for any input, for every NIST and
      post-quantum KEM the library defines.
- [x] `npm run typecheck` is clean and `npm run test:unit` passes.
