# WebCrypto Ed25519 Signing Design

## Summary

MLS (Messaging Layer Security) group operations authenticate every
message with a signature. Today this library signs with raw private-key
bytes held in JS memory; this design instead lets Ed25519 signing run
through the browser's WebCrypto `crypto.subtle` API, so the private key
can live as a non-extractable `CryptoKey` whose bytes are never exposed
to JavaScript at all.

The approach introduces an opaque `SignatureSecretKey` type
(`CryptoKey | Uint8Array`) that flows through the `Signature` interface,
`PrivateKeyPackage`, and `ClientState`. A new WebCrypto-backed
implementation handles Ed25519 via `crypto.subtle`, while all other
ciphersuites keep using the existing `@noble/curves`-based path
unchanged -- runtime discrimination happens by checking whether the key
is a `Uint8Array` (the noble case) or not (the WebCrypto case), avoiding
cross-realm `instanceof CryptoKey` pitfalls. This mirrors an existing
pattern already used for HPKE keys in the codebase, so the signature
side of the library adopts a boundary that's already proven out
elsewhere. The change ships incrementally across seven phases -- widen
the interface, add the WebCrypto implementation, propagate the wider
type through MLS state, support bring-your-own keys, adapt RFC 9420 test
vectors, verify cross-implementation interop, then update docs -- and
lands as a breaking, major-version change because the public
`signaturePrivateKey` field's type widens.

## Definition of Done

DELIVERABLE: MLS Ed25519 signing uses WebCrypto `CryptoKey` objects (not
raw bytes), so a non-extractable identity key can create a group, commit,
and send messages without its private bytes ever existing in JS.

SUCCESS CRITERIA:
- The default provider signs Ed25519 via `crypto.subtle`; non-Ed25519
  suites keep working via noble (hybrid).
- `generateKeyPackage` accepts an optional pre-existing signature
  `CryptoKeyPair` (including a non-extractable private key); when omitted
  it generates one. Self-generated Ed25519 identities are always
  non-extractable; a caller wanting an extractable/persistable identity
  supplies their own `CryptoKeyPair`.
- Signatures interop across WebCrypto and noble clients in one group;
  existing RFC 9420 test vectors still pass (raw seeds imported to
  `CryptoKey`).
- `signaturePrivateKey` on `PrivateKeyPackage` and `ClientState` becomes
  `CryptoKey | Uint8Array` (breaking change, major version bump). The
  public key stays raw bytes on the wire.

OUT OF SCOPE:
- ECDSA / Ed448 / ML-DSA signing via WebCrypto (those suites remain on
  the noble raw-bytes path).
- `ClientState` persistence helpers. Documented as an app concern, noting
  that a non-extractable `CryptoKey` is structured-cloneable
  (IndexedDB-storable) but not JSON-serializable.
- The README documentation update (follows once the API lands).

## Acceptance Criteria

### webcrypto-signing.AC1: Ed25519 signs via WebCrypto in the default provider
- **webcrypto-signing.AC1.1 Success:** Default provider `keygen()` for an
  Ed25519 ciphersuite returns a `signKey` that is a `CryptoKey` and a
  `publicKey` of 32 raw bytes.
- **webcrypto-signing.AC1.2 Success:** Sign then verify through the
  WebCrypto Ed25519 impl round-trips: a valid signature verifies true, and
  a tampered message verifies false.
- **webcrypto-signing.AC1.3 Success (hybrid):** Default provider `keygen()`
  for a non-Ed25519 ciphersuite (e.g. P256) returns a `signKey` that is a
  `Uint8Array` -- the noble path is unaffected.

### webcrypto-signing.AC2: Bring-your-own signature key
- **webcrypto-signing.AC2.1 Success:** Passing a non-extractable Ed25519
  `CryptoKeyPair` to `generateKeyPackage` yields
  `privatePackage.signaturePrivateKey` identical to the supplied
  non-extractable private `CryptoKey`.
- **webcrypto-signing.AC2.2 Success:** The resulting
  `publicPackage.leafNode.signaturePublicKey` equals the raw export of the
  supplied public key.
- **webcrypto-signing.AC2.3 Failure:** Supplying `signatureKeyPair` for a
  non-Ed25519 ciphersuite throws a clear, typed error.
- **webcrypto-signing.AC2.4 Success:** The README "pre-existing keypairs"
  example, using the new option, runs to completion.

### webcrypto-signing.AC3: Cross-implementation interop
- **webcrypto-signing.AC3.1 Success:** A signature produced by the
  WebCrypto Ed25519 impl verifies via `makeNobleSignatureImpl('Ed25519')`.
