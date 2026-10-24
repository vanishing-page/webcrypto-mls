# 02: Unusable leaf encryption key refused at the committer and on receipt

**What to build:** spec stories 8 and 9 for the paths an honest client
drives (F3). A key package whose leaf encryption key does not import
under the ciphersuite's HPKE, or is a low-order X25519/X448 point, is
refused as a `ValidationError` before the leaf enters any tree. A
low-order init key is refused the same way. Today the committer, every
receiver and the joiner accept such a leaf, and the failure surfaces
later as a provider `CryptoError` on an unrelated path commit.

Common leaf validation checks the leaf's `hpkePublicKey`: first the
low-order check from ticket 01, keyed on the group context's
ciphersuite, then the import. An import failure from the provider is
caught and returned as a `ValidationError`; the provider's own error
must not escape. To do that, the common validator needs the HPKE
handle, so `validateLeafNodeUpdateOrCommit` and the key package leaf
validator take it and every caller passes it: Add receipt, Update
receipt, the Update loop in `applyTreeMutations`, the commit path leaf
in `processMessage` (which also covers an external commit's leaf), and
`validateRatchetTree` at join and at external join. The by-value Add a
committer validates reaches it through `validateKeyPackage`, which
keeps its init key import and adds the low-order check for the init
key.

This ticket wires every caller. Ticket 03 proves the dishonest-
committer paths with forged messages; don't build those here.

**Blocked by:** 01

**Touches:** `src/client-state.ts` (`validateLeafNodeCommon`,
`validateLeafNodeUpdateOrCommit`, `validateLeafNodeKeyPackage`,
`validateKeyPackage`, `validateRatchetTree`,
`validateProposalOnReceipt`, `applyTreeMutations`),
`src/process-messages.ts` (the commit path leaf call),
`src/create-commit.ts` (`joinGroupExternal`'s `validateRatchetTree`
call), `src/crypto/small-order.ts` (consumer only), a new scenario
suite under `test/validation/` registered in `test/matrix.ts`. Prior
art: `test/validation/small-order-signature-key.ts`,
`test/validation/add-key-uniqueness.ts`,
`test/validation/proposal-validation.ts`,
`test/validation/peer-input-errors.ts`.

Note: tickets 04 and 06 also edit `src/client-state.ts` (`joinGroup`
and `validateProposalOnReceipt` respectively), so expect a small merge
if they run in parallel.

**Status:** done

- [x] Alice's `createCommit` carrying by value an Add of a key package
      re-signed with a one-byte leaf encryption key rejects with
      `ValidationError`.
- [x] The same Add, signed as a proposal from a peer with
      `protectProposalPublic`, is refused by `processMessage` with
      `ValidationError`, and the pending set of the state passed in is
      unchanged.
- [x] Under an X25519 suite, a key package whose leaf key is `u = 0`,
      and one whose leaf key is the same point with the top bit set,
      are both refused on Add with `ValidationError`; under an X448
      suite, `u = 0` is refused the same way.
- [x] An Update proposal whose new leaf key is low-order is refused on
      receipt with `ValidationError`.
- [x] A key package whose init key is low-order is refused with
      `ValidationError`.
- [x] After each refusal, an honest Add of a normal key package from
      the same state succeeds, and the next path commit from every
      member succeeds.
- [x] The suite loops over `testCiphersuites()` and skips a suite
      whose KEM is not installed through `skipReason`; no case under
      any suite surfaces a `CryptoError`.
- [x] `npm run typecheck`, the Worker typecheck and `npm test` pass.
