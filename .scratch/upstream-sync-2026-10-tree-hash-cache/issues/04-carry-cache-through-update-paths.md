# 04: Carry the cache through UpdatePaths, send and receive

**What to build:** the rest of spec story 1. A commit with an
UpdatePath, sent or received, rehashes only the sender's direct
path, so its hashing cost grows with the depth of the tree rather
than its size.

- **Seed before parent hashes.** Seeding at the end is not enough.
  `calculateParentHash` hashes the copath sibling of each node on the
  path, and for the node under the root that sibling is half the
  tree. If the tree being built starts cold, the commit stays linear
  in the group size even with the cache in place. So
  `createUpdatePath` and `applyUpdatePath` seed the tree they build
  from the input tree's cache, minus the sender's direct path, using
  the ticket 03 primitive. They do this before the first
  `calculateParentHash` call. The copath subtrees are identical in
  both arrays, so their hashes are read rather than recomputed.
- **The write-before-cache rule.** The seeded entries cover only
  copath nodes, and the builders write only to nodes on the direct
  path, so no write lands under a cached hash. Keep it that way, and
  update the AGENTS.md note from ticket 02 if a write site moves.
- **Every path.** This covers the member send path in `createCommit`,
  the member receive path, and the external commit on both sides:
  `joinGroupExternal` (which removes the former leaf on a resync and
  adds the new one before `createUpdatePath`), and the receive
  branch that calls `addLeafNode` before
  `applyUpdatePath(..., true)`. The tree hash that main-spec ticket
  13 returns from these functions is then computed against a warm
  cache.
- **Not covered.** Trees built by `removeLeaves`, for a parent with
  unmerged leaves, start cold. Only those nodes pay for it. Linear
  scans that are not hashing are out of scope, such as the receive
  path's check that no UpdatePath key is already in the tree.

**Blocked by:** 03

**Touches:** `src/update-path.ts` (`createUpdatePath`,
`applyUpdatePath`, `insertParentHashes`, `applyInitialTreeUpdate`),
`src/parent-hash.ts` (`calculateParentHash`), `src/create-commit.ts`
(`createCommit`, `joinGroupExternal`), `src/process-messages.ts`,
`src/tree-hash.ts`, `AGENTS.md`. Prior art: the ticket 01 suite,
`test/scenario/external-join.ts`,
`test/scenario/external-join-resync.ts`,
`test/scenario/leaf-width-update-path.ts`,
`test/scenario/update-path-ciphertext-count.ts`,
`test/validation/prior-state-reuse.ts`,
`test/validation/parent-hash-resolution.ts`, the RFC 9420 vectors
`treekem.json` and `passive-client-*.json`.

**Status:** done

- [x] A sequence of path commits from different members, each
      processed by all others, keeps every member at the same epoch
      authenticator, and every member can decrypt every other.
- [x] An external join, and an external resync that replaces the
      joiner's former leaf, are each processed by every existing
      member, and the group agrees on the next epoch.
- [x] A member structured-cloned between two path commits agrees with
      the original on every later epoch authenticator.
- [x] A received UpdatePath whose parent hash does not match is still
      refused with the same error class as today.
- [x] The scenario suite, the ticket 01 suite and every RFC 9420
      vector pass unchanged.
- [x] `npm run bench` before and after the change is recorded in this
      ticket's Comments, with the `createCommit` and `processMessage`
      rows at 1024 members called out. No test asserts on timing.
- [x] `npm run typecheck`, the Worker typecheck,
      `npm run test:checks`, `npm run check:style`, `npm test` and
      `npm run test:browser` pass.

## Comments

2026-10-27, `npm run bench` (X25519/AES128/Ed25519, 5 iterations),
median latency. Two runs of each version; "before" is the parent of
commit f3602a3, "after" is f3602a3.

| members | task           | before 1  | after 1   | before 2  | after 2   |
|---------|----------------|-----------|-----------|-----------|-----------|
| 64      | createCommit   | 18.2 ms   | 14.1 ms   | 16.1 ms   | 14.5 ms   |
| 64      | processMessage | 12.7 ms   | 7.2 ms    | 9.2 ms    | 7.4 ms    |
| 64      | joinGroup      | 67.0 ms   | 53.4 ms   | 55.8 ms   | 54.1 ms   |
| 256     | createCommit   | 58.7 ms   | 43.2 ms   | 52.4 ms   | 46.4 ms   |
| 256     | processMessage | 30.5 ms   | 19.9 ms   | 29.6 ms   | 19.2 ms   |
| 256     | joinGroup      | 226.2 ms  | 233.4 ms  | 204.8 ms  | 202.3 ms  |
| 1024    | createCommit   | 214.6 ms  | 199.6 ms  | 220.3 ms  | 165.6 ms  |
| 1024    | processMessage | 107.6 ms  | 78.5 ms   | 112.3 ms  | 68.5 ms   |
| 1024    | joinGroup      | 908.8 ms  | 911.6 ms  | 892.5 ms  | 795.9 ms  |

At 1024 members, `processMessage` falls by 27% and 39% in the two
pairs, and `createCommit` by 7% and 25%. The receiver's commit no
longer rehashes the copath subtrees, half the tree at the top level,
so the hashing left is the sender's direct path. Neither row falls
further because hashing is no longer what dominates them. The
benchmark's group is built by one Add-only commit, so every parent
node is blank and alice's path commit HPKE-encrypts to almost every
other leaf; that linear cost is untouched here. On the receive side,
the linear scans that are not hashing (the check that no UpdatePath key
is already in the tree, the secret tree for the new epoch) remain, as
the ticket expects. `joinGroup` is not touched by this ticket and moves
only within its error bars (+-5% to +-48% avg).
