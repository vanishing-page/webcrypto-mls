# Upstream sync 2026-10: tree-hash cache across epochs

**Status:** ready-for-agent
**Source:** the upstream audit of 2026-10-26 against LukaJCB/ts-mls at
`b2e85a4`; upstream commits `1d55ca0` (tree-hash cache layer) and
`16e489b` (reuse it for parent hashes on join).
**Depends on:** `.scratch/upstream-sync-2026-10/spec.md`, for its
benchmark, its single tree hash per commit, and its per-call cache
inside ratchet-tree validation. This spec builds on all three.

This spec has one seam: group behavior through the public `ClientState`
operations.

## Problem Statement

Every commit a member sends or receives hashes the whole ratchet tree,
about two digests per node, even though a commit changes only the
nodes on a few direct paths. Once the main upgrade spec lands, each
commit does this once per side instead of two or three times, but the
cost still grows linearly with the group. For a group of thousands it
dominates the commit, and it is the same work on every member's
device for every commit.

Upstream solved this with a cache of per-node tree hashes stored on
the group state, carried from one epoch to the next and serialized
with it. Copying that design here would put a new field on
`ClientState`, which applications persist by structured clone, and
would mean trusting a cache read back from storage. A stale entry
does not fail loudly: it produces or accepts a wrong tree hash, and
the group forks.

## Solution

Tree hashes are cached per ratchet tree, outside `ClientState`, in a
module-level map keyed weakly by the tree array. A tree is immutable
once it has been returned, so a cache attached to one tree is never
stale. When an operation derives a new tree from a cached one and
knows which leaves it changed, the new tree's cache starts as a copy
of the old one with those leaves' direct paths dropped, and only those
paths are rehashed. A tree the package did not derive itself (a
decoded tree, a tree in a state restored from storage) starts with an
empty cache and fills it on first use. Nothing is persisted, so
nothing persisted can be trusted wrongly, and the shape of
`ClientState` does not change.

## User Stories

1. As a member of a large group, I want a commit to rehash only the
   nodes it changed, so that commit cost grows with the depth of the
   tree, not its size.
2. As a member, I want a group never to fork because of a cached
   hash, so that the optimization cannot cost me my membership.
3. As an application, I want states I persist and restore to keep
   working exactly as before, so that the optimization needs no
   migration and no new restore step.
4. As a member who has just restored a state, I want the first commit
   to cost what a commit costs today and later ones to be cheap, so
   that a cold cache is a slowdown, never an error.
5. As a member joining a large group, I want the tree hashes computed
   while validating the ratchet tree to be the ones the group then
   uses, so that joining hashes each subtree once.

## Implementation Decisions

- **Where the cache lives.** A module-private `WeakMap` in the
  tree-hash module, from a ratchet tree array to an array of per-node
  hashes indexed by node index. `treeHashRoot` and `treeHash` read and
  fill it. It is never attached to `ClientState`, never exported, and
  never serialized, so structured clone drops it and a restored state
  starts cold.
- **Invariant.** A tree array is never written to after any hash of it
  has been cached. The package already treats trees as values: every
  mutation helper returns a new array, and the locally owned arrays
  that the main spec introduces are written only before they are
  returned. Any new code that writes into a tree array in place must
  do so before the array escapes the function that built it. AGENTS.md
  records this invariant beside the existing zeroization ownership
  rule, because the failure mode, a silent fork, is as hard to see.
- **Carrying the cache forward.** The helpers that derive a new tree
  from an old one with a known set of changed leaves (`updateLeafNode`,
  `removeLeafNode`, `addLeafNode`, applying an UpdatePath on send and
  on receive) give the new tree a cache copied from the old tree's,
  minus every node on the changed leaves' direct paths. A change of
  tree width (extending, or truncating after a Remove) re-indexes
  nothing: the derived tree starts cold. So does any helper that
  cannot state its changed set. Starting cold is always correct.
- **Join.** The per-call cache that ratchet-tree validation builds in
  the main spec is handed to the new state's tree as its initial
  cache once validation succeeds, so the hashes computed to verify
  parent hashes and the tree hash are not computed again. A failed
  validation discards it.
- **No hashes are secret.** Tree hashes are public values, so nothing
  here is zeroized and nothing is listed in `consumed`.
- **Lazy secret-tree derivation (upstream `950ed8a`) is not ported.**
  After the main spec's array fix, building the secret tree costs
  O(n) KDF calls per epoch, and laziness would only defer them. It
  would not improve forward secrecy, because an unvisited intermediate
  secret derives exactly what the eager leaf roots hold. And a retired
  epoch would have to choose between keeping intermediates, which
  makes its handshake keys derivable again (the package strips them
  today, see `stripHandshakeRatchets`), and expanding every leaf at
  retirement, which cancels the gain under the default retention of
  four epochs. Revisit only if the benchmark shows secret-tree
  creation dominating at a group size that matters.

## Testing Decisions

A good test here observes what a member can see: whether members
agree on the epoch and can keep exchanging messages, and whether an
operation succeeds or throws which error class. No test inspects the
cache or asserts on timing; the benchmark from the main spec measures
the speedup and is not a test. Tests loop over `sampleCiphersuites()`,
since the cache is ciphersuite-independent, pass `testClientConfig`,
and are imported from `test/matrix.ts`.

The seam is the public `ClientState` operations. Prior art:
`test/scenario/large-group-full-lifecycle.ts`,
`test/scenario/multiple-joins-at-once.ts`, and the RFC 9420 vectors
in `test/test-vectors/` (`tree-operations.json`, `treekem.json`,
`tree-validation.json`, `passive-client-*.json`).

- The existing scenario suite and every RFC 9420 vector pass
  unchanged.
- A seeded random sequence of Adds, Removes, Updates, path commits
  and external joins over a group of a few dozen members, after which
  every member's epoch authenticator agrees at every epoch and every
  member can decrypt a message from every other. The seed is printed
  on failure.
- A cold state agrees with a warm one: one member's state is
  structured-cloned (with `clientConfig` re-attached, as the README's
  persistence section does) partway through the sequence, and the
  clone and the original process the same following commits to the
  same epoch authenticator.
- Width changes: commits that extend the tree and Removes that
  truncate it, each followed by a commit, keep all members in
  agreement.
- Join: a member joins a large group through a Welcome carrying the
  ratchet tree and then processes a commit; a tampered tree in a
  Welcome is still refused, after which the joiner's next attempt
  with an honest Welcome succeeds.

## Out of Scope

- Persisting the cache, or putting it on `ClientState` as upstream
  does.
- Lazy secret-tree derivation, for the reasons under Implementation
  Decisions.
- A cache for parent hashes across epochs. The main spec memoizes
  them within one validation, which is where the quadratic cost was.

## Further Notes

- Upstream's cache is part of its serialized group state and is read
  back on load. If a later change ever persists this cache, it has to
  be recomputed or checked against the GroupContext tree hash on
  restore, not trusted.
- A `WeakMap` keyed by the tree keeps memory proportional to the
  trees the application still holds. A retained prior state keeps its
  tree's cache alive, as it keeps the tree.
