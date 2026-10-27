# 02: Port upstream's regression scenarios

**What to build:** spec story 19. The regression scenarios upstream
wrote that have no counterpart here run here too, through the public
operations. They also guard ticket 12, which rewrites ratchet-tree
validation, so this ticket lands first.

The cases, from the spec's Testing Decisions:

- join-time ratchet-tree rejections: a tampered parent hash, a
  GroupInfo tree-hash mismatch, duplicate HPKE keys leaf to leaf and
  leaf to parent, duplicate signature keys, a bad leaf signature for
  each leaf node source (`key_package`, `update`, `commit`), an
  `AuthenticationService` that rejects at join, and an Add with the
  wrong ciphersuite or version inside a commit;
- an `external_senders` extension with two entries, and an external
  proposal signed by the second entry;
- a GroupContextExtensions commit carrying a Remove, processed by a
  remaining member, by value and by reference (upstream `60b737b`);
- a three-member GroupContextExtensions commit over the private wire
  format that sets `external_senders`, after which every member can
  still send and receive.

Each rejection case has to reach the rule it names. A mutation that
trips an earlier check (the tree hash, the GroupInfo signature) proves
nothing about the rule under test, so the forgery recomputes what
depends on the mutated bytes, and every forging helper has an honest
control in the same suite that feeds it unmodified inputs and requires
acceptance, as `test/validation/leaf-key-dishonest-committer.ts` does.
A case already covered by an existing test is skipped, not
duplicated; say which test covers it in the commit message.

If a ported case fails today, fix the bug here when it is local. If
the GroupContextExtensions-with-Remove case fails because proposals are
validated in the wrong order, that is ticket 03's work: leave the case
in place, marked as a known failure in a way that does not fail the
run, and note it in ticket 03's Comments.

**Blocked by:** None (can start immediately)

**Touches:** new suites under `test/validation/` and `test/scenario/`,
registered in `test/matrix.ts`. Prior art:
`test/validation/ratchet-tree-validation.ts`,
`test/validation/leaf-key-dishonest-committer.ts`,
`test/validation/external-senders-join.ts`,
`test/scenario/external-proposal.ts`,
`test/scenario/gce-empty-extensions.ts`; upstream's tests at
`b2e85a4`.

**Status:** done

- [x] Each join-time rejection listed above makes `joinGroup` reject
      with `ValidationError` (or the class the existing rule already
      throws), and each forging helper's honest control joins.
- [x] A proposal signed by the second of two `external_senders`
      entries is accepted by every member and can be committed.
- [x] A GroupContextExtensions commit with a Remove is processed by a
      remaining member and both reach the same epoch, by value and by
      reference.
- [x] After a three-member private-wire GroupContextExtensions commit
      that sets `external_senders`, every member sends a message every
      other member decrypts.
- [x] Every new suite loops over `testCiphersuites()` or
      `sampleCiphersuites()`, passes `testClientConfig`, and is
      imported from `test/matrix.ts`.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.
