# 02: Tree-hash cache per tree, and join reuses it

**What to build:** spec stories 2, 3 and 5. The package caches tree
hashes per ratchet tree, and a member joining a large group hashes
each subtree once. The tree in the joined state then starts with
those hashes already cached.

- **The cache.** A module-private `WeakMap` in `src/tree-hash.ts`,
  from a ratchet tree array to its per-node hashes indexed by node
  index. `treeHash` and `treeHashRoot` read it and fill it. It is
  never exported from the package, never attached to `ClientState`
  and never serialized, so a restored state starts cold. Tree hashes
  are public, so nothing here is zeroized or listed in `consumed`.
- **Join.** Replace the per-call tree-hash cache that main-spec
  ticket 12 added to `validateRatchetTree` with this one. Both
  `joinGroup` and `joinGroupExternal` validate the same array that
  becomes the state's tree, so validation warms the tree the group
  goes on to use. A failed validation drops the array, and its cache
  goes with it. The per-call memo of parent hashes from ticket 12
  stays per call (spec, Out of Scope).
- **Caller-supplied trees.** The `ratchetTree` argument to `joinGroup`
  and the `tree` argument to `joinGroupExternal` belong to the
  application, which could change one after a failed attempt and
  pass it again. Take a shallow copy on entry, so that every array
  the package caches against is one it owns. A tree decoded from the
  `ratchet_tree` extension is already the package's own.
- **The invariant, stated precisely.** Audit every place a ratchet
  tree array is written in place. Today that is `applyUpdatePath`'s
  `copy`, and after main-spec ticket 13 it is also the array
  `createUpdatePath` owns. Both call `calculateParentHash` between
  writes. Once ticket 12 skips `removeLeaves` for nodes with no
  unmerged leaves, that call hashes copath subtrees of the array
  that is still being built. That is safe only because the cached
  nodes and the written nodes never overlap. The rule to record in
  AGENTS.md, beside the zeroization ownership rule, is: **no node of
  a tree array is written after a cached hash covers it** (the
  node's own hash or any ancestor's). A breach does not throw. It
  produces or accepts a wrong tree hash, and the group forks. Where
  a write site does not follow the rule, restructure it so that it
  does.

With only this ticket, every tree derived by a commit still starts
cold. Tickets 03 and 04 carry the cache forward.

**Blocked by:** 01, upstream-sync-2026-10 12, upstream-sync-2026-10 13

**Touches:** `src/tree-hash.ts` (`treeHash`, `treeHashRoot`),
`src/client-state.ts` (`validateRatchetTree`, `joinGroup`),
`src/create-commit.ts` (`joinGroupExternal`), `src/parent-hash.ts`
(`calculateParentHash`, `verifyParentHashes`), `src/update-path.ts`
(`applyUpdatePath`, `createUpdatePath`), `AGENTS.md`. Prior art:
`test/scenario/large-group-full-lifecycle.ts`,
`test/scenario/ratchet-tree-extension.ts`,
`test/validation/ratchet-tree-validation.ts`, the RFC 9420 vectors
`tree-operations.json`, `treekem.json`, `tree-validation.json` and
`passive-client-*.json`, and the suite from ticket 01.

**Status:** done

- [x] A member joins a large group through a Welcome carrying the
      ratchet tree, then processes a commit and agrees with the
      group on the epoch authenticator.
- [x] A Welcome with a tampered ratchet tree is refused with the same
      error class as today. The same joiner's next attempt, with an
      honest Welcome, succeeds.
- [x] A ratchet tree passed to `joinGroup` as an argument, changed by
      the caller after a refused join and passed again, is judged on
      its new contents.
- [x] The scenario suite, the ticket 01 suite and every RFC 9420
      vector pass unchanged.
- [x] AGENTS.md states the write-before-cache rule and names the
      in-place write sites the audit found.
- [x] `npm run bench` before and after the change is recorded in this
      ticket's Comments, with the `joinGroup` row called out. No test
      asserts on timing.
- [x] `npm run typecheck`, the Worker typecheck,
      `npm run test:checks`, `npm run check:style`, `npm test` and
      `npm run test:browser` pass.

## Comments

2026-10-27, `npm run bench` (X25519/AES128/Ed25519, 5 iterations),
mean latency, one run of each version.

| members | task           | before    | after     |
|---------|----------------|-----------|-----------|
| 64      | createCommit   | 18.1 ms   | 18.1 ms   |
| 64      | processMessage | 11.3 ms   | 10.1 ms   |
| 64      | joinGroup      | 54.1 ms   | 56.2 ms   |
| 256     | createCommit   | 58.8 ms   | 55.5 ms   |
| 256     | processMessage | 35.8 ms   | 27.2 ms   |
| 256     | joinGroup      | 207.5 ms  | 206.9 ms  |
| 1024    | createCommit   | 257.1 ms  | 214.3 ms  |
| 1024    | processMessage | 139.8 ms  | 104.8 ms  |
| 1024    | joinGroup      | 867.8 ms  | 821.1 ms  |

`joinGroup` is unchanged within noise at every size (about 5% at
1024 members). That is expected: main-spec ticket 12 already shared
one cache between parent-hash verification and the tree-hash check
inside the call, and the tree a join decodes from the Welcome is new
on every iteration, so it starts cold either way. What this ticket
adds to a join is that the joined state's tree keeps those hashes,
which only pays off once tickets 03 and 04 carry a cache from one
tree to the next.

`createCommit` and `processMessage` are faster at 256 and 1024
members, by about 17% and 25% at 1024. That is a side effect of the
cache being automatic: both sides of an UpdatePath
(`createUpdatePath`'s copy, `applyUpdatePath`'s `copy`) call
`calculateParentHash` once per filtered-direct-path node, which
hashes that node's copath subtree, and the hash is now cached against
the array being built. The tree hash taken at the end over the same
array then reuses every copath subtree and hashes only the direct
path, where before it rehashed the whole tree.
