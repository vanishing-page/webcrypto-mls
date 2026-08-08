# Realistic Demo Implementation Plan -- Phase 7: Join, approval, membership, and removal

**Goal:** The full two-party choreography, including both directions of
absence.

**Architecture:** A stranger opens a room URL, makes a user, and publishes
a join request. The creator sees it, decodes the key package to learn the
name, commits an Add, and sends the commit, the Welcome and the approval
in that order. Membership and epoch are read from the client's own ratchet
tree, never from the server -- the server's `roster` supplies only the
connected and disconnected marks. Removal is creator-only, and that rule
is enforced in this interface with nothing cryptographic behind it, which
the page says out loud.

**Tech Stack:** preact + htm, `@preact/signals`, the repository's MLS
library.

**Scope:** Phase 7 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### realistic-demo.AC3: Asking to join works across absence
- **realistic-demo.AC3.1 Success:** Opening a room URL without a local
  user shows the name field; creating a user there publishes a
  `join-request` and shows the waiting state
- **realistic-demo.AC3.2 Success:** A `welcome-you` joins the group from
  the Welcome and adopts its `cursor` and `priorCount`
- **realistic-demo.AC3.4 Success:** A Welcome issued while its recipient
  is offline is delivered on their next connect

### realistic-demo.AC4: Approval, denial, and the identity ledger
- **realistic-demo.AC4.1 Success:** Approving commits an Add and sends
  `mls{commit}`, then `welcome`, then `approve`, in that order, and the
  newcomer joins
- **realistic-demo.AC4.2 Success:** A `pre-approved` request is committed
  with no prompt while the creator is connected

### realistic-demo.AC5: Membership, liveness, and removal
- **realistic-demo.AC5.1 Success:** The member list and epoch are derived
  from the client's own ratchet tree and update on every processed
  commit, whether it arrived live or in a replay batch
- **realistic-demo.AC5.2 Success:** A member whose socket has dropped is
  marked disconnected and is not removed from the group
- **realistic-demo.AC5.3 Success:** Only the creator's client renders a
  Remove control
- **realistic-demo.AC5.4 Success:** Removing commits a Remove and sends
  `removed`; the epoch advances and that leaf blanks
- **realistic-demo.AC5.5 Success:** A removed member's own page reports
  the removal rather than failing to process the commit

**How these are verified.** Membership derivation is pure once the
ratchet tree is in hand, so `membersFromTree` is extracted and unit
tested, covering realistic-demo.AC5.1's derivation and the blank-leaf
half of realistic-demo.AC5.4. Everything else needs two real browsers and
is verified manually in Task 6, which the design anticipates: "verified
with two browser profiles".

---

## Codebase verification findings

**How a key package crosses the wire.** `mls_key_package` is a valid
`MLSMessage` wireformat (`src/message.ts:36`, `:57`, `:99`), so a key
package is serialized with the same `encodeMlsMessage` /
`decodeMlsMessage` pair as everything else. `decodeKeyPackage` itself is
not exported from `src/index.ts`; do not reach into `src/key-package.ts`
for it.

**Ratchet tree access.** `src/index.ts` exports the `RatchetTree` **type
only** (`src/index.ts:15`). The helpers `getCredentialFromLeafIndex` and
`getSignaturePublicKeyFromLeafIndex` exist in `src/ratchet-tree.ts` but
are **not** exported from the package entry, so the client walks the tree
itself rather than importing them.

The shape is:

```ts
type Node = { nodeType:'parent'; parent:ParentNode }
    | { nodeType:'leaf'; leaf:LeafNode }
type RatchetTree = (Node | undefined)[]
```

Leaves sit at **even** node indices, so `leafIndex === nodeIndex / 2`. A
**blanked leaf is `undefined`** at its position. (An earlier reading that
a blanked leaf presents as `nodeType === 'parent'` is wrong; blanking
clears the slot.) A `LeafNode` carries `credential` and
`signaturePublicKey`.

