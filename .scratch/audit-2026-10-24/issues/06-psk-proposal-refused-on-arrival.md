# 06: Invalid PSK proposal refused on arrival

**What to build:** spec stories 5, 6 and 7 (F2). A PSK proposal whose
nonce length is wrong for the KDF is stored in the pending set today,
kept by the commit-time filter, and then makes every `createCommit`
and `createApplicationMessage` from that state throw. One signed
proposal from a peer or an authorized external sender stops the
recipient's commits and sends.

`validateProposalOnReceipt` gains an arm for PSK proposals that refuses
what depends only on the proposal and the current epoch: a nonce whose
length differs from the KDF output size, and a resumption PSK of
branch or ReInit usage when the group's epoch is not 0. The epoch rule
reuses `validatePskProposals` rather than restating it. The arm does
not consult the PSK index; availability stays a commit-time decision.
Proposal types without a receipt check, custom types in particular,
keep passing through. The refusal is a `ValidationError` thrown before
anything is stored. `createProposal` and `filterPendingProposals`
inherit the check by calling it, so no change is needed there.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`validateProposalOnReceipt`,
`validatePskProposals`), a new or extended suite under
`test/validation/` registered in `test/matrix.ts` and looping over
`sampleCiphersuites()`. Prior art:
`test/validation/proposal-validation.ts` (signing a proposal with
`protectProposalPublic`), `test/validation/psk-field-validation.ts`,
`test/scenario/psk-proposal-usage-policy.ts`,
`test/validation/pending-proposals.ts` (`listPendingProposals`).

Note: tickets 02 and 04 also edit `src/client-state.ts`, and 02 edits
`validateProposalOnReceipt`'s Add and Update arms, so expect a small
merge if they run in parallel.

**Status:** done

- [x] Alice's `processMessage` of a peer's PSK proposal with an empty
      nonce, under the default incoming-message policy, rejects with
      `ValidationError`; the pending set of the state she passed in is
      still empty, and from that state `createCommit` and
      `createApplicationMessage` both succeed.
- [x] The same holds for a wrong non-empty nonce length.
- [x] The same holds for a branch-usage and a ReInit-usage resumption
      PSK proposal at an epoch other than 0.
- [x] A well-formed external PSK proposal is still stored on receipt,
      and the existing external PSK commit scenario still passes.
- [x] `createProposal` with an empty-nonce PSK throws and leaves the
      pending set unchanged.
- [x] An invalid PSK proposal inserted directly with
      `addUnappliedProposal` (with `senderType`) is dropped by the next
      `createCommit`, which succeeds and leaves an empty pending set.
- [x] `npm run typecheck` and `npm test` pass.
