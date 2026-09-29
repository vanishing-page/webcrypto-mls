# 14: Peer inputs surface as the documented error types

**What to build:** audit findings L1 and L8, spec stories 20 and 27.
The error contract in AGENTS.md says that anything a peer can trigger
is a `ValidationError`, or a `CodecError` for undecodable bytes. These
sites break it:

- L1: a `ratchet_tree` extension whose node list is empty or ends in a
  blank node reaches the `extendRatchetTree` guard and throws
  `InternalError`, before the GroupInfo signature is even checked, in
  both `joinGroup` and `joinGroupExternal`. Make `decodeRatchetTree`
  return a decode failure for those lists, so the callers surface
  `CodecError`. This is the AGENTS.md rule for low-level guards
  reachable from the wire.
- L8, credentials: an unknown or GREASE (for example 0x0A0A) credential
  type makes the decoder table lookup return a non-function, and the
  TLS decoder throws `TypeError: decoderU is not a function`. Give the
  credential decoder a default arm that fails the decode.
- L8, PublicMessage: a PublicMessage carrying application content
  throws `UsageError` in `unprotectPublicMessage`. Make it a
  `ValidationError`.
- L8, key length: a wrong-length Ed25519 signature key (for example 31
  bytes) surfaces from the WebCrypto signature impl as a
  `DOMException` `DataError`. Length-check before import, or catch the
  import failure, and surface `ValidationError`.
- L8, HPKE: an AEAD failure inside HPKE open surfaces as `CryptoError`.
  Make it `CryptoVerificationError`, the same class as MAC and
  signature failures.

**Blocked by:** None (can start immediately)

**Touches:** `src/ratchet-tree.ts` (`decodeRatchetTree`,
`extendRatchetTree`), `src/group-info.ts` (`ratchetTreeFromExtension`),
`src/credential.ts` and `src/credential-type.ts` (the credential
decoder), `src/message-protection-public.ts`
(`unprotectPublicMessage`),
`src/crypto/implementation/default/make-webcrypto-signature-impl.ts`,
`src/crypto/implementation/hpke.ts` (`makeGenericHpke`),
`test/validation/ratchet-tree-validation.ts`, `test/scenario/grease.ts`,
`test/crypto/hpke.ts`, `CHANGELOG.md`

Note: in a browser run, anything a test prints has to avoid the tokens
`Failed`, `FAIL` and `Error:` (see Tests in AGENTS.md).

**Status:** done

- [x] `joinGroup` given a Welcome whose `ratchet_tree` extension is an
      empty list rejects with `CodecError`. So does one whose list ends
      in a blank node.
- [x] `joinGroupExternal` given a GroupInfo with the same malformed
      extensions rejects with `CodecError`.
- [x] A KeyPackage or leaf whose credential type is unknown or GREASE
      fails with `CodecError` (or `ValidationError` where the decode
      succeeds and validation refuses it), never `TypeError`.
- [x] A PublicMessage framed as application content is rejected by
      `processMessage` with `ValidationError`.
- [x] A leaf or KeyPackage with a 31-byte Ed25519 signature key is
      rejected with `ValidationError` under the default provider, never
      a `DOMException`.
- [x] An HPKE ciphertext with a flipped tag byte is rejected with
      `CryptoVerificationError` (for example a Welcome whose
      `encrypted_group_secrets` was tampered with).
