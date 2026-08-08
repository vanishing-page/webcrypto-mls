# Validate Persisted Records at Restore Time -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On page load, the persistence demo drops (and deletes from
indexedDB) any saved member record that no longer describes a member of
the current group, so a stale "zombie" record can never be restored as
an in-group member again.

**Architecture:** A new pure function `partitionRestorableRecords` in
`example/persistence-storage.ts` picks the highest-epoch record as the
authoritative view of the group and classifies every record against its
ratchet tree. `restoreFromStorage` in `example/persistence-demo.ts` then
restores only the restorable records, deletes the stale ones from
indexedDB, and reports what it dropped in the status line. The
classification logic is pure and unit tested in Node, matching the
existing `partitionPersistedNames` pattern.

**Tech Stack:** TypeScript, @preact/signals, tapzero tests bundled with
esbuild (`npm test`), indexedDB (browser only, kept out of the pure
function).

## Background (why)

Incident diagnosed on 2026-07-25: the demo's indexedDB contained a
record for Bob frozen at epoch 2 with `groupActiveState: 'active'`,
while every other record was at epoch 7 and their trees showed Bob's
leaf 2 blanked and reused by Eloise. Bob was removed at epoch 3 while
commit `5883cfb` was running -- at that commit `syncPersistedMembers`
skipped members without state instead of deleting their records. The
cleanup added later (`partitionPersistedNames` + `deleteMember`) only
covers removals that happen during a session; a pre-existing stale
record is restored with state on every load, so it is filed under
"save" forever. Nothing validates a restored record against the group.

## Validation rule

Given all loaded records:

1. No records: nothing to restore, nothing stale.
2. The **authoritative record** is the one with the highest
   `state.groupContext.epoch` (bigint comparison; first record wins a
   tie -- records at the same epoch agree on the tree). Note this is
   deliberately destructive across groups: if records from more than
   one group ever coexist (only possible via bugs or manual edits --
   the demo runs a single group), the group containing the
   highest-epoch record survives and every other group's records are
   deleted.
3. A record is **restorable** iff all of:
   - `state.groupActiveState.kind === 'active'`
   - its `state.groupContext.groupId` is byte-equal to the
     authoritative record's groupId
   - the authoritative tree still has a leaf node at the record's own
     `privatePath.leafIndex`, and that leaf's identity equals the
     identity at the same leaf in the record's own tree
4. Everything else is **stale**: excluded from restore and deleted
   from indexedDB.

A member whose epoch merely lags the authoritative epoch but whose leaf
still holds their credential stays restorable -- lag alone is not
grounds for dropping (rule 3 keeps them; there is a test pinning this).

Leaf identity: for a `basic` credential, the credential's `identity`
bytes; otherwise the leaf's `signaturePublicKey`. `constantTimeEqual`
(src/util/constant-time-compare.ts) already returns false for
different-length inputs.

## Global Constraints

- TypeScript style: no space around type colons (`name:string`), max 80
  columns, ternaries formatted `cond ?` / `value :` / `value`.
- No em dashes or `->` arrows in docs or comments; use `--` and `->`.
- Tests: tapzero, run with `npm test`. Do not test for specific UI text
  content in HTML.
- `test/index.ts` already imports
  `./example/persistence-storage.js`; no test-registry change needed.
- Deep imports from `../src/...` are the established pattern in
  `example/` (see `example/tree-view.ts`).
- NEVER run manual browser verification against
  `http://localhost:1234` -- that origin holds the user's real demo
  data. Use `http://127.0.0.1:1234` (same dev server, separate origin,
  separate indexedDB).
- Batch sequential signal writes with `batch()` from @preact/signals.

## File Structure

- Modify `example/persistence-storage.ts` -- add `leafIdentity`
  (private helper) and `partitionRestorableRecords` (exported pure
  function). This file already holds the pure persistence helpers.
- Modify `example/persistence-demo.ts` -- `restoreFromStorage` (lines
  ~134-148) filters through the new function, deletes stale records,
  and reports drops.
- Modify `test/example/persistence-storage.ts` -- add fixture helpers
  and tests for the new function.

---

### Task 1: `partitionRestorableRecords` pure function

**Files:**
- Modify: `example/persistence-storage.ts`
- Test: `test/example/persistence-storage.ts`

**Interfaces:**
- Consumes: `PersistedMember` (already exported from
  `example/persistence-storage.ts`), `constantTimeEqual` from
  `../src/util/constant-time-compare.js`, `toLeafIndex` and
  `leafToNodeIndex` from `../src/treemath.js`, `Node` type from
  `../src/ratchet-tree.js`.