**Commit APIs**, from `src/create-commit.ts` and the reference usage in
`example/demo-actions.ts`:

- `createCommit({ state, cipherSuite }, options)` returns
  `{ newState:ClientState; welcome:Welcome|undefined; commit:MLSMessage }`.
- Add: `extraProposals: [{ proposalType:'add', add:{ keyPackage } }]`
  with `wireAsPublicMessage: true` and `ratchetTreeExtension: true`.
- Remove: `extraProposals: [{ proposalType:'remove',
  remove:{ removed: leafIndex } }]` with the same two options. The target
  is a **leaf index**, not a credential or a key.
- `joinGroup(welcome, keyPackage, privateKeys, makePskIndex(undefined,
  {}), cs)` returns a `ClientState`. The ratchet tree rides inside the
  Welcome when `ratchetTreeExtension` was set, so the separate
  `ratchetTree` argument is not needed.
- `processMessage(message, state, pskIndex, action, cs)` returns either
  `{ kind:'newState', newState, actionTaken }` or
  `{ kind:'applicationMessage', message, newState }`.
- `state.groupActiveState` is
  `{ kind:'active' } | { kind:'suspendedPendingReinit', reinit } |
  { kind:'removedFromGroup' }`. Processing one's own Remove commit
  returns a state whose kind is `removedFromGroup` -- a normal outcome,
  not an error.

Phase 6 is confirmed to provide `state.ts`, `mls-actions.ts`,
`delivery-client.ts`, `delivery-cursor.ts`, `entry-queue.ts`,
`views/setup.ts`, a minimal `views/room.ts`, and `client/index.ts`.

## External dependency findings

N/A -- this phase adds no dependency.

---

## Commands used throughout this phase

- **Root typecheck:**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Two-process dev:** `npm run worker:dev` and `npm run dev:realistic`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Derive membership from the ratchet tree

**Verifies:** None directly -- Task 2 tests this.

**Files:**
- Create: `example-realistic-demo/client/membership.ts`

The room cannot know the group roster, because it never parses a commit.
So the page reads its member list from its own tree. Keeping that
derivation in a pure module is what makes it testable without a group.

**Step 1: Create the module**

```ts
import type { RatchetTree } from '../../src/index.js'
import { bytesToBase64url } from '../../src/index.js'

/**
 * A member as the page shows them. `identity` matches what the room
 * uses on the wire, so the roster's connected marks can be joined
 * against this list -- but the list itself comes from the tree, not
 * from the room.
 */
export interface Member {
    leafIndex:number
    identity:string
    name:string
}

/**
 * Every occupied leaf, in leaf order.
 *
 * Leaves live at even node indices, so a leaf index is half its node
 * index. A removed member's leaf is blanked rather than deleted, which
 * is why a gap in this list is expected and why the array is not
 * compacted -- the leaf indices remain meaningful for a later Remove.
 */
export function membersFromTree (tree:RatchetTree):Member[] {
    const members:Member[] = []
    const decoder = new TextDecoder()

    for (let node = 0; node < tree.length; node = node + 2) {
        const entry = tree[node]
        if (!entry || entry.nodeType !== 'leaf') continue

        const leaf = entry.leaf
        const credential = leaf.credential
        const name = credential.credentialType === 'basic' ?
            decoder.decode(credential.identity) :
            '(non-basic credential)'

        members.push({
            leafIndex: node / 2,
            identity: bytesToBase64url(leaf.signaturePublicKey),
            name
        })
    }

    return members
}

/**
 * The leaf index to name in a Remove proposal. Returns null when the
 * identity is not in the tree, which is what a already-removed member
 * looks like.
 */
export function leafIndexOf (
    tree:RatchetTree,
    identity:string
):number|null {
    const found = membersFromTree(tree)
        .find(member => member.identity === identity)
    return found ? found.leafIndex : null
}
```

