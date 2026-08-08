# ADR-001: Web Crypto as the default cryptographic backend

**Date:** 2026-07-25

## Context

This library implements MLS ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)),
a group key agreement and messaging protocol, and it is a fork of
[LukaJCB/ts-mls](https://github.com/LukaJCB/ts-mls).

The target runtime is the browser. MLS needs a signature scheme, a hash and
HMAC, an AEAD, a KDF, and an HPKE KEM. Every one of those can be satisfied
either by a pure-JavaScript library (the `@noble/*` family, which is what the
upstream project used) or by the platform's own
[Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
via `crypto.subtle`.

Choosing pure JS is the portable option: it runs anywhere JavaScript runs, and
it makes every primitive synchronous. But it ships the primitives in the
bundle, executes them in the JS engine, and forces raw key material to live in
reachable `Uint8Array`s. Web Crypto pushes the same work into the browser's
audited native implementation, keeps the bytes out of the bundle, and can hold
keys as `CryptoKey` handles.

Web Crypto is not free to adopt. Its whole surface is promise-based, so the
choice propagates through the entire protocol implementation rather than
staying in one module. `Ed25519` and `X25519` were also late additions to
`crypto.subtle` (the WICG Secure Curves work), so depending on them sets a
floor on which engines can run the library at all. And Web Crypto simply does
not cover the post-quantum ciphersuites MLS allows.

## Decision

Crypto access goes through a `CryptoProvider` interface
(`src/crypto/provider.ts`), which hands back a `CiphersuiteImpl` for a given
ciphersuite. Implementations of that interface are swappable; the library
ships two, a default provider and an all-`@noble` provider
(`src/crypto/implementation/default/` and `src/crypto/implementation/noble/`).

The default provider, paired with the default ciphersuite
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (RFC 9420's
mandatory-to-implement suite 0x0001), runs every primitive on Web Crypto:
Ed25519 signatures, SHA-256 hashing and HMAC, AES-128-GCM, HKDF-SHA256, and
DHKEM-X25519. The KDF and KEM come from `@hpke/core`, which itself dispatches
to `crypto.subtle` rather than to a JS implementation. The primitive-by-primitive
breakdown is maintained in the README, under
[Defaults](../../README.md#defaults); that table is the reference, and this ADR
does not restate it.

`@noble/curves`, `@noble/post-quantum`, `@hpke/ml-kem`, and
`@hpke/hybridkem-x-wing` are declared as optional peer dependencies, needed
only for ciphersuites outside the default -- other signature curves, ML-DSA,
ML-KEM, X-Wing. Using such a ciphersuite without installing its package raises
a `DependencyError` at runtime. See
[Optional Ciphersuite Dependencies](../../README.md#optional-ciphersuite-dependencies)
for the current mapping.

There is deliberately no pure-JS fallback on the default path. If the host's
Web Crypto lacks X25519 or Ed25519, `@hpke/core` throws rather than silently
degrading.

## Consequences

The default configuration ships no JS implementation of any primitive. The
bytes of a group message are encrypted by the browser's native crypto, which
is faster on large payloads and is code we are not responsible for auditing.
Bundle size drops accordingly, and the `@noble/*` packages become opt-in
rather than mandatory weight.

Every crypto call is asynchronous, and that is now load-bearing across the
codebase: key schedule derivation, commit creation, message protection, and
tree operations are all `async`. This is not a local detail that a future
change could hide behind a synchronous facade -- reverting it would mean
touching most of `src/`.

The library requires a runtime whose Web Crypto implements X25519 and Ed25519:
Node 19+, current Chrome, Safari, Firefox, Deno, Bun, and Cloudflare Workers.
Older engines cannot run the default path at all, and they fail loudly instead
of quietly falling back to slower code.

The "everything is Web Crypto" property holds for the defaults specifically,
not for the library in general. Selecting a different signature algorithm
routes signing to `@noble/curves` (see
`src/crypto/implementation/default/make-signature-impl.ts`), and the
post-quantum suites are pure JS by necessity. Anyone reasoning about the
security or performance characteristics of a deployment has to know which
ciphersuite is in use.

Because the seam is a `CryptoProvider` rather than direct `crypto.subtle`
calls, an environment without usable Web Crypto can still be served by passing
the `@noble` provider, and new backends (a hardware token, a WASM
implementation) can be added without changing protocol code.