- Produces:
  `partitionRestorableRecords(records:PersistedMember[]):
  { restorable:PersistedMember[]; stale:PersistedMember[] }` --
  Task 2 imports this from `./persistence-storage.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/example/persistence-storage.ts`. Add
`partitionRestorableRecords` to the existing import from
`../../example/persistence-storage.js`.

```ts
function leaf (name:string):any {
    return {
        nodeType: 'leaf',
        leaf: {
            credential: {
                credentialType: 'basic',
                identity: new TextEncoder().encode(name)
            }
        }
    }
}

// Leaves at even node indices with parent slots left undefined, the
// same shape as a real RatchetTree. `null` marks a blank (removed)
// leaf.
function tree (names:(string|null)[]):any[] {
    const nodes:any[] = []
    for (const [i, name] of names.entries()) {
        if (i > 0) nodes.push(undefined)
        nodes.push(name === null ? undefined : leaf(name))
    }
    return nodes
}

function record (opts:{
    name:string;
    epoch:bigint;
    leafIndex:number;
    treeNames:(string|null)[];
    groupId?:Uint8Array;
    active?:boolean;
}):PersistedMember {
    return {
        name: opts.name,
        state: {
            groupContext: {
                epoch: opts.epoch,
                groupId: opts.groupId ?? new Uint8Array([1, 2, 3])
            },
            privatePath: { leafIndex: opts.leafIndex },
            ratchetTree: tree(opts.treeNames),
            groupActiveState: {
                kind: opts.active === false ?
                    'removedFromGroup' :
                    'active'
            }
        } as any
    }
}

test('partitionRestorableRecords keeps consistent records', (t) => {
    const names = ['Alice', 'Carl']
    const alice = record({
        name: 'Alice', epoch: 7n, leafIndex: 0, treeNames: names
    })
    const carl = record({
        name: 'Carl', epoch: 7n, leafIndex: 1, treeNames: names
    })

    const { restorable, stale } =
        partitionRestorableRecords([alice, carl])

    t.deepEqual(restorable.map((r) => r.name), ['Alice', 'Carl'],
        'both current members are restorable')
    t.deepEqual(stale, [], 'nothing is stale')
})

test('partitionRestorableRecords returns empty results for no records',
    (t) => {
        const { restorable, stale } = partitionRestorableRecords([])
        t.deepEqual(restorable, [], 'nothing to restore')
        t.deepEqual(stale, [], 'nothing stale')
    }
)

test('partitionRestorableRecords drops a zombie whose leaf was reused',
    (t) => {
        // Mirrors the 2026-07-25 incident: Bob was removed at epoch 3
        // and Eloise reused his leaf, but a legacy record still says
        // Bob is active at epoch 2.
        const current = ['Alice', 'Carl', 'Eloise', 'Fran']
        const alice = record({
            name: 'Alice', epoch: 7n, leafIndex: 0, treeNames: current
        })
        const bob = record({
            name: 'Bob',
            epoch: 2n,
            leafIndex: 2,
            treeNames: ['Alice', 'Carl', 'Bob', null]
        })
        const carl = record({
            name: 'Carl', epoch: 7n, leafIndex: 1, treeNames: current
        })

        const { restorable, stale } =
            partitionRestorableRecords([alice, bob, carl])

        t.deepEqual(restorable.map((r) => r.name), ['Alice', 'Carl'],
            'current members are restorable')
        t.deepEqual(stale.map((r) => r.name), ['Bob'],
            'the zombie record is stale')
    }
)

test('partitionRestorableRecords keeps a lagging member whose leaf ' +
    'is intact', (t) => {
    const alice = record({
        name: 'Alice',
        epoch: 7n,
        leafIndex: 0,
        treeNames: ['Alice', 'Carl', 'Eloise', 'Fran']
    })
    // Carl lags at epoch 5 and his tree still contains a member that
    // has since been removed, but his own leaf still holds his
    // credential in the authoritative tree.
    const carl = record({
        name: 'Carl',
        epoch: 5n,
        leafIndex: 1,
        treeNames: ['Alice', 'Carl', 'Bob', null]
    })

    const { restorable, stale } =
        partitionRestorableRecords([alice, carl])

    t.deepEqual(restorable.map((r) => r.name), ['Alice', 'Carl'],
        'lag alone is not grounds for dropping a record')
    t.deepEqual(stale, [], 'nothing is stale')
})

test('partitionRestorableRecords drops removedFromGroup, foreign, ' +
    'and out-of-range records', (t) => {
    const names = ['Alice', 'Carl']
    // Alice has the highest epoch so she is the authority, even
    // though the foreign-group record below carries a higher epoch
    // in its own (different) group.
    const alice = record({
        name: 'Alice', epoch: 10n, leafIndex: 0, treeNames: names
    })
    const removed = record({
        name: 'Dana',
        epoch: 7n,
        leafIndex: 1,
        treeNames: names,
        active: false
    })
    const foreign = record({
        name: 'Evan',
        epoch: 9n,
        leafIndex: 0,
        treeNames: ['Evan'],
        groupId: new Uint8Array([9, 9, 9])
    })
    const outOfRange = record({
        name: 'Fern',
        epoch: 3n,
        leafIndex: 5,
        treeNames: ['Alice', 'Carl', 'x', 'x', 'x', 'Fern']
    })

    const { restorable, stale } = partitionRestorableRecords(
        [alice, removed, foreign, outOfRange]
    )

    t.deepEqual(restorable.map((r) => r.name), ['Alice'],
        'only the active, same-group, in-tree record is restorable')
    t.deepEqual(stale.map((r) => r.name).sort(),
        ['Dana', 'Evan', 'Fern'],
        'removed, foreign-group, and out-of-range records are stale')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL -- `partitionRestorableRecords` is not exported (bundle
error or TypeError).

- [ ] **Step 3: Implement the function**

In `example/persistence-storage.ts`, add imports at the top (keep the
existing ones):

```ts
import { toLeafIndex, leafToNodeIndex } from '../src/treemath.js'
import {
    constantTimeEqual
} from '../src/util/constant-time-compare.js'
import type { Node } from '../src/ratchet-tree.js'
```

Add below `partitionPersistedNames`:

```ts
/**
 * The identity bytes a tree leaf asserts: the basic credential's
 * identity, or the leaf's signature public key for other credential
 * types. Null for a blank position or a parent node.
 */