**Step 2: Do not commit yet**
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test membership derivation

**Verifies:** realistic-demo.AC5.1 (derivation), realistic-demo.AC5.4
(blank leaf)

**Files:**
- Create: `test/example-realistic-demo/membership.ts` (unit)
- Modify: `test/index.ts`

**Step 1: Register**

Add `import './example-realistic-demo/membership.js'` to the
`// Realistic demo tests` block.

**Step 2: Write the tests**

Build `RatchetTree` fixtures by hand as plain arrays -- no group, no
crypto, no async. A leaf node fixture needs only `credential` and
`signaturePublicKey` for these functions; construct the minimum the type
requires.

Tests must verify:

- A single-leaf tree yields one member with `leafIndex` 0 and the name
  decoded from the basic credential's `identity` bytes.
- A three-leaf tree yields three members with leaf indices 0, 1, 2, taken
  from node indices 0, 2, 4 -- proving the even-index rule rather than
  reading every array slot.
- **Parent nodes are skipped.** A tree with parent nodes at odd indices
  must not produce members for them.
- **A blanked leaf is skipped.** Set an even index to `undefined` and
  assert that member is absent while the remaining leaf indices are
  **unchanged** -- the surviving members keep their original indices
  rather than being renumbered. This is realistic-demo.AC5.4's "that leaf
  blanks", and renumbering would silently retarget a later Remove at the
  wrong person.
- An empty tree yields an empty array.
- `identity` is the base64url of the leaf's `signaturePublicKey`, so it
  matches what the room uses on the wire.
- `leafIndexOf` finds a present identity, returns its correct index, and
  returns `null` for an identity that is absent or has been blanked.

**Step 3: Run**

```bash
npm test
npm run lint
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

Expected: all pass, count up.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: derive group membership from the client ratchet tree"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: The join path and the waiting view

**Verifies:** realistic-demo.AC3.1, realistic-demo.AC3.2,
realistic-demo.AC3.4 (all confirmed in Task 6)

**Files:**
- Modify: `example-realistic-demo/client/mls-actions.ts`
- Create: `example-realistic-demo/client/views/waiting.ts`
- Modify: `example-realistic-demo/client/index.ts`

**Step 1: Add key package serialization to `mls-actions.ts`**

```ts
/**
 * A key package on the wire. Uses the same MLSMessage encoding as every
 * other payload rather than a bespoke format -- `mls_key_package` is a
 * wireformat the library already round-trips.
 */
export function encodeKeyPackageB64 (keyPackage:KeyPackage):string {
    return bytesToBase64(encodeMlsMessage({
        wireformat: 'mls_key_package',
        version: 'mls10',
        keyPackage
    }))
}

export function decodeKeyPackageB64 (payload:string):KeyPackage|null {
    const decoded = decodeMlsMessage(base64ToBytes(payload), 0)
    if (!decoded) return null
    const msg = decoded[0]
    return msg.wireformat === 'mls_key_package' ? msg.keyPackage : null
}

/**
 * Join from a Welcome. The ratchet tree rides inside the Welcome
 * because the committer set `ratchetTreeExtension`, so it is not passed
 * separately here.
 */
