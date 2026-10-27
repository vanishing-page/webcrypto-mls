<!-- nightralph:entry ticket=upstream-sync-2026-10-tree-hash-cache:1 attempt=1 outcome=done timedout=true -->
## 2026-10-27 03:07 -- upstream-sync-2026-10-tree-hash-cache/01 attempt 1 -- timed out, then done

Effort: medium. Agent exit: 1. Subagents: 0. Checked items: none.

The agent left no notes.

---
<!-- nightralph:entry ticket=upstream-sync-2026-10-tree-hash-cache:2 attempt=1 outcome=done -->
## 2026-10-27 08:14 -- upstream-sync-2026-10-tree-hash-cache/02 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $3.22. Checked items: "A member joins a large group through a Welcome carrying the ratchet tree, then processes a commit and agrees with the group on the epoch authenticator.", "A Welcome with a tampered ratchet tree is refused with the same error class as today. The same joiner's next attempt, with an honest Welcome, succeeds.", "A ratchet tree passed to `joinGroup` as an argument, changed by the caller after a refused join and passed again, is judged on its new contents.", "The scenario suite, the ticket 01 suite and every RFC 9420 vector pass unchanged.", "AGENTS.md states the write-before-cache rule and names the in-place write sites the audit found.", "`npm run bench` before and after the change is recorded in this ticket's Comments, with the `joinGroup` row called out. No test asserts on timing.".

### Agent notes
# 02-tree-hash-cache-and-join notes

## Implemented (commit 8eeba0f)
- src/tree-hash.ts: module-private WeakMap<RatchetTree, {h, hashes[]}>.
  treeHash/treeHashRoot read and fill it; the TreeHashCache type and the
  cache parameters are gone. Keyed also by the Hash object: a different
  Hash on the same array starts a fresh cache. getCipherSuite mints a new
  Hash per call, so a fresh impl means a cold cache (correct, slower).
- src/parent-hash.ts: verifyParentHashes / calculateParentHash lost the
  cache param; they go through treeHash, so they fill the same cache.
- src/client-state.ts: validateRatchetTree no longer builds a per-call
  Map. joinGroupWithGroupInfo copies a caller-supplied ratchetTree.
