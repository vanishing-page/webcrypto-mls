# 04: The receipt check and the commit filter follow the new requirement

**What to build:** spec stories 2, 4 and 5. An Add or Update whose
leaf fails the group's *current* required capabilities is no longer
refused when it arrives, because a GroupContextExtensions proposal in
the same epoch could change the requirement. A committer whose pending
Add or Update fails the requirement its own commit will set drops that
proposal rather than throwing, per RFC 9420 12.2.

`validateProposalOnReceipt` stops refusing an Add or Update for its
capabilities alone; every other receipt rule stays. This is the rule
AGENTS.md already states: a receipt check may only refuse what no
commit in this epoch could make valid. `filterPendingProposals` checks
each kept pending Add and Update against the required capabilities of
the commit it is building (after its GroupContextExtensions proposal,
pending or by value, if any) and drops a failing one, using the
derivation ticket 03 introduced. By-value `extraProposals` still
throw. The remaining-members check against a new requirement is
unchanged.

A receiver that sees a commit including a capability-failing Add with
no GroupContextExtensions proposal still refuses it in
`applyTreeMutations`. This package's `createCommit` will not build that
commit, so the test forges it with `forgeAddCommit` from
`test/validation/leaf-key-dishonest-committer.ts`, with an honest
control in the same suite.

Updates are always by reference, so the Update variant sends bob's
Update with the API `test/scenario/update.ts` already uses; ticket 08
adds `createUpdateProposal` later.

**Blocked by:** 03

**Touches:** `src/client-state.ts` (`validateProposalOnReceipt`),
`src/create-commit.ts` (`filterPendingProposals`), the scenario suite
from ticket 03 or a sibling registered in `test/matrix.ts`. Prior art:
`test/scenario/commit-filters-pending-proposals.ts`,
`test/validation/proposal-validation.ts`,
`test/validation/leaf-key-dishonest-committer.ts`,
`test/scenario/update.ts`.

Note: tickets 06, 07 and 08 also edit these files.

**Status:** done

- [x] With the group requiring A, charlie's KeyPackage supporting B
      only is proposed as an Add by reference; every member's
      `processMessage` accepts the proposal; alice then commits a
      GroupContextExtensions proposal requiring B, and every member
      reaches the next epoch with charlie joined.
- [x] Bob's Update dropping support for A, sent by reference, is
      accepted on receipt and committed together with a
      GroupContextExtensions proposal requiring only B; every member,
      bob included, reaches the next epoch.
- [x] A committer holding a pending Add that fails the requirement its
      commit sets commits successfully without it, and every receiver
      reaches the same epoch with the Add not applied.
- [x] The same Add passed by value in `extraProposals` makes
      `createCommit` reject with `ValidationError`.
- [x] A forged commit applying a capability-failing Add with no
      GroupContextExtensions proposal is refused by a receiver with
      `ValidationError`; the forging helper's honest control is
      accepted.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.