export async function joinFromWelcome (
    payload:string,
    user:DemoUser,
    cs:CiphersuiteImpl
):Promise<ClientState> {
    if (!user.keyPackage || !user.privateKeys) {
        throw new Error('user has no key package')
    }

    const decoded = decodeMlsMessage(base64ToBytes(payload), 0)
    if (!decoded || decoded[0].wireformat !== 'mls_welcome') {
        throw new Error('not a welcome')
    }

    return joinGroup(
        decoded[0].welcome,
        user.keyPackage,
        user.privateKeys,
        makePskIndex(undefined, {}),
        cs
    )
}
```

Imports for this step, noting the split established in Phase 6:

- From `../../src/index.js`: `joinGroup`, `makePskIndex`,
  `decodeMlsMessage`, `encodeMlsMessage`, `bytesToBase64`.
- From `../../src/util/byte-array.js`: `base64ToBytes`. It is **not**
  re-exported from `src/index.ts`, which exports only the two encoders.

The Welcome wireformat is `mls_welcome`, verified at `src/message.ts:24`.
Use it directly.

**Step 2: Write `views/waiting.ts`**

Shows that the request is published and the person is waiting. It must
render the room URL, the name they chose, and a plain statement that the
room's creator has to approve them and that it is fine to close the tab
-- the request survives, which is the point of realistic-demo.AC3.3.

**Step 3: Wire the join path in `index.ts`**

When the path is a valid room id and there is no local group:

1. Probe `GET /api/room/<id>`. A 404 sets `roomMissing` for the `gone`
   view. This is why the probe exists at all -- without it the page would
   need an identity-less socket state, since `hello` carries an identity.
2. A 200 with no local user shows the setup view's name field, which is
   realistic-demo.AC3.1's first half.
3. On submit, create the user and call `delivery.connect(roomId)`.
   **Do not send anything here** -- the socket is still CONNECTING.
   Phase 6's `onOpen` sends `hello`; extend it so that when this client
   has a key package but no group, it follows `hello` with
   `{ type:'join-request', identity, keyPackage }`, the key package
   encoded by `encodeKeyPackageB64`. Then show the waiting view. That is
   realistic-demo.AC3.1's second half.

   Publishing the request from `onOpen` rather than from the submit
   handler also makes it survive a reconnect for free: the room's
   `pending.identity` primary key means re-publishing replaces rather
   than duplicates.
4. Extend Phase 6's `onControl` to handle `welcome-you`: call
   `joinFromWelcome`, then in one `batch` set `group`, adopt `cursor`
   from the message, adopt `priorCount` from the message, and clear any
   waiting status. **Adopt both values from the message rather than
   computing them** -- the room stamped them, and recomputing locally is
   how they drift. This is realistic-demo.AC3.2.

   **`onControl` must return the promise for this branch**, not fire and
   forget. Phase 6's connection holds the `log` batch that follows a
   Welcome until that promise settles, then flushes it into the queue.
   Returning nothing makes the hold release immediately, and the joiner
   silently loses every message sent while it was away -- which is
   realistic-demo.AC3.4 and realistic-demo.AC6.2 failing together.

   So the handler is `async` and its promise is returned:

   ```ts
   async function onControl (msg:RoomMessage):Promise<void> {
       if (msg.type !== 'welcome-you') return
       const group = await joinFromWelcome(msg.payload, user, cs)
       batch(() => {
           state.group.value = group
           state.cursor.value = msg.cursor
           state.priorCount.value = msg.priorCount
           state.status.value = 'Joined'
       })
   }
   ```

   Let a failure reject rather than swallowing it -- Phase 6's rejection
   path discards the held entries and reports it, which is correct.
   Applying a replay to a group that was never constructed is not.
5. Because the mailbox delivers on connect, step 4 is reached whether the
   Welcome was issued while this client was connected or while it was
   away. No separate code path is needed for
   realistic-demo.AC3.4.

**Step 4: Typecheck, lint**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

**Step 5: Do not commit yet**

A join with nobody able to approve it is not a milestone. Task 4 adds
approval.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Approval and the pending list

**Verifies:** realistic-demo.AC4.1, realistic-demo.AC4.2 (both confirmed
in Task 6)

**Files:**
- Modify: `example-realistic-demo/client/mls-actions.ts`
- Modify: `example-realistic-demo/client/views/room.ts`

**Step 1: Add the Add-commit action**

```ts
/**
 * Commit an Add. Returns the new state plus the two payloads the room
 * needs, already encoded -- the caller sends them in a fixed order and
 * must not reorder them.
 */