- **webcrypto-signing.AC3.2 Success:** A signature produced by the noble
  Ed25519 impl verifies via the WebCrypto Ed25519 impl.
- **webcrypto-signing.AC3.3 Success:** An end-to-end group in which one
  member's identity is a non-extractable `CryptoKey` (default provider) and
  another member uses the noble provider exchanges an application message
  that each member verifies.

### webcrypto-signing.AC4: No regression / test vectors
- **webcrypto-signing.AC4.1 Success:** The pre-existing test suite passes
  unchanged after the Phase 1 interface widening (noble `importSignatureKey`
  is identity).
- **webcrypto-signing.AC4.2 Success:** RFC 9420 `crypto-basics`
  (`sign_with_label`) and `message-protection` vectors pass with Ed25519
  routed through `importSignatureKey` (PKCS8 import).

### webcrypto-signing.AC5: Non-extractable security posture
- **webcrypto-signing.AC5.1 Success:** A self-generated Ed25519 identity's
  private `CryptoKey` reports `extractable === false`.
- **webcrypto-signing.AC5.2 Success:** A non-extractable Ed25519 identity
  completes `createGroup` -> `createCommit` (add member) ->
  `createApplicationMessage`, and the joiner verifies -- with no step
  exporting the private key.

## Glossary

- **WebCrypto**: The browser/Node standard API (`crypto.subtle`) for
  performing cryptographic operations, often backed by native or
  hardware-isolated implementations rather than pure JavaScript.
- **`CryptoKey`**: An opaque WebCrypto object representing a
  cryptographic key. Its raw bytes are not directly readable by
  JavaScript; if generated as non-extractable, they can never be
  exported at all.
- **Non-extractable key**: A `CryptoKey` created with
  `extractable:false`, meaning the underlying key material can be used
  for operations like signing but can never be exported out of the
  WebCrypto boundary -- a stronger security posture than raw bytes held
  in JS variables.
- **`CryptoKeyPair`**: A WebCrypto object bundling a public and private
  `CryptoKey` together, as returned by `crypto.subtle.generateKey` for
  asymmetric algorithms.
- **Ed25519**: An elliptic-curve signature algorithm (EdDSA over
  Curve25519) used as one of the signature ciphersuites in MLS.
- **noble / `@noble/curves`**: A pure-JavaScript cryptography library
  used as this project's non-WebCrypto signing backend; it works in any
  JS environment but keeps private key bytes in memory as `Uint8Array`.
- **MLS (Messaging Layer Security)**: The IETF protocol (RFC 9420) this
  library implements for scalable end-to-end encrypted group messaging.
- **Ciphersuite**: An MLS-defined bundle of cryptographic algorithms
  (signature scheme, hash, HPKE KEM/KDF/AEAD) that a group agrees to use
  together.
- **HPKE (Hybrid Public Key Encryption)**: The public-key encryption
  scheme MLS uses for key exchange; referenced here as the existing
  precedent for bridging `CryptoKey` and raw-byte handling.
- **`KeyPackage`**: An MLS structure a client publishes so others can
  add it to a group; it bundles the client's public keys and
  capabilities.
- **`LeafNode`**: The per-member structure inside an MLS group's ratchet
  tree, containing (among other things) the member's public signature
  key.
- **`ClientState`**: This library's in-memory representation of a
  client's view of an MLS group, including the private keys it needs to
  participate.
- **`signWithLabel` / `verifyWithLabel`**: MLS's convention of signing
  over a label plus content (rather than raw content) to
  domain-separate signatures used for different purposes within the
  protocol.
- **PKCS8**: A standard binary format for encoding private keys; used
  here because WebCrypto does not accept raw-byte import for Ed25519
  private keys, so a raw 32-byte seed must be wrapped in a fixed PKCS8
  header before import.
- **RFC 8410**: The IETF spec defining how Ed25519 (and X25519) keys are
  encoded in ASN.1/PKCS8, which supplies the fixed prefix bytes used to
  wrap raw seeds for WebCrypto import.
- **RFC 9420**: The IETF spec for the MLS protocol itself; also the
  source of the official test vectors this library validates against.
- **Test vectors**: Official known-input/known-output test data
  published alongside RFC 9420, used to confirm an implementation
  produces protocol-correct results.
- **ZIP215**: A stricter-than-original but still permissive set of
  rules for validating Ed25519 signatures on edge-case (non-canonical)
  keys; `@noble/curves` follows it, while WebCrypto follows the
  stricter original RFC 8032 rules, a divergence that only matters for
  maliciously crafted keys.
