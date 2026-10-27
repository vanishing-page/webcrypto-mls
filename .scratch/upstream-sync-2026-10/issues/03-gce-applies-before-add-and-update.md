# 03: Required capabilities are checked after the GCE proposal

**What to build:** spec stories 1 and 3. A commit that carries a
GroupContextExtensions proposal changing `required_capabilities`
together with an Add is accepted by the committer and every receiver
when the added leaf satisfies the *new* requirement, as RFC 9420
applies the GroupContextExtensions proposal first. Today the Add is
checked against the old requirement, the receiver throws, and it is
stranded in the old epoch.

In `applyProposals`, compute the post-GroupContextExtensions group
context once, before the tree mutations, and run the Update and Add
validation in `applyTreeMutations` against it. The receive path
already builds this context for the committer's own leaf; the sender
path and the receive path must use one derivation, not two.
Validation still runs against the running tree (see AGENTS.md). An
empty GroupContextExtensions proposal still clears the extensions.
Read upstream `bc9ce9e` for intent only.

This ticket covers proposals carried by value. A by-reference Add or
any Update reaches the receipt check first, which still refuses it
until ticket 04; those variants are ticket 04's.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`applyProposals`,
`applyTreeMutations`), `src/process-messages.ts` (the committer-leaf
context it already derives), `src/create-commit.ts` (sender path), a
new scenario suite registered in `test/matrix.ts`. Prior art:
`test/scenario/gce-committer-leaf-validation.ts`,
`test/scenario/required-capabilites.ts`,
`test/scenario/gce-empty-extensions.ts`.

Note: tickets 04, 06, 07, 08 and 13 also edit these files; expect a
small merge if they run in parallel.

**Status:** done

- [x] A group requiring extension A, where every member supports A and
      B: alice commits, by value, a GroupContextExtensions proposal
      requiring B and an Add of charlie, who supports B only. Alice's
      `createCommit` succeeds, every member's `processMessage` accepts
      the commit, charlie joins from the Welcome, and all three reach
      the same epoch and exchange messages.
- [x] A GroupContextExtensions proposal that removes
      `required_capabilities` together with an Add of a member who
      does not support A is accepted by everyone the same way.
- [x] A GroupContextExtensions proposal requiring B together with an
      Add of a member who supports A only is refused by the committer
      with `ValidationError`, and the state passed in is unchanged.
- [x] The existing required-capabilities and
      GroupContextExtensions suites pass unchanged.
- [x] The suite uses `sampleCiphersuites()` and `testClientConfig`.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.
