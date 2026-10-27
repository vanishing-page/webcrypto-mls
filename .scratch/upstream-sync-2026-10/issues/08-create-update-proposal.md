# 08: `createUpdateProposal` keeps its new HPKE key

**What to build:** spec story 7. Bob proposes an Update for his own
leaf with a new exported `createUpdateProposal`, alice commits it, and
bob processes alice's commit and keeps exchanging messages. Today no
API keeps the new HPKE private key, so bob cannot decrypt the path
secret encrypted to it.

`createUpdateProposal` builds and signs an Update with a fresh HPKE
key pair, runs it through `validateProposalOnReceipt` before signing
as `createProposal` does, and returns the new state, the message and
`consumed`. The new HPKE private key is held in the new state, keyed
by the proposal reference. That record is keyed by a peer-visible
string, so it is read through `Object.hasOwn` and keeps an ordinary
prototype (see AGENTS.md). When bob processes a commit that applies
his proposal, the pending key is installed into his private key path
before path decryption, and every other pending Update key of the
epoch is dropped. When the epoch advances without it, the pending
keys are dropped. Dropped keys go to the garbage collector untouched
and appear in `consumed`.

The spec says a proposer that commits its own pending Update installs
the keys the same way. RFC 9420 12.2 forbids a commit from including
the committer's own Update, and `filterPendingProposals` already drops
it. Keep that: when bob commits, his own pending Update is left out,
his pending keys are dropped and listed in `consumed`, and his
UpdatePath rotates his leaf instead.

A pending key is a new kind of secret in `ClientState`.
`test/validation/encryption-secret-retention.ts` must feed it to
`createSecretTree` like every other KDF-sized buffer, and
`test/validation/prior-state-reuse.ts` must cover a retained state
that held one. Read upstream `361e756` and `9a7b8c6` for intent only.

This ticket takes no `LeafNodePatch`; ticket 09 adds it.

**Blocked by:** 06

**Touches:** `src/create-message.ts` (or a sibling module),
`src/client-state.ts` (`ClientState`, the pending-key record),
`src/process-messages.ts` (installing before path decryption),
`src/create-commit.ts` (dropping on the committer's own commit),
`src/private-key-path.ts`, `src/index.ts`,
`test/validation/encryption-secret-retention.ts`,
`test/validation/prior-state-reuse.ts`, the lifecycle test from ticket
06, a scenario suite registered in `test/matrix.ts`. Prior art:
`test/scenario/update.ts`, `src/unapplied-proposals.ts`.

Note: tickets 03, 04, 07 and 13 also edit these files.

**Status:** done

- [x] Bob proposes with `createUpdateProposal`, alice commits it, bob
      processes alice's commit, and bob and alice exchange messages in
      the new epoch.
- [x] The same works when bob is at leaf index 0.
- [x] A commit from alice that does not include bob's Update leaves
      bob able to process it and keep messaging, and the pending key
      is in that result's `consumed` and unreachable from bob's new
      state.
- [x] Bob committing while his own Update is pending succeeds, the
      commit does not include the Update, every member processes it,
      and the pending key is in `consumed`.
- [x] An Update `validateProposalOnReceipt` would refuse makes
      `createUpdateProposal` reject, and the state passed in is
      unchanged.
- [x] The ticket 06 lifecycle test includes `createUpdateProposal` and
      its rules hold.
- [x] `encryption-secret-retention.ts` and `prior-state-reuse.ts` cover
      a pending Update key and pass.
- [x] `createUpdateProposal` is exported from the package root.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.
