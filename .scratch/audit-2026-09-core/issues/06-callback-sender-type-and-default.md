# 06: Callback sees the sender type; default rejects new member proposals

**What to build:** part of audit finding H3, spec stories 11 and 12.
A `new_member_proposal` is authenticated only by its own KeyPackage
signature, and its TBS carries no GroupContext. Anyone who knows a
group's id and epoch (both cleartext) can send one. Today the
incoming-message callback gets only `senderLeafIndex`, so it cannot
tell such a proposal from an external sender's. Under the default
`acceptAll`, the next routine commit silently adds the outsider, who
then receives a Welcome.

After this ticket:
- `ProposalWithSender` carries the sender type (`member`, `external`,
  `new_member_proposal`, `new_member_commit`) alongside the leaf
  index, both for the `proposal` input and for each entry of the
  `commit` input. This is an additive change to the callback's input.
  The pending-proposal listing from ticket 05 picks it up for free.
- The default callback that `processMessage` uses when none is passed
  rejects a `new_member_proposal` and accepts everything else.
- `acceptAll` stays exported and keeps its literal meaning, for
  applications that deliberately allow open self-add.
- The README states which default applies and why, and the CHANGELOG
  records the behaviour change.

Existing tests that rely on a `new_member_proposal` being accepted
under the default need to pass `acceptAll` explicitly. Check
`test/scenario/external-add-proposal.ts` and the demos'
`processMessage` calls.

**Blocked by:** None (can start immediately)

**Touches:** `src/incoming-message-action.ts` (`acceptAll`, the new
default, `IncomingMessageCallback`), `src/unapplied-proposals.ts`
(`ProposalWithSender`, `addUnappliedProposal`),
`src/process-messages.ts` (`processMessage` default argument, the
`onMessage` calls for proposals and commits), `src/client-state.ts`
(`processProposal`), `src/create-message.ts`, `src/index.ts`,
`test/scenario/external-add-proposal.ts`,
`test/scenario/reject-incoming-message.ts`, `README.md`, `CHANGELOG.md`

Note: tickets 02, 03 and 05 also edit `unapplied-proposals.ts` and
`processProposal`.

**Status:** done

- [x] The callback receives sender type `member` for a member's
      proposal, `external` for an external sender's, and
      `new_member_proposal` for a self-signed Add.
- [x] The callback's `commit` input reports each proposal's sender
      type.
- [x] With no callback passed, a received `new_member_proposal` is
      rejected and does not enter the pending set. The next
      `createCommit` adds nobody, and no Welcome is produced.
- [x] With no callback passed, member and external-sender proposals
      are still accepted.
- [x] With `acceptAll` passed, a `new_member_proposal` is accepted, and
      the next commit adds the proposer.