export async function commitAdd (
    state:ClientState,
    keyPackage:KeyPackage,
    cs:CiphersuiteImpl
):Promise<{
    newState:ClientState
    commit:string
    welcome:string
}> {
    const result = await createCommit(
        { state, cipherSuite: cs },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage } }
            ],
            wireAsPublicMessage: true,
            ratchetTreeExtension: true
        }
    )

    if (!result.welcome) {
        throw new Error('add commit produced no welcome')
    }

    return {
        newState: result.newState,
        commit: bytesToBase64(encodeMlsMessage(result.commit)),
        welcome: bytesToBase64(encodeMlsMessage({
            wireformat: 'mls_welcome',
            version: 'mls10',
            welcome: result.welcome
        }))
    }
}
```

The Welcome wireformat is `mls_welcome` (`src/message.ts:24`). Add
`createCommit` to the imports.

**Step 2: Render the pending list**

In `views/room.ts`, render `state.pending.value` only when
`state.isCreator.value` is true. For each request:

- Decode `request.keyPackage` with `decodeKeyPackageB64` and show the
  **credential name**. `Credential` is a union of `CredentialBasic` and
  `CredentialX509`, and `identity` exists only on the former, so narrow
  before reading it -- the same narrowing `membersFromTree` does:

  ```ts
  const credential = keyPackage.leafNode.credential
  const name = credential.credentialType === 'basic' ?
      new TextDecoder().decode(credential.identity) :
      '(non-basic credential)'
  ```

  Reading `credential.identity` without the narrowing is a TS2339. This
  is the only place a name is learned about someone not yet in the group
  -- the room never holds display names.
- Show the `standing`, with distinct treatment for
  `previously-removed`, since re-admitting someone previously removed is
  the decision most worth pausing over.
- Offer Approve and Deny.

**Step 3: Implement approve, in the required order**

```ts
// The order is not incidental and must not be rearranged.
//
// The commit goes first so it is in the log before the room stamps the
// Welcome's cursor -- the room sets that cursor to the current
// high-water seq, and one socket processes messages in order, so the
// commit is guaranteed to already be there. The approval goes last so
// the ledger only records an admission that actually happened.
const { newState, commit, welcome } = await commitAdd(group, kp, cs)

delivery.send({ type: 'mls', kind: 'commit', payload: commit })
delivery.send({ type: 'welcome', to: identity, payload: welcome })
delivery.send({ type: 'approve', identity })