- **Structured clone**: The browser/Node algorithm used by APIs like
  `postMessage` and IndexedDB to copy complex objects (including
  non-extractable `CryptoKey`s) without serializing them to
  JSON/strings.
- **Hybrid provider / selector**: This design's term for the default
  crypto provider routing Ed25519 through WebCrypto while routing every
  other ciphersuite through the existing noble implementation, based on
  the requested algorithm.

## Architecture

The signing key becomes an opaque handle that holds either a WebCrypto
`CryptoKey` (Ed25519) or raw seed bytes (all other suites):

```ts
// src/crypto/signature.ts
// Opaque: callers never inspect the internals.
export type SignatureSecretKey = CryptoKey | Uint8Array
```

The `Signature` interface widens its private-key parameter and gains one
import method. The public-key side is untouched -- it stays raw bytes
because it is serialized on the wire (inside `LeafNode` / `KeyPackage` /
the ratchet tree) and `verify` receives it from the wire:

```ts
export interface Signature {
    sign(signKey:SignatureSecretKey, message:Uint8Array):Promise<Uint8Array>
    verify(
        publicKey:Uint8Array,
        message:Uint8Array,
        signature:Uint8Array
    ):Promise<boolean>
    keygen():Promise<{ publicKey:Uint8Array; signKey:SignatureSecretKey }>
    // Wrap a raw seed into whatever this impl's sign expects.
    // Ed25519 -> imports bytes to a CryptoKey (via PKCS8, extractable:false).
    // noble suites -> returns the bytes unchanged (identity).
    importSignatureKey(seed:Uint8Array):Promise<SignatureSecretKey>
}
```

Discrimination lives inside `sign`: `signKey instanceof Uint8Array` selects
the noble path, otherwise the WebCrypto path. Branching on `Uint8Array`
(not `CryptoKey`) sidesteps the cross-realm `instanceof CryptoKey` caveat
(worker/iframe realms have distinct `CryptoKey` constructors).

The default provider (`src/crypto/implementation/default/provider.ts`)
selects the implementation per algorithm via a new
`makeSignatureImpl(alg)`: WebCrypto for `'Ed25519'`, the existing
`makeNobleSignatureImpl(alg)` for every other algorithm. The **noble
provider** (`src/crypto/implementation/noble/provider.ts`) is unchanged --
it remains a fully raw-bytes escape hatch with no WebCrypto dependency. So
"change the default" is scoped precisely to the default provider's Ed25519
path.

The new WebCrypto Ed25519 impl
(`src/crypto/implementation/default/make-webcrypto-signature-impl.ts`)
implements the four methods against `crypto.subtle`:

- `keygen()` -> `generateKey({name:'Ed25519'}, false, ['sign','verify'])`
  (non-extractable private key), then `exportKey('raw', publicKey)` for the
  wire bytes. The `extractable:false` flag governs only the private key;
  the public key is always exportable.
- `sign(signKey, msg)` -> `subtle.sign({name:'Ed25519'}, signKey, msg)`.
- `verify(pub, msg, sig)` -> `importKey('raw', pub, ..., ['verify'])` then
  `subtle.verify`.
- `importSignatureKey(seed)` -> wrap the 32-byte seed in the fixed RFC 8410
  PKCS8 prefix, then `importKey('pkcs8', ..., ['sign'])` with
  `extractable:false`. WebCrypto rejects `'raw'` for Ed25519 private keys,
  so PKCS8 is the import path.

`makeNobleSignatureImpl` gains an `importSignatureKey` that returns the
seed unchanged, so the interface is total across all algorithms.

At the MLS layer the private-key type widens in the two state-bearing
types, and `generateKeyPackage` gains an options argument for
bring-your-own-key:

```ts
// src/key-package.ts
export interface PrivateKeyPackage {
    initPrivateKey:Uint8Array
    hpkePrivateKey:Uint8Array
    signaturePrivateKey:SignatureSecretKey   // was Uint8Array
}

export async function generateKeyPackage(
    credential:Credential,
    capabilities:Capabilities,
    lifetime:Lifetime,
    extensions:Extension[],
    cs:CiphersuiteImpl,
    options?:{ signatureKeyPair?:CryptoKeyPair }
):Promise<{ publicPackage:KeyPackage; privatePackage:PrivateKeyPackage }>

// src/client-state.ts
export interface ClientState {
    // ...
    signaturePrivateKey:SignatureSecretKey    // was Uint8Array
}
```

