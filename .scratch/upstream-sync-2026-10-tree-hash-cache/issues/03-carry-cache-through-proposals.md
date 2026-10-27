# 03: Carry the cache through Add, Remove and Update

**What to build:** part of spec story 1, and story 4. Applying an
Add, a Remove or an Update gives the new tree the old tree's cached
hashes, minus the changed leaf's direct path, so only that path is
rehashed.

- **The carry-forward primitive.** Add a module-private function next
  to the cache. It takes the old tree, the new tree and the changed
  leaves, and seeds the new tree's cache from the old tree's with
  every node on the changed leaves' direct paths dropped (the leaf
  included). It does nothing when the old tree has no cache, and
  nothing when the two trees differ in width. Use `directPath` and
  the other `src/treemath.ts` helpers rather than writing the index
  arithmetic inline. Ticket 04 reuses this primitive.
- **The helpers.** `updateLeafNode`, `removeLeafNode` and
  `addLeafNode` call it with the one leaf they change. `addLeafNode`
  also changes `unmergedLeaves` on that leaf's direct path, and the
  dropped path covers that. A tree that changes width starts cold:
  `extendTree`, and `removeLeafNode` when condensing truncates it.
  So does any helper that cannot state the set of leaves it changed,
  including `removeLeaves`. Starting cold is always correct.
- **Order.** The seeding happens before the new array is returned
  and before anything hashes it, so the ticket 02 write-before-cache
  rule holds.

A restored state starts cold. Its first commit hashes the whole tree
once, and later commits are cheap.

**Blocked by:** 02

**Touches:** `src/tree-hash.ts`, `src/ratchet-tree.ts`
(`updateLeafNode`, `removeLeafNode`, `addLeafNode`, `extendTree`,
`condenseRatchetTreeAfterRemove`). Callers that chain these:
`applyTreeMutations` and the proposal reducers in
`src/client-state.ts`, `createCommit` and `joinGroupExternal` in
`src/create-commit.ts`, and the external-join branch of
`src/process-messages.ts`. Prior art: the ticket 01 suite,
`test/scenario/remove.ts`, `test/scenario/update.ts`,
`test/scenario/add-with-path.ts`, the RFC 9420 vector
`tree-operations.json`.

**Status:** done

- [x] An Add that fills a blank leaf, an Add that extends the tree, a
      Remove that truncates it and a Remove that does not, each
      followed by an Update commit, leave every member at the same
      epoch authenticator.
- [x] A member restored from a structured clone between two of those
      commits agrees with the members that were not restored.
- [x] The scenario suite, the ticket 01 suite and every RFC 9420
      vector pass unchanged.
- [x] `npm run bench` before and after the change is recorded in this
      ticket's Comments. No test asserts on timing.
- [x] `npm run typecheck`, the Worker typecheck,
      `npm run test:checks`, `npm run check:style`, `npm test` and
      `npm run test:browser` pass.

## Comments

2026-10-27, `npm run bench` (X25519/AES128/Ed25519, 5 iterations),
median latency, the second of two runs of each version (the first
pair was too noisy to read: +-49% on the baseline).

| members | task           | before    | after     |
|---------|----------------|-----------|-----------|
| 64      | createCommit   | 16.9 ms   | 16.0 ms   |
| 64      | processMessage | 13.3 ms   | 9.4 ms    |
| 64      | joinGroup      | 62.7 ms   | 56.6 ms   |
| 256     | createCommit   | 75.7 ms   | 51.8 ms   |
| 256     | processMessage | 37.7 ms   | 27.2 ms   |
| 256     | joinGroup      | 262.5 ms  | 301.8 ms  |
| 1024    | createCommit   | 209.6 ms  | 200.1 ms  |
| 1024    | processMessage | 116.0 ms  | 106.5 ms  |
| 1024    | joinGroup      | 840.5 ms  | 861.0 ms  |

No change is expected, and at 1024 members, where the noise is
smallest relative to the work, there is none beyond noise. The
benchmark times an empty path commit, which calls none of
`addLeafNode`, `updateLeafNode` or `removeLeafNode`. The swings at 64
and 256 members go both ways (`joinGroup` at 256 is slower, and
nothing here touches a join) and track the error bars. What this
ticket speeds up is an Add-only commit, the one pathless commit, whose
tree hash now reuses every subtree the Adds did not touch. A commit
with a path still starts its new tree cold, because `createUpdatePath`
and `applyUpdatePath` copy the tree; ticket 04 carries the cache
through that copy, and it is what the benchmark will show.
