# 05: Applications can list, discard, and cap pending proposals

**What to build:** part of audit finding H3, spec stories 9 and 10.
Today nothing in the library removes a pending proposal except a
commit, and application messages are refused while any is pending. A
group with one stuck proposal therefore has to hand-edit
`state.unappliedProposals`. The pending set is also unbounded: 1000
outsider proposals were accepted in under 9 seconds.

Add two pure functions over `ClientState`, exported from
`src/index.ts`:
- one lists the pending proposals, each with its reference, the
  proposal, and its sender (whatever `ProposalWithSender` carries; once
  ticket 06 lands that includes the sender type)
- one returns a new state without a given proposal, identified by
  reference. The input state is left unchanged, following the
  functional-state model.

Add a `ClientConfig` field that caps the pending set, with a
documented default. A proposal that arrives while the set is at the
cap is rejected with `ValidationError`, and nothing already pending is
evicted, so a flood cannot push out an honest proposal. The cap check
uses an explicit `if (max <= 0)` branch, following the
retention-trimming rule in AGENTS.md, so that a cap of 0 means "accept
none", not "unlimited".

Pending proposals still block application messages (RFC behaviour).
The discard function is what unblocks a wedged group. Document both
functions and the config field in the README and add CHANGELOG entries.

**Blocked by:** 02 (the pending set's keying)

**Touches:** `src/unapplied-proposals.ts`, `src/client-state.ts`
(`processProposal`), `src/create-message.ts` (`createProposal`),
`src/client-config.ts` (`ClientConfig`, `defaultClientConfig`),
`src/index.ts`, `test/helpers/client-config.ts` if a test needs a small
cap, a new file under `test/validation/` imported from `test/unit.ts`,
`README.md`, `CHANGELOG.md`

**Status:** done

- [x] After receiving a proposal, a member lists exactly one pending
      proposal, whose reference and sender match what was sent.
- [x] A member with a pending proposal cannot send an application
      message. After discarding that proposal it can, and the peer
      decrypts the message.
- [x] Discarding returns a new state, and the input state still lists
      the proposal.
- [x] Discarding an unknown reference leaves the pending set unchanged.
- [x] With the cap set to N, the (N+1)th received proposal is rejected
      with `ValidationError`, and the first N are all still listed.
- [x] With the cap set to 0, the first received proposal is rejected
      with `ValidationError`.
- [x] Under the default config, a routine number of proposals is
      accepted.