When `signatureKeyPair` is supplied, `generateKeyPackage` exports its
public half to raw bytes for `leafNode.signaturePublicKey` and stores its
`privateKey` (`CryptoKey`, possibly non-extractable) as
`signaturePrivateKey`, skipping the internal `keygen()`. Supplying a
`signatureKeyPair` for a non-Ed25519 suite throws a clear error.

Every signing call site (`create-message.ts`, `create-commit.ts`,
`update-path.ts`, `leaf-node.ts`, `external-proposal.ts`, and the
commit-path leaf rotation) already forwards `signaturePrivateKey` into
`signWithLabel`. Because discrimination lives inside `Signature.sign`,
those sites need no logic change -- only the parameter type propagates
(`Uint8Array` -> `SignatureSecretKey`).

## Existing Patterns

Investigation confirmed this design follows the existing HPKE pattern in
`src/crypto/hpke.ts`, which already bridges `CryptoKey` and bytes. HPKE
defines branded opaque handles (`type PublicKey = CryptoKey & {type}`) and
puts import/export on the `Hpke` interface
(`importPrivateKey`/`exportPrivateKey`/`importPublicKey`/`exportPublicKey`,
implemented in `src/crypto/implementation/hpke.ts` via `@hpke/core`
serialize/deserialize). Placing `importSignatureKey` on the `Signature`
interface and using an opaque `CryptoKey | Uint8Array` handle mirrors that
established boundary rather than introducing a new one.

The two-provider layout (`implementation/default` = WebCrypto-leaning,
`implementation/noble` = pure JS) is the existing seam for "same interface,
different crypto backing." This design extends only the default provider's
signature selection and leaves the noble provider intact, consistent with
how the default provider already uses `crypto.subtle` for hashing while
noble does not.

The `Signature` interface is already fully async (`Promise` returns), so
mixing async WebCrypto with synchronous noble signing requires no interface
change.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Signature interface + noble conformance
**Goal:** Introduce the opaque key handle and the import method without
changing any behavior.

**Components:**
- `SignatureSecretKey` type and updated `Signature` interface in
  `src/crypto/signature.ts` (add `importSignatureKey`; widen `sign` and
  `keygen` key types).
- `signWithLabel` signature-key parameter widened to `SignatureSecretKey`
  in the same file (`verifyWithLabel` unchanged).
- `makeNobleSignatureImpl` in
  `src/crypto/implementation/default/make-noble-signature-impl.ts` gains
  `importSignatureKey` as an identity function for every algorithm.

**Dependencies:** None (first phase).

**Done when:** The project builds and the existing test suite passes
unchanged (noble path is behaviorally identical; `importSignatureKey` is
identity). Covers `webcrypto-signing.AC4.1`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: WebCrypto Ed25519 implementation + hybrid selector
**Goal:** Ed25519 signing runs through `crypto.subtle` in the default
provider.

**Components:**
- WebCrypto Ed25519 `Signature` impl in
  `src/crypto/implementation/default/make-webcrypto-signature-impl.ts`
  (non-extractable keygen, sign, verify, PKCS8 `importSignatureKey`, raw
  public-key export). Includes the fixed RFC 8410 PKCS8 prefix constant.
- `makeSignatureImpl(alg)` hybrid selector (WebCrypto for `'Ed25519'`,
  noble otherwise), wired into
  `src/crypto/implementation/default/provider.ts`.

**Dependencies:** Phase 1.

**Done when:** A unit test in `test/crypto/signature.ts` shows the default
provider's Ed25519 `keygen` returns a non-extractable `CryptoKey` signKey
and raw public bytes, and sign/verify round-trip; a non-Ed25519 suite
still returns a `Uint8Array` signKey. Covers `webcrypto-signing.AC1.1`,
`webcrypto-signing.AC1.2`, `webcrypto-signing.AC1.3`,
`webcrypto-signing.AC5.1`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Propagate SignatureSecretKey through MLS state
**Goal:** The widened key type flows through key packages and client state.

**Components:**
- `PrivateKeyPackage.signaturePrivateKey` and
  `ClientState.signaturePrivateKey` retyped to `SignatureSecretKey`
  (`src/key-package.ts`, `src/client-state.ts`).
- Type propagation through all signing call sites: `src/create-message.ts`,
  `src/create-commit.ts`, `src/update-path.ts`, `src/leaf-node.ts`,
  `src/external-proposal.ts`, `src/resumption.ts` (no logic change --
  discrimination is inside `Signature.sign`).

**Dependencies:** Phase 2.

