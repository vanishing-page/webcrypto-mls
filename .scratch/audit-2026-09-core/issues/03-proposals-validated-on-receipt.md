# 03: Proposals that can never be committed are rejected on receipt

**What to build:** part of audit finding H3, spec story 7. Today
`processProposal` stores any proposal with a valid signature. The next
routine commit bundles it, and `applyProposals` then throws on it. The
result is a wedged group, where nobody can commit or send application
messages. After this ticket, a proposal that cannot be valid in the
current epoch is rejected with `ValidationError` before it is stored:

- a Remove naming a blank or out-of-range leaf
- an Add whose KeyPackage fails validation. `validateKeyPackage` now
  also requires the `initKey` to import under the group's ciphersuite,
  which closes the H1(5) path, where a malformed `initKey` made every
  committer's `createWelcome` throw.
- an ExternalInit from any sender (ExternalInit is only ever valid by
  value inside a `new_member_commit`)
- an Update whose leaf fails leaf validation

Apply the same checks to proposals the local client creates with
`createProposal`, so that it cannot store what a peer would refuse.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`processProposal`,
`validateKeyPackage`, `validateLeafNodeUpdateOrCommit`),
`src/process-messages.ts` (the proposal branch for public and private
messages), `src/create-message.ts` (`createProposal`),
`test/validation/proposal-validation.ts`, `CHANGELOG.md`

Note: tickets 02, 04, 05, 06 and 09 also edit proposal handling in
`client-state.ts`. Ticket 04 reuses the validation written here.

**Status:** done

- [x] A received Remove naming a blank leaf is rejected with
      `ValidationError`. The receiver's next `createCommit` and
      `createApplicationMessage` then succeed.
- [x] A received Remove naming a leaf index beyond the tree is rejected
      with `ValidationError`.
- [x] A received Add (from a member, an external sender, or a
      `new_member_proposal`) whose KeyPackage `initKey` does not import
      under the group's ciphersuite is rejected with `ValidationError`.
      The receiver's next path commit succeeds.
- [x] A received Add whose KeyPackage fails any other validation
      (signature, lifetime, ciphersuite) is rejected with
      `ValidationError`.
- [x] A received ExternalInit proposal is rejected with
      `ValidationError` whatever its sender type.
- [x] A received Update whose leaf fails leaf validation is rejected
      with `ValidationError`.
- [x] Valid proposals of every type are still accepted and can be
      committed by reference.