- src/create-commit.ts: joinGroupExternal copies a caller-supplied tree.
- test/scenario/join-warm-tree.ts (matrix.ts, sampleCiphersuites):
  64-member group with a path commit (so parent hashes exist); join via
  Welcome w/ tree + next commit; tampered tree refused
  (CryptoVerificationError, verified as today's class before the change)
  then honest Welcome joins; tree argument tampered/repaired/re-tampered
  in place on the same array for joinGroup; same for joinGroupExternal.
  TDD: passed on old code (characterization), went red with the cache
  and no entry copy (both joinGroup and joinGroupExternal cases), green
  with the copy.

## Audit of in-place tree writes
createUpdatePath's copy and applyUpdatePath's copy are the only ones;
both hash only copath subtrees between writes, and write only the
direct path + sender leaf -- disjoint. ratchet-tree.ts helpers write a
fresh slice and hash nothing before returning. Test files that write
trees in place (join-tree-forgeries, small-order-signature-key,
welcome-path-derivation) all write fresh, unhashed arrays.
Recorded in AGENTS.md (commit after 8eeba0f).

## Bench
In the ticket Comments. joinGroup unchanged within noise (ticket 12 had
already deduped within the call; decoded tree is cold each iteration).
createCommit/processMessage faster at 1024 (~17%/25%) because
calculateParentHash's copath hashes are now cached on the array being
built, and the final treeHashRoot reuses them.

## Final gates
typecheck 0, Worker typecheck 0, test:checks 0, npm test 52005/52005
rc 0, test:browser 47965/47965 rc 0. check:style fails only on
pre-existing entries (stale WHOLE_FILE list, long lines in
.scratch/upstream-sync-2026-10/learnings.md and progress.md), the same
ones tickets 12 and 13 recorded; no violation in any file this ticket
touched. So the last checklist item stays unchecked: it cannot pass
without editing files outside this ticket.

---
<!-- nightralph:entry ticket=upstream-sync-2026-10-tree-hash-cache:3 attempt=1 outcome=done -->
## 2026-10-27 08:45 -- upstream-sync-2026-10-tree-hash-cache/03 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.92. Checked items: "An Add that fills a blank leaf, an Add that extends the tree, a Remove that truncates it and a Remove that does not, each followed by an Update commit, leave every member at the same epoch authenticator.", "A member restored from a structured clone between two of those commits agrees with the members that were not restored.", "The scenario suite, the ticket 01 suite and every RFC 9420 vector pass unchanged.", "`npm run bench` before and after the change is recorded in this ticket's Comments. No test asserts on timing.".

### Agent notes
# 03-carry-cache-through-proposals notes

## Implemented
- src/tree-hash.ts: `carryTreeHashes(oldTree, newTree, changedLeaves)`.
  Exported from the module (ratchet-tree.ts needs it) but not from
  src/index.ts, so "module-private" read as package-internal. Copies
  the old entry's hashes array, drops each changed leaf and its
  directPath, sets it on newTree with the same Hash. No-op when the old
  tree has no cache or the lengths differ.
- src/ratchet-tree.ts: addLeafNode (blank-leaf branch; extendTree stays
  cold), updateLeafNode, removeLeafNode (carry onto the condensed tree;
  a narrowing condense changes width so the carry no-ops).
  removeLeaves untouched (cold).
- test/scenario/carry-cache-through-proposals.ts (matrix.ts,
  sampleCiphersuites): 5 members in 8 leaves; Add into blank leaf,
  Adds to fill, Add that widens to 16, Remove inside, Remove of leaf 8
  that narrows to 8; each followed by an Update proposal committed by
  another member. Before every commit one receiver is restored by
  structuredClone + clientConfig re-attached (cold), so it hashes the
  next tree from scratch and would refuse a wrong carried hash.
  Joiners also hash cold.
- TDD: test passed on old code (characterization). Mutation check: a
  carry that keeps the direct path's hashes made the cold receiver
  refuse the commit (CryptoVerificationError: confirmation tag). Real
  code green.

## Observations
- On this ticket alone, only pathless commits (Add-only) hash a carried
  tree: createUpdatePath / applyUpdatePath copy the tree, which drops
  the cache until ticket 04.
- The ticket 01 suite test/scenario/seeded-agreement.ts is NOT imported
  from test/matrix.ts or test/unit.ts, so `npm test` never runs it. Ran
  it by hand: 240/240 pass. Left alone (out of scope); a later ticket
  should import it.

## Bench
In the ticket Comments (commit cde06ac). No change beyond noise, as
expected: the bench times an empty path commit, which never calls the
three helpers. The first pair of runs was too noisy (+-49% baseline);
recorded the second pair. Ticket 04 is where the bench should move.

## AGENTS.md
Write-site list now names carryTreeHashes and the rule that its
changed-leaf list must cover every node the helper wrote.

## Final gates
typecheck 0, Worker typecheck 0, test:checks 0, npm test 54397/54397
rc 0, test:browser 50329/50329 rc 0. check:style rc 1 only on
pre-existing entries (stale WHOLE_FILE list, long lines in
.scratch/upstream-sync-2026-10*/learnings.md and progress.md), the same
ones tickets 02/12/13 recorded; no violation in a file this ticket
touched. So the last checklist item stays unchecked.

---
<!-- nightralph:entry ticket=upstream-sync-2026-10-tree-hash-cache:4 attempt=1 outcome=done -->
## 2026-10-27 09:16 -- upstream-sync-2026-10-tree-hash-cache/04 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $2.37. Checked items: "A sequence of path commits from different members, each processed by all others, keeps every member at the same epoch authenticator, and every member can decrypt every other.", "An external join, and an external resync that replaces the joiner's former leaf, are each processed by every existing member, and the group agrees on the next epoch.", "A member structured-cloned between two path commits agrees with the original on every later epoch authenticator.", "A received UpdatePath whose parent hash does not match is still refused with the same error class as today.", "The scenario suite, the ticket 01 suite and every RFC 9420 vector pass unchanged.", "`npm run bench` before and after the change is recorded in this ticket's Comments, with the `createCommit` and `processMessage` rows at 1024 members called out. No test asserts on timing.".

### Agent notes
# 04-carry-cache-through-update-paths notes

## Implemented
- src/update-path.ts: createUpdatePath and applyUpdatePath call
  `carryTreeHashes(input, copy, [senderLeafIndex])` right after the
  `slice()`, before any `calculateParentHash`. Covers createCommit's
  send path, joinGroupExternal (its tree comes through
  removeLeafNode/addLeafNode, which carry already), the member receive
  path, and the external receive branch (addLeafNode then
  applyUpdatePath(..., true)). No change needed in create-commit.ts or
  process-messages.ts.
- test/scenario/carry-cache-through-update-paths.ts (matrix.ts,
  sampleCiphersuites): path commits from every member with one cold
  restored receiver per commit plus a structured clone ("shadow") that
  follows every later commit beside its original; external join +
  resync (sameSignerKeyPackage) processed by everyone, each followed by
  a path commit; a forged commit whose committer's tree has node 5's
  parentHash overwritten (fresh array, so the committer hashes it
  honestly) is refused by every receiver with ValidationError, with an
  in-suite honest control afterwards.
- TDD: the suite is a characterization test (passed on old code; the
  cache is invisible). Mutation check: carrying with `[]` (keeping the
  direct path's stale hashes) on the send side alone, and on the
  receive side alone, each fails the suite (CryptoVerificationError).
- Ticket Comments: two before/after bench pairs. 1024 members:
  processMessage 107.6->78.5 and 112.3->68.5 ms; createCommit
  214.6->199.6 and 220.3->165.6 ms. The bench group is Add-only built,
  so path commits encrypt to ~n leaves; that dominates createCommit.
- AGENTS.md write-site note updated.

## Observations
- test/scenario/seeded-agreement.ts (ticket 01 suite) is still not
  imported from test/matrix.ts; ran it by hand: 240/240.
- First commit had a typecheck error in the test (MLSMessage not
  narrowed); fixed in the next commit. Run typecheck before commit.

## Final gates
typecheck 0, Worker typecheck 0, test:checks 0, npm test 57713/57713
rc 0, test:browser 53633/53633 rc 0. check:style rc 1 only on the
pre-existing entries (stale WHOLE_FILE list; long lines in
.scratch/upstream-sync-2026-10/learnings.md and progress.md), the same
ones tickets 02/03/12/13 recorded; nothing in a file this ticket
touched. So the last checklist item stays unchecked.

---