**Done when:** The project type-checks and builds with the widened types,
and an end-to-end Ed25519 group flow (createGroup -> createCommit ->
application message) passes using the default provider -- a self-generated
non-extractable Ed25519 identity, with no step exporting the private key.
Covers `webcrypto-signing.AC5.2`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Bring-your-own-key on generateKeyPackage
**Goal:** A caller can supply a pre-existing (non-extractable)
`CryptoKeyPair` as the signature identity.

**Components:**
- Optional `options?:{ signatureKeyPair?:CryptoKeyPair }` argument on
  `generateKeyPackage` in `src/key-package.ts`: export the public half to
  raw bytes, store the private `CryptoKey`, skip internal keygen; throw a
  clear error when a `signatureKeyPair` is given for a non-Ed25519 suite.
- Export any new option/type from `src/index.ts` as needed.

**Dependencies:** Phase 3.

**Done when:** A test creates a non-extractable Ed25519 `CryptoKeyPair`,
passes it to `generateKeyPackage`, and asserts the resulting
`signaturePrivateKey` is that non-extractable `CryptoKey` and its public
key matches the leaf node. Covers `webcrypto-signing.AC2.1`,
`webcrypto-signing.AC2.2`, `webcrypto-signing.AC2.3`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Adapt RFC 9420 test vectors
**Goal:** Existing known-answer vectors pass through the new import path.

**Components:**
- `test/test-vectors/crypto-basics.ts` and
  `test/test-vectors/message-protection.ts`: route raw private-key seeds
  through `impl.signature.importSignatureKey(seed)` before signing.

**Dependencies:** Phase 2 (import path exists).

**Done when:** The RFC 9420 crypto-basics and message-protection vector
tests pass with Ed25519 driven through `importSignatureKey` (PKCS8 import),
proving byte-sourced keys still produce correct signatures. Covers
`webcrypto-signing.AC4.2`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Cross-implementation interop + non-extractable end-to-end tests
**Goal:** Prove WebCrypto and noble clients interoperate, and that a
non-extractable identity fully participates in a group.

**Components:**
- Interop test: sign with the WebCrypto Ed25519 impl, verify with
  `makeNobleSignatureImpl('Ed25519')`, and the reverse direction.
- End-to-end mixed-provider test: one member whose identity is a
  non-extractable `CryptoKeyPair` on the default (WebCrypto) provider runs
  `generateKeyPackage` (BYO) -> `createGroup` -> `createCommit` (adds a
  second member) -> `createApplicationMessage`; the second member uses the
  noble provider, joins from the welcome, and decrypts/verifies. Messages
  each member sends verify for the other.

**Dependencies:** Phases 4 and 5.

**Done when:** Both interop directions verify true and the end-to-end
non-extractable-identity group test passes. Covers
`webcrypto-signing.AC3.1`, `webcrypto-signing.AC3.2`,
`webcrypto-signing.AC3.3`.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: README update
**Goal:** Document the first-class API and remove the workaround.

**Components:**
- `README.md` "Use with pre-existing keypairs" section rewritten to use the
  `generateKeyPackage` `signatureKeyPair` option; remove the
  `signature.keygen` override workaround and the raw-seed extraction.

**Dependencies:** Phase 4 (API exists).

**Done when:** The README example uses the new option and the documented
snippet runs successfully (verified as in the earlier feasibility spike).
Covers `webcrypto-signing.AC2.4`.
<!-- END_PHASE_7 -->

## Additional Considerations

**Runtime support / secure context.** The default provider's Ed25519 path
depends on `crypto.subtle` Ed25519, which requires a secure context in
browsers and reaches back to Chrome 137, Firefox 129, Safari 17, and Node
18.4. On an unsupported engine or non-secure context, `keygen`/`sign`
reject. The unchanged noble provider remains a full fallback for those
environments.

**ZIP215 vs strict verification.** `@noble/curves` verifies Ed25519 with
ZIP215 (looser) rules by default, while WebCrypto uses strict RFC 8032.
This diverges only for maliciously crafted edge-case keys, not for
normally generated ones, so mixed-client verification of honest signatures
is unaffected. Noted for awareness; no action required.

**Persistence.** After this change, an Ed25519 `signaturePrivateKey` is a
non-extractable `CryptoKey`: structured-cloneable (storable in IndexedDB)
but not JSON-serializable. The library does not persist `ClientState`
(confirmed by investigation), so this is an application concern; it will be
documented, not solved here.

**Breaking change.** Widening `signaturePrivateKey` from `Uint8Array` to
`CryptoKey | Uint8Array` on `PrivateKeyPackage` and `ClientState` is a
public-type breaking change warranting a major version bump.
