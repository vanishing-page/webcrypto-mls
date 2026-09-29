# 09: Commits cannot leave the tree unjoinable or admit an unsupported member

**What to build:** audit findings M1, L3, L4 and L7, spec stories 15,
22, 23 and 26. Each of these lets one member commit a tree that every
member accepts but that no later joiner can join, or that contains a
member unable to support the group:

- M1: `validateProposals` checks each Update against the pre-commit
  `ratchetTree`, not the running tree the Adds already use. Two Updates
  in one commit can then carry the same HPKE key, or violate the
  pairwise credential rule, and every later `joinGroup` rejects the
  tree. Validate each Update against the progressively updated tree,
  the same way Adds are validated.
- L3: `applyUpdatePath` never compares the committer's new leaf
  `hpkePublicKey` against the keys on its own UpdatePath. Reject a
  commit where they collide.
- L4: when a commit carries a GroupContextExtensions proposal, Adds are
  checked against the current extensions, and the new-extension check
  skips them. Check Adds against the proposed extensions, and report a
  failure as `ValidationError`. `joinGroup` currently reports the same
  peer-caused condition as `UsageError`. Make that a `ValidationError`
  too.
- L7: an Update whose `hpkePublicKey` equals the sender's current leaf
  key is accepted. RFC 9420 section 12.1.2 requires a new key, so
  reject it with `ValidationError`.

If ticket 03 has landed, the L7 check belongs in the Update leaf
validation that receipt validation also calls, so it applies on
receipt too.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`validateProposals`: the Update
loop, the Add and GroupContextExtensions checks;
`validateLeafNodeUpdateOrCommit`; `joinGroup`), `src/update-path.ts`
(`applyUpdatePath`), `test/validation/update-path-key-uniqueness.ts`,
`test/validation/add-key-uniqueness.ts`,
`test/validation/proposal-validation.ts`,
`test/scenario/gce-committer-leaf-validation.ts`, `CHANGELOG.md`

Note: tickets 03 and 04 also edit proposal validation in
`client-state.ts`.

**Status:** done

- [x] A commit carrying two Updates that advertise the same HPKE key is
      rejected by every receiver with `ValidationError`, and the group
      stays joinable.
- [x] A commit carrying two Updates whose combined credential types
      violate the pairwise rule is rejected with `ValidationError`.
- [x] A path commit whose new committer leaf key equals one of its own
      UpdatePath node keys is rejected with `ValidationError`.
- [x] A commit carrying GroupContextExtensions plus an Add whose
      KeyPackage lacks support for the new extensions is rejected with
      `ValidationError`.
- [x] A Welcome produced for that situation (by a committer that skips
      the check) makes `joinGroup` reject with `ValidationError`, not
      `UsageError`.
- [x] An Update that keeps the sender's current encryption key is
      rejected with `ValidationError`.
- [x] After each rejection, a fresh member can still join the group
      from the next honest commit's Welcome.
