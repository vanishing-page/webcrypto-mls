# 09: Update proposals carry a `LeafNodePatch`

**What to build:** spec story 8, proposal half. Bob rotates his
credential, his signature key or his capabilities through an Update
proposal that another member commits, without leaving the group.

`createUpdateProposal` takes an optional `LeafNodePatch` (ticket 07).
The new leaf is validated by bob's own `AuthenticationService` with
his old credential as `priorCredential` before signing, as a peer will
validate it. If the patch rotates the signature key, the new signature
private key is held beside the pending HPKE key under the same
proposal reference and follows the same rules (ticket 08): installed
into bob's identity when a commit applies the Update, dropped and
listed in `consumed` otherwise. Until then bob keeps signing with the
old key, because the tree still holds his old leaf. The proposal
itself is signed with the key in the tree at the time it is sent.

**Blocked by:** 07, 08

**Touches:** `src/create-message.ts` (or wherever ticket 08 put
`createUpdateProposal`), `src/client-state.ts` (the pending-key
record), `src/process-messages.ts`, the scenario suite from ticket 08,
the lifecycle test from ticket 06,
`test/validation/encryption-secret-retention.ts`. Prior art:
`test/validation/credential-continuity.ts`.

**Status:** done

- [x] Bob proposes an Update rotating his signature key and
      credential, alice commits it, and every member accepts it; a
      message bob then sends verifies at alice and charlie.
- [x] Alice's `AuthenticationService` is shown bob's new credential
      with his old one as `priorCredential`.
- [x] A message bob sends after proposing and before the commit
      verifies at alice.
- [x] A commit that leaves bob's patched Update out leaves bob signing
      with his old key and working, and the pending signature key, if
      held as bytes, is in `consumed`.
- [x] A patch bob's own `AuthenticationService` refuses makes
      `createUpdateProposal` reject, and the state passed in is
      unchanged.
- [x] Bob widens his capabilities through an Update, and a later
      GroupContextExtensions commit requiring the new capability
      succeeds.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.
