# 12: Ratchet-tree validation in linear time

**What to build:** spec story 16. Joining a group of thousands is
practical: `validateRatchetTree` takes time linear in the group size
instead of quadratic.

Inside one `validateRatchetTree` call:

- `calculateParentHash` results are memoized per node index;
- `removeLeaves` is skipped when a node has no unmerged leaves, and
  takes a set rather than scanning a list when it does;
- one tree-hash cache is shared by parent-hash verification and the
  tree-hash check;
- the sets of HPKE keys, signature keys and credential types in the
  tree are computed once, not once per leaf.

Nothing cached leaves the call: no module-level state, nothing stored
on the tree or in `ClientState`. The companion spec
(`.scratch/upstream-sync-2026-10-tree-hash-cache/spec.md`) builds a
cache that does cross calls; keep this one per call so that work can
replace it cleanly.

Every rule this package checks beyond upstream stays, each with a
failing-input test: the pairwise credential rule in both directions,
`priorCredential`, `validateHpkePublicKey` and small-order keys, the
resolution criterion, the unmerged-leaves check, and the constant-time
comparisons. Before changing code, find the test that covers each
rule and add one where none exists. Read upstream `664ea24`,
`2a83288`, `0e8748f`, `16e489b` and `1d9f892` for intent only.

**Blocked by:** 01, 02

**Touches:** `src/client-state.ts` (`validateRatchetTree`),
`src/parent-hash.ts` (`verifyParentHashes`, `calculateParentHash`),
`src/ratchet-tree.ts` (`removeLeaves`), `src/tree-hash.ts`. Prior art:
`test/validation/ratchet-tree-validation.ts`,
`test/validation/parent-hash-resolution.ts`,
`test/validation/unmerged-leaves-validation.ts`,
`test/validation/credential-capability-floor.ts`,
`test/validation/small-order-signature-key.ts`, the suites from ticket
02, the RFC 9420 vectors `tree-validation.json`, `treekem.json` and
`tree-operations.json`.

**Status:** done

- [x] Each rule listed above has a test that feeds a tree breaking
      only that rule and requires `joinGroup` to reject it; name each
      test in the commit message.
- [x] The scenario suite, the ticket 02 suites, the three RFC 9420
      tree vectors and `test/scenario/large-group-full-lifecycle.ts`
      pass unchanged.
- [x] `npm run bench` before and after the change is recorded in this
      ticket's Comments, with the `joinGroup` row at 1024 members
      called out. No test asserts on timing.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

## Comments

2026-10-27, `npm run bench` (X25519/AES128/Ed25519, 5 iterations). The
machine's load average was about 40 throughout, so the two versions
were run in alternation (before, after, before, after) and the numbers
below are mean latency from those paired runs.

| members | task         | before          | after           |
|---------|--------------|-----------------|-----------------|
| 64      | createCommit | 41.9, 40.4 ms   | 40.1, 44.6 ms   |
| 64      | joinGroup    | 85.6, 91.9 ms   | 88.7, 85.2 ms   |
| 256     | createCommit | 164.4, 134.3 ms | 132.2, 135.3 ms |
| 256     | joinGroup    | 340.1, 322.3 ms | 319.6, 306.9 ms |
| 1024    | createCommit | 551.1, 544.3 ms | 569.0, 529.6 ms |
| 1024    | joinGroup    | 1605, 1508 ms   | 1302, 1256 ms   |

`joinGroup` at 1024 members: about 1.56 s before, 1.28 s after, a
reduction of roughly 18%. The join was already close to linear in the
bench's group (one commit of 1023 Adds, so most parent nodes are
blank): 256 to 1024 members scaled by about 4.6x before and 4.1x
after. What remains is per-leaf work that is linear by nature: leaf
signature verification, the HPKE key import in
`validateHpkePublicKey`, and the AuthenticationService call.
`createCommit` does not go through `validateRatchetTree` and is
unchanged within noise.

The credential rule's second direction (a leaf supports every type in
use) cannot be broken alone by any tree: whichever leaf lacks the
type, the leaf using it then fails the first direction. The join-time
case puts the narrower leaf first so this direction is the one that
fires, and `test/validation/credential-capability-floor.ts` isolates it
through an Update and an Add, which run the same
`validateLeafNodeCommon` code.
