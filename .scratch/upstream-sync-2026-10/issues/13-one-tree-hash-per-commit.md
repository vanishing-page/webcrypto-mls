# 13: One tree hash per commit, and cheaper UpdatePaths

**What to build:** spec story 17. A commit sent or received hashes the
ratchet tree once, and building and encrypting an UpdatePath stops
doing work proportional to the group size more than once.

- **One tree hash.** `createUpdatePath` and the receive path's tree
  update return the tree hash they already compute, and their callers
  use it instead of hashing again. The external-join path does the
  same. (Upstream `1e46263`, `7b5d210`.)
- **Locally owned arrays.** `createSecretTree` and `createUpdatePath`
  take one copy of the array they build and write into it, instead of
  copying the whole array once per node. This is safe only because the
  array is the call's own; the per-message `updateArray` calls that
  share nodes across state versions do not change. (Upstream
  `df2dc49`.)
- **UpdatePath encryption.** The encoded group context is computed
  once per UpdatePath, not once per recipient, and HPKE encryptions
  run in batches of at most 512. (Upstream `9d3f1a7`.)

Read upstream for intent only.

**Blocked by:** 01

**Touches:** `src/update-path.ts` (`createUpdatePath`),
`src/create-commit.ts` (`createCommit`, `joinGroupExternal`),
`src/process-messages.ts`, `src/secret-tree.ts` (`createSecretTree`),
`src/tree-hash.ts`. Prior art:
`test/scenario/large-group-full-lifecycle.ts`,
`test/scenario/update-path-ciphertext-count.ts`,
`test/validation/prior-state-reuse.ts`, the RFC 9420 vectors
`treekem.json` and `tree-operations.json`.

Note: tickets 03, 04, 06, 07 and 08 also edit these files. If ticket
06 has landed, its lifecycle test must still pass: an owned array must
not start sharing a buffer with the input state.

**Status:** done

- [x] The scenario suite, the RFC 9420 vectors,
      `large-group-full-lifecycle.ts`,
      `update-path-ciphertext-count.ts` and `prior-state-reuse.ts`
      pass unchanged.
- [x] Under one sample ciphersuite, a commit whose UpdatePath encrypts
      to more than 512 recipients is processed by the first recipient,
      the last, and one on each side of the 512 boundary.
- [x] An external join and the existing members' processing of it
      still succeed.
- [x] `npm run bench` before and after the change is recorded in this
      ticket's Comments. No test asserts on timing.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style`, `npm test` and `npm run test:browser`
      pass.

## Comments

2026-10-27, `npm run bench` (X25519/AES128/Ed25519, 5 iterations,
median latency in ms), before and after the change on the same
machine:

| Members | Task           | Before | After |
| ------- | -------------- | ------ | ----- |
| 64      | createCommit   | 22.9   | 25.5  |
| 64      | processMessage | 14.8   | 12.1  |
| 64      | joinGroup      | 56.5   | 55.2  |
| 256     | createCommit   | 77.2   | 60.8  |
| 256     | processMessage | 46.6   | 36.0  |
| 256     | joinGroup      | 212.9  | 213.2 |
| 1024    | createCommit   | 283.4  | 254.4 |
| 1024    | processMessage | 190.4  | 136.4 |
| 1024    | joinGroup      | 968.7  | 958.2 |

joinGroup is unchanged, as expected: it does not build or apply an
UpdatePath. Its ratchet-tree validation is ticket 12's. The 64-member
createCommit difference is within run-to-run noise.