function leafIdentity (node:Node|undefined):Uint8Array|null {
    if (!node || node.nodeType !== 'leaf') return null
    const cred = node.leaf.credential
    return cred.credentialType === 'basic' ?
        cred.identity :
        node.leaf.signaturePublicKey
}

/**
 * Classify persisted records against the highest-epoch record's view
 * of the group. A record is only restorable if it is still `active`,
 * belongs to the same group, and its own leaf in the authoritative
 * tree still holds its identity. Anything else is a stale record --
 * for example a member removed while an older version of this page
 * was running, whose record was never deleted -- and restoring it
 * would show a zombie member, so the caller should delete it instead.
 */
export function partitionRestorableRecords (
    records:PersistedMember[]
):{ restorable:PersistedMember[]; stale:PersistedMember[] } {
    if (records.length === 0) return { restorable: [], stale: [] }

    let authority = records[0]
    for (const record of records) {
        if (record.state.groupContext.epoch >
            authority.state.groupContext.epoch) {
            authority = record
        }
    }

    const authorityTree = authority.state.ratchetTree
    const authorityGroupId = authority.state.groupContext.groupId

    const restorable:PersistedMember[] = []
    const stale:PersistedMember[] = []

    for (const record of records) {
        const { state } = record
        const nodeIndex = leafToNodeIndex(
            toLeafIndex(state.privatePath.leafIndex)
        )
        const own = leafIdentity(state.ratchetTree[nodeIndex])
        const current = leafIdentity(authorityTree[nodeIndex])

        const isMember =
            state.groupActiveState.kind === 'active' &&
            constantTimeEqual(
                state.groupContext.groupId,
                authorityGroupId
            ) &&
            own !== null &&
            current !== null &&
            constantTimeEqual(own, current)

        if (isMember) restorable.push(record)
        else stale.push(record)
    }

    return { restorable, stale }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all new tests plus the existing suite).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: clean. Fix any 80-column or style complaints in the new
code.

- [ ] **Step 6: Commit**

