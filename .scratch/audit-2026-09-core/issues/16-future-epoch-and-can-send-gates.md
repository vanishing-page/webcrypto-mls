# 16: Refuse future-epoch PrivateMessages and gate `createProposal`

**What to build:** audit findings L6 and L9, spec stories 25 and 28.

- L6: `processMessage` checks only `pm.epoch < state.groupContext.epoch`
  for a PrivateMessage. The private proposal branch has no epoch
  equality check, unlike the public path. A member can therefore get
  an application message labelled epoch 3, or a proposal labelled
  epoch 7, accepted at epoch 2. Reject a PrivateMessage whose epoch is
  greater than the current epoch with `ValidationError` before
  unprotecting it.
- L9: `createProposal` never calls `checkCanSendHandshakeMessages`, so
  a removed or suspended client still emits proposals. Run the same
  gate the other handshake constructors run.

**Blocked by:** None (can start immediately)

**Touches:** `src/process-messages.ts` (`processMessage`, the
PrivateMessage epoch check), `src/create-message.ts`
(`createProposal`), `src/client-state.ts`
(`checkCanSendHandshakeMessages`),
`test/scenario/proposal-epoch-mismatch.ts`,
`test/scenario/epoch-out-of-order.ts`,
`test/validation/removed-from-group.ts`

**Status:** done

- [x] A PrivateMessage application message whose epoch field is one
      greater than the receiver's is rejected with `ValidationError`,
      and the receiver's ratchet is not advanced (the honest next
      message still decrypts).
- [x] A PrivateMessage proposal labelled with a future epoch is
      rejected with `ValidationError` and does not enter the pending
      set.
- [x] Past-epoch messages within retention are still processed as
      today.
- [x] `createProposal` from a client that has processed its own
      removal rejects with the same error class `createCommit` uses in
      that state.
- [x] `createProposal` from a suspended client (pending ReInit) rejects
      the same way.