state.group.value = newState
```

Apply the new state **after** the sends succeed. If a send fails because
the socket dropped, report it and do not advance the local group state,
or the creator ends up at an epoch nobody else reached.

Deny is a single `{ type:'deny', identity }`.

**Step 4: Auto-commit a pre-approved request**

When a `pending` message arrives and a request's `standing` is
`pre-approved`, run the same approve path with **no prompt**, provided
this client is the creator and connected. This is
realistic-demo.AC4.2. A `stranger` or `previously-removed` request always
prompts.

**Step 5: Typecheck and lint**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: join requests, approval and pre-approved auto-commit"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Membership display, removal, and the disclosures

**Verifies:** realistic-demo.AC5.1, realistic-demo.AC5.2,
realistic-demo.AC5.3, realistic-demo.AC5.4, realistic-demo.AC5.5 (all
confirmed in Task 6)

**Files:**
- Modify: `example-realistic-demo/client/views/room.ts`
- Modify: `example-realistic-demo/client/mls-actions.ts`
- Modify: `example-realistic-demo/client/index.ts`

**Step 1: Render members from the tree, liveness from the roster**

In `views/room.ts`, compute the member list as
`membersFromTree(state.group.value.ratchetTree)` and the epoch as
`state.group.value.groupContext.epoch`. Both are derived from local group
state on every render, so they update whenever `state.group` is
reassigned -- which happens on every processed commit, live or replayed.
That is realistic-demo.AC5.1, and it holds for a replay batch for free
because the entry queue reassigns `state.group` per entry.

Mark each member connected or disconnected by testing
`state.live.value.includes(member.identity)`. Present these as visibly
different kinds of information -- the member list is protocol state from
the ratchet tree, the marks are transport observation from the room.
Never let a disconnected mark look like absence from the group.

**Step 2: Add the disclosures (part of realistic-demo.AC10.6)**

Render, in plain language near the things they describe:

- That a disconnected member's leaf is **still in the ratchet tree**;
  they are away, not removed.
- That creator-only removal is a rule **this demo enforces in its own
  interface, with nothing cryptographic behind it**. Any member could
  commit a Remove; the room records what it is told and verifies none of
  it.

Phase 8 adds the remaining explainer copy.

**Step 3: Add the Remove action**

```ts
export async function commitRemove (
    state:ClientState,
    leafIndex:number,
    cs:CiphersuiteImpl
):Promise<{ newState:ClientState; commit:string }> {
    const result = await createCommit(
        { state, cipherSuite: cs },
        {
            extraProposals: [
                { proposalType: 'remove', remove: { removed: leafIndex } }
            ],
            wireAsPublicMessage: true,
            ratchetTreeExtension: true
        }
    )

    return {
        newState: result.newState,
        commit: bytesToBase64(encodeMlsMessage(result.commit))
    }
}
```

**Step 4: Render Remove for the creator only**

Render the Remove control only when `state.isCreator.value` is true, and
never against the creator's own leaf. `isCreator` is set from
`room-state.isCreator`, which the room computes from the creator token --
so a client that merely claims to be the creator does not get the
control. This is realistic-demo.AC5.3.

On Remove: resolve the target's `leafIndex` with `leafIndexOf`, call
`commitRemove`, send `{ type:'mls', kind:'commit', payload }` then
`{ type:'removed', identity }`, then apply the new state. The epoch
advances and the target's leaf blanks, which the member list reflects on
the next render. That is realistic-demo.AC5.4.

**Step 5: Handle being removed (realistic-demo.AC5.5)**

In the `applyEntry` function passed to `createConnection` (Phase 6,
Task 6), after a successful `processMessage` returning
`kind: 'newState'`, check the result:

```ts
if (result.newState.groupActiveState.kind === 'removedFromGroup') {
    batch(() => {
        state.group.value = result.newState
        state.removed.value = true
        state.status.value = 'You were removed from this room.'
    })
    delivery.close()
    return
}
```

Being removed is a **normal outcome, not an error**. The commit processed
successfully; the resulting state simply says the client is no longer a
member. It must never surface as a failed commit, and it must not stop
the queue via the error path -- the entry applied fine.

Render a clear removed state when `state.removed.value` is true.

**Step 6: Typecheck, lint, test, build**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
npm test
npm run build:realistic
```

Expected: all clean.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: membership display, creator-only removal and removed state"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Verify with two browser profiles

**Verifies:** realistic-demo.AC3.1, realistic-demo.AC3.2,
realistic-demo.AC3.4, realistic-demo.AC4.1, realistic-demo.AC4.2,
realistic-demo.AC5.1, realistic-demo.AC5.2, realistic-demo.AC5.3,
realistic-demo.AC5.4, realistic-demo.AC5.5

**Files:** None modified unless a defect is found.

Use two separate browser profiles, not two tabs, so the two clients have
genuinely separate storage. Call them **A** (creator) and **B**.

**Step 1: Start both processes**

```bash
npm run worker:dev
```

```bash
npm run dev:realistic
```

**Step 2: Both parties present (realistic-demo.AC3.1, AC4.1, AC5.1)**

1. In A, create a user and a room. Copy the room URL.
2. Open that URL in B. Confirm B sees a **name field**, not an error and
   not a chat pane.
3. Create a user in B. Confirm B shows the **waiting** state.
4. Confirm A shows a pending request with **B's display name**, decoded
   from the key package, and a standing of `stranger`.