```bash
git add example/persistence-storage.ts test/example/persistence-storage.ts
git commit -m "feat: classify persisted records against the group at restore time

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire validation into `restoreFromStorage`

**Files:**
- Modify: `example/persistence-demo.ts` (function `restoreFromStorage`,
  currently lines ~134-148, plus the import block from
  `./persistence-storage.js`)

**Interfaces:**
- Consumes: `partitionRestorableRecords` from Task 1;
  `deleteMember(groupIdB64, name)`, `loadAllMembers()`,
  `restoredUsersFromRecords(records)` (all already imported);
  `bytesToBase64url` (already imported from `../src/index.js`).
- Produces: no new exports. Behavior change only.

- [ ] **Step 1: Update the import**

In `example/persistence-demo.ts`, add `partitionRestorableRecords` to
the existing import from `./persistence-storage.js`.

- [ ] **Step 2: Replace `restoreFromStorage`**

```ts
async function restoreFromStorage ():Promise<void> {
    const records = await loadAllMembers()
    if (records.length === 0) return

    const { restorable, stale } = partitionRestorableRecords(records)

    // A stale record describes someone who is no longer a member of
    // the current group (for example a member removed while an older
    // version of this page was running, before removed members'
    // records were deleted). Restoring it would show a zombie member,
    // so delete it instead. The record's own groupId reproduces the
    // key it was saved under.
    for (const record of stale) {
        await deleteMember(
            bytesToBase64url(record.state.groupContext.groupId),
            record.name
        )
    }

    if (restorable.length === 0) return

    const { users, groupId } = restoredUsersFromRecords(restorable)

    const droppedNote = stale.length > 0 ?
        ` (dropped ${stale.length} stale record(s): ` +
            stale.map((r) => r.name).join(', ') + ')' :
        ''

    batch(() => {
        state.users.value = new Map([...state.users.value, ...users])
        state.groupId.value = groupId
        state.status.value = 'Restored ' +
            `${restorable.length} member(s) from indexedDB` +
            droppedNote
        persistedNames.value = new Set(restorable.map((r) => r.name))
        restoredFromStorage.value = true
    })
}
```

Behavior notes the implementer must preserve:
- `persistedNames` is built from `restorable` only, so a dropped
  record can never be re-saved by `syncPersistedMembers`.
- If every record is stale, the function deletes them and returns
  without touching signals -- the page then behaves like a fresh
  visit (`restoredFromStorage` stays false).

- [ ] **Step 3: Run the full test suite and lint**

Run: `npm test && npm run lint`
Expected: PASS / clean. (There is no unit test for this wiring --
`restoreFromStorage` is module-level browser code using indexedDB,
same as before. The logic lives in the pure function tested in
Task 1.)

- [ ] **Step 4: Manual browser verification (sandbox origin only)**

With the dev server running (it serves on port 1234), use
`http://127.0.0.1:1234/persistence` -- NOT localhost, which holds the
user's real demo data. The two hostnames are different origins with
separate indexedDB.

1. Open `http://127.0.0.1:1234/persistence`.
2. Create Alice, Bob, Carl; Start group as Alice; Alice adds Carl;
   Alice adds Bob; click persist on all three.
3. In DevTools console, save a copy of Bob's record:

```js
const db = await new Promise((res, rej) => {
    const open = indexedDB.open('mls-persistence-demo', 1)
    open.onsuccess = () => res(open.result)
    open.onerror = () => rej(open.error)
})
const all = await new Promise((res) => {
    const tx = db.transaction('members', 'readonly')
    const keys = tx.objectStore('members').getAllKeys()
    const vals = tx.objectStore('members').getAll()
    tx.oncomplete = () => res({ keys: keys.result, vals: vals.result })
})
const i = all.keys.findIndex((k) => k.endsWith(':Bob'))
window.zombie = { key: all.keys[i], val: all.vals[i] }
```

4. Click "Alice removes Bob" (current code clears his state and
   deletes his record).
5. Re-insert the saved record to simulate the legacy zombie:

```js
await new Promise((res) => {
    const tx = db.transaction('members', 'readwrite')
    tx.objectStore('members').put(window.zombie.val, window.zombie.key)
    tx.oncomplete = () => res()
})
```

6. Reload the page. Expected: Bob is NOT restored as an in-group
   member (a "Create Bob" button is available instead), the tree has
   no Bob, and the status line notes 1 dropped stale record.
7. Reload once more. Expected: no dropped-record note (the stale
   record was deleted on the previous load).
8. Clean up the sandbox: click Reset on the 127.0.0.1 page.

9. Optional, fixes the real data from the 2026-07-25 incident: open
   `http://localhost:1234/persistence` and confirm the zombie Bob row
   is gone after one reload. Do not click Reset there.

- [ ] **Step 5: Commit**

```bash
git add example/persistence-demo.ts
git commit -m "fix: drop stale indexedDB records when restoring the persistence demo

A record whose member is no longer in the group (removed while an
older version of the page was running) was restored as a zombie
member on every load. Restore now validates each record against the
highest-epoch record's ratchet tree and deletes the ones that no
longer describe a member.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (noted during diagnosis, separate work)

- The empty `catch {}` blocks in `addUserToGroup` /
  `removeUserFromGroup` fan-out swallow per-member processing errors;
  at minimum they should surface a debug log.
- The user list renders "In group (Epoch:N)" from `user.state` alone,
  ignoring `groupActiveState` and group consistency.
- `leafNames` in `persistence-demo.ts` keys the tree labels by each
  user's self-reported leaf index, so two states claiming the same
  leaf silently overwrite each other in the diagram.
- Cross-tab races: a second open tab can re-save records for members
  the first tab has removed (last-writer-wins). Restore-time
  validation makes this self-healing on next load, but live cross-tab
  sync (BroadcastChannel or storage events) is not addressed.