5. Approve in A. In the devtools Network WS frames for A, confirm the
   three outbound frames appear in the order **`mls` (kind `commit`),
   then `welcome`, then `approve`**. Order matters; if `welcome` precedes
   the commit, the room stamps a cursor that excludes it.
6. Confirm B joins, and that B's `cursor` and `priorCount` match the
   `welcome-you` frame's values exactly (realistic-demo.AC3.2).
7. Confirm both A and B show the same member list, both names, and the
   **same epoch**, and that each derived it from its own tree.

**Step 3: Requester absent (realistic-demo.AC3.4)**

1. In a third profile C, open the room URL, create a user, and confirm
   the waiting state.
2. **Close C's tab entirely.**
3. In A, approve C's request.
4. Reopen the room URL in C. Confirm C receives the Welcome on connect
   and joins, without anyone re-approving.

**Step 4: Creator absent (realistic-demo.AC3.3 end to end)**

1. Close A's tab.
2. In a fourth profile D, open the room URL and request to join.
3. Reopen A. Confirm D's request is **still pending** and visible.

**Step 5: Pre-approved (realistic-demo.AC4.2)**

1. Have an already-admitted identity request again -- clear B's group
   state but keep its identity, or use a profile whose identity is
   already in the ledger as `admitted`.
2. With A connected, confirm the request is committed **with no prompt**
   and A never shows an Approve button for it.

**Step 6: Liveness (realistic-demo.AC5.2)**

1. With A and B both in the room, close B's tab.
2. In A, confirm B is marked **disconnected** and is **still listed as a
   member**, and that the epoch did **not** change. Nothing about a
   dropped socket touches the group.
3. Reopen B and confirm the mark clears.

**Step 7: Removal (realistic-demo.AC5.3, AC5.4, AC5.5)**

1. Confirm B does **not** render a Remove control anywhere, for anyone.
   This is realistic-demo.AC5.3 and it is a negative check -- look
   specifically.
2. In A, remove B. Confirm A's epoch **advances by one** and B's leaf is
   gone from A's member list, while the remaining members keep their leaf
   indices.
3. On B's own page, confirm it **reports the removal** in plain language.
   It must not show a failed-commit error, and the devtools console must
   show no uncaught exception. This is realistic-demo.AC5.5, and a
   console error here means the removal is being treated as a processing
   failure rather than as the normal outcome it is.

**Step 8: Replay applies commits too (realistic-demo.AC5.1, replay half)**

1. Close B's tab.
2. In A, add another member so a commit lands while B is away.
3. Reopen B. Confirm B's member list and epoch catch up to A's from the
   replay batch, with no manual refresh.

**Step 9: Stop both processes**

Stop the Vite server and `wrangler dev`. Do not leave either running.
<!-- END_TASK_6 -->

---

## Phase 7 completion checklist

- [ ] `membersFromTree` unit tested, including parent-node skipping and
      blanked leaves not renumbering survivors
- [ ] Opening a room URL with no user shows the name field
- [ ] Creating a user there publishes a `join-request` and shows waiting
- [ ] `welcome-you` adopts the room's `cursor` and `priorCount` verbatim
- [ ] Approve sends `mls{commit}`, `welcome`, `approve` in that order
- [ ] A Welcome issued while the recipient was offline is delivered on
      connect
- [ ] A request made while the creator was away is still pending
- [ ] `pre-approved` commits with no prompt
- [ ] Member list and epoch derived from the client's own ratchet tree,
      updating on live and replayed commits alike
- [ ] A dropped socket marks disconnected and changes no group state
- [ ] Remove renders only for the creator
- [ ] Remove advances the epoch and blanks the leaf
- [ ] A removed member's page reports it, with no console error
- [ ] Both disclosures rendered
- [ ] `npm test`, `npm run lint`, typecheck and build pass
- [ ] Both dev servers stopped
