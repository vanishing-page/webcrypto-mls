# Realistic Demo Implementation Plan -- Phase 8: Chat, persistence, gone state, explainer

**Goal:** Messaging with replay and honest placeholders, persistence as a
standing control, and the page saying what it demonstrates.

**Architecture:** The timeline is a pure fold from log entries plus locally
recorded plaintext to a list of renderable items, so the placeholder rules
are testable without a group. Persistence gains a second object store
beside the member store in one database, because a waiting joiner has keys
but no group state and `PersistedMember` requires state. Undecryptable
history renders as counted placeholders rather than errors, which is
honest: forward secrecy means an absent member genuinely cannot read some
of what they missed.

**Tech Stack:** preact + htm, `@preact/signals`, IndexedDB, the
repository's MLS library.

**Scope:** Phase 8 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### realistic-demo.AC6: Chat, replay, and undecryptable history
- **realistic-demo.AC6.1 Success:** A sent message is encrypted to the
  group and decrypted and displayed by other members
- **realistic-demo.AC6.2 Success:** Returning to a room replays messages
  sent while away, in order
- **realistic-demo.AC6.3 Success:** Entries before the member's join
  cursor render as a single placeholder stating how many there are
- **realistic-demo.AC6.4 Success:** Consecutive undecryptable entries
  after joining collapse into one counted placeholder
- **realistic-demo.AC6.5 Success:** A client's own past entries on replay
  render from locally recorded plaintext, not as decrypt failures
- **realistic-demo.AC6.6 Edge:** A member who joined at epoch zero sees
  no leading placeholder

### realistic-demo.AC7: Persistence is a standing control
- **realistic-demo.AC7.1 Success:** Persist is present before any user
  exists and remains present throughout
- **realistic-demo.AC7.2 Success:** Turning it on writes whatever state
  exists: user, group state if any, room id, cursor, and creator token if
  this client is the creator
- **realistic-demo.AC7.3 Success:** Turning it off deletes that stored
  state
- **realistic-demo.AC7.4 Success:** Reloading with stored state restores
  the group at its current epoch and resumes from the stored cursor
- **realistic-demo.AC7.5 Success:** A waiting joiner, who has a key
  package but no group state, is persisted and returns to the waiting
  state on reload
- **realistic-demo.AC7.6 Success:** Reset deletes only
  `mls-realistic-demo`, leaves the room on the server untouched, and
  leaves the persistence and multi-device demos' records intact

### realistic-demo.AC8: Rooms expire and say so
- **realistic-demo.AC8.4 Success:** The gone view says the room does not
  exist or has expired, and offers to create a new one

### realistic-demo.AC10: Cross-cutting behaviors
- **realistic-demo.AC10.6 Success:** The page states that creator-only
  removal is a rule this demo enforces in its own interface with nothing
  cryptographic behind it, that a disconnected member's leaf is still in
  the ratchet tree, and what a placeholder means

**How these are verified.** The placeholder rules (AC6.3, AC6.4, AC6.5's
skip rule, AC6.6) are pure and unit tested in `timeline.ts`. Everything
else needs a browser and is verified manually in Task 6.

**Design contradiction resolved.** The design's Phase 8 asks for
"coverage for `createSessionStore`" registered in `test/index.ts`, but
its own Out of Scope excludes "any test requiring the DOM, `indexedDB`,
`WebSocket`, or `DurableObject`" -- and `createSessionStore` is
IndexedDB. This plan follows the precedent already set by
`test/example/persistence-storage.ts`, which tests the module's **pure
helpers** and never opens a database: the record-building and
record-validating logic is extracted and unit tested, and the IndexedDB
plumbing is verified in the browser in Task 6.

---

## Codebase verification findings

**`example-shared/persistence-storage.ts`** (moved there in Phase 1):

- `createMemberStore({ dbName }):MemberStore` at what was
  `example/persistence-storage.ts:192`. Its `openDb()` is a closure
  calling `indexedDB.open(dbName, 1)` with an `onupgradeneeded` that
  creates a single object store.
- `MemberStore` is
  `{ saveMember, deleteMember, loadAllMembers, deleteDatabase }`.
- `saveMember` strips `clientConfig` from `ClientState` before
  persisting: `const { clientConfig: _clientConfig, ...persistableState }`.
  Do the same for session state -- `clientConfig` holds functions and is
  not structured-cloneable.
- `PersistedMember` is `{ name, state }`. **Its shape must not change**,
  or the persistence and multi-device demos break.
- The two existing databases (`mls-persistence-demo`,
  `mls-multi-device-demo`) are already at version 1, so their
  `onupgradeneeded` never re-runs and they never gain a `session` store.
  They do not need one.

**Other confirmed state:**

- `example-shared/storage-panel.ts` exports `StoragePanel`,
  `PersistRequest`, `PERSIST_MESSAGES`, `persistOutcome`.
- `example-shared/storage-persistence.ts` exports `StorageStatus`,
  `storageStatusLabel`, `checkPersisted`, `requestPersistentStorage`.
- `example-shared/how-to-use.ts` exports `HowToUse` and `SETUP_STEPS`.
- `defaultKeyRetentionConfig.retainKeysForEpochs` is **4**
  (`src/key-retention-config.ts`). A member away across more than four
  commits can lose application messages they were a member for -- which
  is why every undecryptable entry becomes a placeholder, not only
  pre-join ones.
- `processMessage` returns `{ kind:'applicationMessage', message, newState }`
  for a chat message; the plaintext is `message`, a `Uint8Array`.
- Every `LogEntry` carries `sender`, which is how a client recognises its
  own past entries on replay.
- Base64 helpers are split, as established in Phase 6: encoders
  (`bytesToBase64`, `bytesToBase64url`) come from `../../src/index.js`;
  decoders (`base64ToBytes`, `base64urlToBytes`) come from
  `../../src/util/byte-array.js`, because `src/index.ts:136` re-exports
  only the encoders.

## External dependency findings

N/A -- no new dependency.

---

## Commands used throughout this phase

- **Root typecheck:**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Two-process dev:** `npm run worker:dev` and `npm run dev:realistic`
- **Existing demos must keep working:** `npm run build-example`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: The pure timeline fold

**Verifies:** None directly -- Task 2 tests this.

**Files:**
- Create: `example-realistic-demo/client/timeline.ts`

**Step 1: Create the module**

```ts
import type { LogEntry } from '../protocol.js'

/**
 * Turning a log into something readable. Pure -- no preact, no signals,
 * no DOM -- so the placeholder rules can be unit tested in node.
 *
 * A placeholder is not an error. Two ordinary things produce one: a
 * message sent before this client joined, and a message whose keys have
 * since rotated out, because `retainKeysForEpochs` is 4 and a member
 * away across more than four commits loses older messages they were a
 * member for. Rendering either as a failure would misrepresent forward
 * secrecy as a bug.
 */

export interface TimelineText {
    kind:'text'
    seq:number
    from:string
    text:string
}

export interface TimelinePlaceholder {
    kind:'placeholder'
    /** Highest seq covered, so the item has a stable sort position. */
    seq:number
    count:number
    reason:'before-join'|'undecryptable'
}

export type TimelineItem = TimelineText|TimelinePlaceholder

export interface TimelineInput {
    /** Application entries only, in seq order. */
    entries:LogEntry[]

    /** seq -> plaintext, for entries this client could decrypt. */
    decrypted:Record<number, string>

    /** seq -> display name of the sender. */
    names:Record<string, string>

    /**
     * The cursor adopted from `welcome-you`. Everything at or below it
     * predates this client's membership. Zero means the client was
     * there from the start.
     */
    joinCursor:number

    /**
     * How many application entries preceded the join, as the room
     * counted them. Used instead of counting locally, because the
     * client may never have been sent those entries at all.
     */
    priorCount:number
}

/**
 * Fold entries into renderable items, collapsing runs of
 * undecryptable ones.
 */
export function buildTimeline (input:TimelineInput):TimelineItem[] {
    const items:TimelineItem[] = []

    // One leading placeholder for everything before the join. A client
    // that joined at the very beginning has nothing before it and gets
    // no placeholder at all -- an empty "0 earlier messages" would be
    // noise.
    if (input.joinCursor > 0 && input.priorCount > 0) {
        items.push({
            kind: 'placeholder',
            seq: input.joinCursor,
            count: input.priorCount,
            reason: 'before-join'
        })
    }

    let run:TimelinePlaceholder|null = null

    for (const entry of input.entries) {
        if (entry.kind !== 'application') continue
        if (entry.seq <= input.joinCursor) continue

        const text = input.decrypted[entry.seq]

        if (text === undefined) {
            // Consecutive misses collapse into one item rather than a
            // wall of identical rows.
            if (run) {
                run.count = run.count + 1
                run.seq = entry.seq
            } else {
                run = {
                    kind: 'placeholder',
                    seq: entry.seq,
                    count: 1,
                    reason: 'undecryptable'
                }
                items.push(run)
            }
            continue
        }

        run = null
        items.push({
            kind: 'text',
            seq: entry.seq,
            from: input.names[entry.sender] ?? 'unknown',
            text
        })
    }

    return items
}
```

**Step 2: Do not commit yet**
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test the timeline fold

**Verifies:** realistic-demo.AC6.3, realistic-demo.AC6.4,
realistic-demo.AC6.5 (skip rule), realistic-demo.AC6.6

**Files:**
- Create: `test/example-realistic-demo/timeline.ts` (unit)
- Modify: `test/index.ts`

Note this goes in `test/example-realistic-demo/`, not
`test/example/timeline.ts` as the design says -- consistent with
Phase 3 and Phase 6.

**Step 1: Register**

Add `import './example-realistic-demo/timeline.js'` to the
`// Realistic demo tests` block.

**Step 2: Write the tests**

Fixtures are plain `LogEntry` arrays. No crypto, no group, no async.

- **realistic-demo.AC6.3, leading placeholder.** With `joinCursor` 5 and
  `priorCount` 12, the first item is a single placeholder with `count`
  12 and reason `before-join` -- **one** item, not twelve. Assert no
  entry at or below seq 5 produces any item of its own.
- **realistic-demo.AC6.6, epoch zero edge.** With `joinCursor` 0, there
  is **no** leading placeholder, whatever `priorCount` says. Also assert
  no placeholder when `joinCursor` is above 0 but `priorCount` is 0 --
  a join after only commits, with no messages before it.
- **realistic-demo.AC6.4, collapsing runs.** Three consecutive
  undecryptable entries after the join produce **one** placeholder with
  `count` 3 and reason `undecryptable`. A decryptable entry between two
  undecryptable ones **breaks** the run, giving placeholder, text,
  placeholder -- three items, each with the right count. This is the
  case that fails if the run variable is not cleared.
- **realistic-demo.AC6.5, own entries.** An entry whose `sender` is this
  client but which has a recorded plaintext in `decrypted` renders as
  **text**, not a placeholder. This is what stops a client's own past
  messages appearing as decrypt failures on replay.
- **Ordering.** Items come out in ascending seq, and the leading
  placeholder is first.
- **Non-application entries.** `commit` and `proposal` entries produce no
  item at all, decryptable or not -- they were never anything a person
  could read.
- Empty entries with `joinCursor` 0 gives an empty list.

**Step 3: Run**

```bash
npm test
npm run lint
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: pure timeline fold with counted placeholders"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add the session store

**Verifies:** None directly -- Task 4 tests the pure part, Task 6 the
rest.

**Files:**
- Modify: `example-shared/persistence-storage.ts`

**Step 1: Add the store name and lift the open path**

A waiting joiner has a key package and private keys but **no group
state**, while `PersistedMember` requires `state` and
`restoredUsersFromRecords` reads `state.groupContext.groupId`. The page
also needs `roomId`, `cursor` and `creatorToken`, none of which are
member state. So a second object store, not a changed `PersistedMember`.

Add beside the existing `STORE_NAME`:

```ts
const SESSION_STORE_NAME = 'session'
const SESSION_KEY = 'current'
```

Move `openDb` out of `createMemberStore` to module scope so both
factories share one upgrade path, and have it create **both** stores:

```ts
/**
 * Shared by both stores so one upgrade path creates both. The two
 * existing demo databases are already at version 1, so their upgrade
 * handler never re-runs and they simply never gain a `session` store --
 * which they do not need. Bumping the version to give them one would
 * force an upgrade on databases that are working fine.
 */
function openDb (dbName:string):Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(dbName, 1)
        open.onupgradeneeded = () => {
            const db = open.result
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME)
            }
            if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
                db.createObjectStore(SESSION_STORE_NAME)
            }
        }
        open.onerror = () => reject(open.error)
        open.onsuccess = () => resolve(open.result)
    })
}
```

Update `createMemberStore` to call `openDb(dbName)`. **Its behavior must
not change in any other way** -- the persistence and multi-device demos
depend on it exactly as it is.

**Step 2: Add the session types and the pure helpers**

```ts
/**
 * Everything this page needs to come back as it was, including the
 * cases `PersistedMember` cannot express: a joiner with keys but no
 * group yet, and the room-level facts that are not member state.
 */
export interface PersistedSession {
    name:string
    keyPackage:KeyPackage
    privateKeys:PrivateKeyPackage
    roomId:string|null
    cursor:number
    creatorToken:string|null
    state?:ClientState
}

/**
 * Build the record to store. `clientConfig` is stripped for the same
 * reason `saveMember` strips it -- it holds functions and is not
 * structured-cloneable.
 *
 * Pure, so the decision about what gets written is testable without a
 * database.
 */
export function sessionRecord (
    input:PersistedSession
):PersistedSession {
    if (!input.state) return { ...input }
    const { clientConfig: _clientConfig, ...rest } = input.state
    return { ...input, state: rest as ClientState }
}

/**
 * Whether a stored record is usable. A record with no key package or no
 * private keys cannot do anything and is treated as absent rather than
 * restored into a broken half-state.
 */
export function isRestorableSession (
    value:unknown
):value is PersistedSession {
    if (!value || typeof value !== 'object') return false
    const record = value as Partial<PersistedSession>
    return (
        typeof record.name === 'string' &&
        record.keyPackage !== undefined &&
        record.privateKeys !== undefined &&
        typeof record.cursor === 'number' &&
        Number.isFinite(record.cursor)
    )
}
```

Import `KeyPackage` and `PrivateKeyPackage` types from `../src/index.js`
alongside the existing `ClientState` import.

**Step 3: Add `createSessionStore`**

```ts
export interface SessionStore {
    saveSession (session:PersistedSession):Promise<void>
    loadSession ():Promise<PersistedSession|null>
    clearSession ():Promise<void>
    deleteDatabase ():Promise<void>
}

/**
 * One session per database, keyed by a constant -- this page holds
 * exactly one client, unlike the demos that hold a map of many.
 *
 * Nothing is opened until an operation is called, matching
 * createMemberStore, which is what lets the page build its store at
 * module scope.
 */
export function createSessionStore (
    { dbName }:{ dbName:string }
):SessionStore {
    async function saveSession (
        session:PersistedSession
    ):Promise<void> {
        const db = await openDb(dbName)
        const record = sessionRecord(session)

        return new Promise((resolve, reject) => {
            const tx = db.transaction(SESSION_STORE_NAME, 'readwrite')
            tx.objectStore(SESSION_STORE_NAME).put(record, SESSION_KEY)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async function loadSession ():Promise<PersistedSession|null> {
        const db = await openDb(dbName)

        return new Promise((resolve, reject) => {
            const tx = db.transaction(SESSION_STORE_NAME, 'readonly')
            const request = tx.objectStore(SESSION_STORE_NAME)
                .get(SESSION_KEY)

            // A record that cannot be used is treated as absent rather
            // than restored into a broken half-state.
            request.onsuccess = () => {
                const value = request.result
                resolve(isRestorableSession(value) ? value : null)
            }
            request.onerror = () => reject(request.error)
        })
    }

    async function clearSession ():Promise<void> {
        const db = await openDb(dbName)

        return new Promise((resolve, reject) => {
            const tx = db.transaction(SESSION_STORE_NAME, 'readwrite')
            tx.objectStore(SESSION_STORE_NAME).delete(SESSION_KEY)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    function deleteDatabase ():Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(dbName)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
            // Fires when another tab still holds the database open.
            // Resolve rather than hang -- the delete completes once
            // that tab closes.
            request.onblocked = () => resolve()
        })
    }

    return { saveSession, loadSession, clearSession, deleteDatabase }
}
```

This follows the exact promise-wrapping style already used by
`saveMember`, `deleteMember` and `loadAllMembers` in this file: resolve
on `tx.oncomplete`, reject on `tx.onerror`. Match the existing
`deleteDatabase` in `createMemberStore` if it differs from the shape
above -- consistency within the file wins.

**Step 4: Confirm the existing demos are untouched**

```bash
npm test
npm run lint
npm run build-example
```

Expected: all pass, and the test count is unchanged -- no existing test
should have needed editing. `PersistedMember` must be byte-identical to
what it was.

```bash
git diff --stat main -- example-shared/persistence-storage.ts
```

Review the diff and confirm nothing inside `saveMember`,
`deleteMember`, `loadAllMembers`, `memberKey`,
`restoredUsersFromRecords`, `partitionPersistedNames` or
`partitionRestorableRecords` changed except `openDb`'s call site.

**Step 5: Do not commit yet**
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Test the pure session helpers

**Verifies:** None directly (supports realistic-demo.AC7.2,
realistic-demo.AC7.5).

**Files:**
- Modify: `test/example/persistence-storage.ts`

Add to the existing test file, which already covers this module's pure
helpers and never opens a database. It stays under `test/example/`
because it tests a shared module the existing demos also use.

**Step 1: Write the tests**

- `sessionRecord` strips `clientConfig` from `state` while leaving every
  other field of `state` intact.
- `sessionRecord` handles a record with **no** `state` at all -- the
  waiting-joiner case -- without throwing and without inventing a
  `state` key.
- `isRestorableSession` accepts a full record, and accepts one with no
  `state` (again the waiting joiner -- this is the case that makes
  realistic-demo.AC7.5 possible).
- `isRestorableSession` rejects: a record missing `keyPackage`, one
  missing `privateKeys`, one whose `cursor` is not a finite number, a
  non-object, `null`, and an array.

**Step 2: Run**

```bash
npm test
npm run lint
```

Expected: passes, count up.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add session store beside the member store"
```
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Chat, persistence control, gone view and explainer

**Verifies:** realistic-demo.AC6.1, realistic-demo.AC6.2,
realistic-demo.AC6.5, realistic-demo.AC7.1, realistic-demo.AC7.2,
realistic-demo.AC7.3, realistic-demo.AC7.4, realistic-demo.AC7.5,
realistic-demo.AC7.6, realistic-demo.AC8.4, realistic-demo.AC10.6 (all
confirmed in Task 6)

**Files:**
- Modify: `example-realistic-demo/client/views/room.ts`
- Create: `example-realistic-demo/client/views/gone.ts`
- Modify: `example-realistic-demo/client/index.ts`
- Modify: `example-realistic-demo/client/state.ts`
- Modify: `example-realistic-demo/client/style.css`

**Step 1: Chat send and receive**

In `views/room.ts`, add a message composer. On send:

- Call `encryptMessage` from `mls-actions.ts`, send
  `{ type:'mls', kind:'application', payload }`, and apply `newState`.
- **Record the plaintext locally, keyed by the seq the room assigns.**
  The seq is not known at send time, so record it against the entry when
  it comes back, or track outbound messages and reconcile. Without this
  record, the client's own messages become placeholders on the next
  replay -- which is realistic-demo.AC6.5.
- If `send` returns false the socket is down: report it to the person
  rather than dropping the message silently.

On an inbound application entry, in the `applyEntry` function passed to
`createConnection` (Phase 6, Task 6):

- **Skip entries whose `sender` is this client's own identity** and
  render them from the local plaintext record instead. An MLS sender
  cannot decrypt its own application message, so attempting it would
  always fail. Live this never arises, because the room does not echo to
  the sender; on replay it always does.
- For everyone else's, call `processMessage`, take the plaintext from the
  `applicationMessage` result, and store it against the entry's seq.
- A decrypt failure is expected, not an error: record nothing, let the
  entry queue's `onError` return `'continue'`, and let `buildTimeline`
  turn it into a placeholder.

Render the timeline with `buildTimeline`, passing `joinCursor` and
`priorCount` from state. Show names from the ratchet tree via
`membersFromTree`, since the room holds no display names.

**Step 2: The persistence control**

Add a persist toggle to the status area, rendered **from first render,
before any user exists**, and never unmounted. This is
realistic-demo.AC7.1 and it is a placement requirement -- putting it
inside the room view would make it appear only after a group exists.

Reuse `StoragePanel`, `persistOutcome` and `PERSIST_MESSAGES` from
`example-shared/storage-panel.ts`, and `checkPersisted` /
`requestPersistentStorage` / `storageStatusLabel` from
`example-shared/storage-persistence.ts`. Do not write new equivalents.

Behavior:

- Turning it **on** writes whatever state currently exists: the user,
  the group state if there is one, the room id, the cursor, and the
  creator token if this client is the creator. If there is no user yet,
  it records the preference and writes as soon as there is one.
- Turning it **off** deletes the stored session
  (realistic-demo.AC7.3).
- While on, re-save after each change that matters: a new group state, an
  advanced cursor, a received creator token.
- Add a **Reset** control that calls `deleteDatabase()` for
  `mls-realistic-demo` **only**. It must not touch
  `mls-persistence-demo` or `mls-multi-device-demo`, and it must not
  tell the server anything -- the room on the server is untouched and
  keeps existing until it expires. That is realistic-demo.AC7.6.

Use the database name `mls-realistic-demo`, the third name beside the two
existing ones.

**Step 3: Restore on load**

In `index.ts`, before connecting:

- Load the session. If `isRestorableSession` rejects it, treat it as
  absent.
- Restore the user, and the group if the record has `state`. Because
  `state` was persisted at its current epoch, the group comes back at
  that epoch (realistic-demo.AC7.4).
- Resume from the stored `cursor`, sending it in `hello` so the room
  replays only what was missed rather than everything.
- A record **without** `state` is a waiting joiner: restore the user and
  the key package, reconnect, and return to the **waiting** view.

  **Always re-publish the join request** on reconnect, via the `onOpen`
  path from Phase 6 Task 6. Do not try to check first whether one is
  already pending -- the room reports pending requests only to the
  creator, so a joiner cannot learn this under the wire contract, and
  adding a message for it would be a contract change for no gain.
  Re-publishing is safe: `pending.identity` is a primary key and the
  insert is `INSERT OR REPLACE`, so asking twice replaces rather than
  duplicates. That is exactly what realistic-demo.AC4.4 guarantees
  (realistic-demo.AC7.5).
- Wrap the whole restore in a try/catch that writes any failure into
  `state.status` rather than letting it escape module evaluation, as the
  other persisting demos already do.

**Step 4: The gone view**

Create `views/gone.ts`, rendered when `state.roomMissing.value` is true,
which happens on a 404 from the probe or a `no-room` from the socket.

It must say the room **does not exist or has expired** -- both, because
the two are deliberately indistinguishable once the storage is gone --
and offer a control to **create a new room**, which returns to the setup
view. That is realistic-demo.AC8.4.

**Step 5: The explainer copy (realistic-demo.AC10.6)**

The page must state, in plain language and near what each describes:

1. That **creator-only removal is a rule this demo enforces in its own
   interface, with nothing cryptographic behind it**. Any member could
   commit a Remove; the room records what the creator's client tells it
   and can verify none of it.
2. That a **disconnected member's leaf is still in the ratchet tree**.
   They are away, not removed, and the group's membership has not
   changed.
3. **What a placeholder means**: a message this client cannot read,
   either because it predates the join or because keys have since
   rotated out -- `retainKeysForEpochs` is 4, so being away across more
   than four commits loses older messages. It is forward secrecy working,
   not a failure.

Items 1 and 2 may already exist from Phase 7, Step 2 of Task 5; complete
whichever are missing rather than duplicating them.

Also add intro copy explaining what the demo is, a how-to-use card via
`HowToUse` from `example-shared/how-to-use.ts`, and the room's expiry
time rendered from `state.expiresAt`.

**Step 6: Styling**

Finish `client/style.css` using the variables from `example/style.css`.
Reuse existing colors before creating any new one, use nested selectors
rather than many class names, and use no font size below 1rem. **Do not
modify `example/style.css`** -- the existing demos' appearance must not
change.

**Step 7: Verify**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
npm test
npm run build:realistic
npm run build-example
```

Expected: all clean.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: chat, persistence, gone view and explainer copy"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Verify end to end in two browser profiles

**Verifies:** realistic-demo.AC6.1, realistic-demo.AC6.2,
realistic-demo.AC6.3, realistic-demo.AC6.4, realistic-demo.AC6.5,
realistic-demo.AC6.6, realistic-demo.AC7.1 through
realistic-demo.AC7.6, realistic-demo.AC8.4, realistic-demo.AC10.6

**Files:** None modified unless a defect is found.

Two browser profiles again, **A** (creator) and **B**.

**Step 1: Start both processes**

```bash
npm run worker:dev
```

```bash
npm run dev:realistic
```

**Step 2: Chat (realistic-demo.AC6.1)**

With A and B both in the room, send from each. Confirm each message
appears on the other side with the right sender name, and that the
sender sees their own message too. In the WS frames confirm the payload
is opaque base64 -- the plaintext must appear nowhere on the wire.

**Step 3: The leading placeholder (realistic-demo.AC6.3, AC6.6)**

1. Before this, confirm **A sees no leading placeholder** -- A created
   the room and joined at epoch zero. That is
   realistic-demo.AC6.6, and it is a negative check.
2. In a fresh profile C, join the room after several messages have been
   sent. Confirm C sees **one** placeholder stating **how many** messages
   came before, not one row per message and not an error.

**Step 4: Replay in order (realistic-demo.AC6.2)**

1. Close B's tab. Send several messages from A.
2. Reopen B. Confirm the missed messages appear **in order** and that
   nothing already seen is duplicated.

**Step 5: Own messages on replay (realistic-demo.AC6.5)**

With persistence **on** in B, send messages from B, reload B, and confirm
B's own past messages render as **text from the local record**, not as
placeholders. Then with persistence **off**, do the same and confirm
they render as placeholders -- which is honest, since nothing recorded
them.

**Step 6: Collapsed undecryptable run (realistic-demo.AC6.4)**

`retainKeysForEpochs` is 4, so drive more than four commits while a
member is away: with B closed, add and remove members in A several times
with messages in between. Reopen B and confirm consecutive unreadable
entries collapse into **one counted placeholder**, not a wall of rows.

**Step 7: Persistence (realistic-demo.AC7.1 to AC7.5)**

1. Open a fresh profile at `/`. Confirm the persist control is present
   **before any user exists** (realistic-demo.AC7.1). Confirm it is still
   present in the waiting view and in the room view.
2. Turn it on mid-session in B. In devtools, inspect the
   `mls-realistic-demo` database and confirm the `session` record holds
   the user, group state, room id, cursor, and -- in A -- the creator
   token (realistic-demo.AC7.2).
3. Reload B. Confirm the group returns at its **current epoch**, not
   epoch zero, and that replay resumes from the stored cursor rather
   than re-sending everything (realistic-demo.AC7.4).
4. In a profile that is **waiting** and not yet approved, turn persist on
   and reload. Confirm it returns to the **waiting** view with its key
   package intact, and does not fall back to the name field
   (realistic-demo.AC7.5).
5. Turn persist off and confirm the stored record is deleted
   (realistic-demo.AC7.3).

**Step 8: Reset isolation (realistic-demo.AC7.6)**

1. Create records in the persistence demo and the multi-device demo on
   the GitHub Pages build or at `http://localhost:1234` from the root
   Vite server, so `mls-persistence-demo` and `mls-multi-device-demo`
   exist.
2. In the realistic demo, press Reset.
3. In devtools, confirm **only** `mls-realistic-demo` is gone and both
   other databases are intact with their records.
4. Confirm the room still exists on the server: reopen the room URL from
   another profile and confirm it loads rather than showing the gone
   view.

**Step 9: The gone view (realistic-demo.AC8.4)**

Open a room URL for an id that does not exist. Confirm the page says the
room does not exist **or has expired**, and offers to create a new one.
Follow that offer and confirm it works.

**Step 10: The disclosures (realistic-demo.AC10.6)**

Read the page and confirm all three statements are present and
findable: creator-only removal is interface-only with nothing
cryptographic behind it; a disconnected member's leaf is still in the
ratchet tree; and what a placeholder means.

**Step 11: Confirm the existing demos are unharmed**

```bash
npm run build-pages
```

Open the main, persistence and multi-device demos and confirm all three
behave exactly as before, including their stored records.

**Step 12: Deploy and verify on the real origin**

```bash
npm run worker:deploy
```

Repeat Steps 2, 3 and 9 against the deployed `workers.dev` origin, with
two profiles, confirming the socket is `wss://` on that same origin.

**Step 13: Stop both dev processes**

Stop the Vite server and `wrangler dev`. Do not leave either running.
<!-- END_TASK_6 -->

---

## Phase 8 completion checklist

- [x] `buildTimeline` unit tested for all four placeholder rules
- [x] A creator at epoch zero sees no leading placeholder
- [x] Consecutive undecryptable entries collapse into one counted item,
      and a readable entry breaks the run
- [x] Own past entries render from the local plaintext record
- [x] `PersistedMember` unchanged; existing tests unedited
- [x] `session` object store created in the shared upgrade path
- [x] Persist control present from first render and never unmounted
- [x] Persist on writes user, group state if any, room id, cursor and
      creator token
- [x] Persist off deletes the record
- [x] Reload restores the group at its current epoch and resumes from
      the stored cursor
- [x] A waiting joiner persists and returns to waiting
- [x] Reset deletes only `mls-realistic-demo`; other demos' records and
      the server-side room are untouched
- [x] Gone view states both causes and offers a new room
- [x] All three disclosures present
- [x] `example/style.css` unmodified
- [x] `npm test`, `npm run lint`, typecheck, `build:realistic` and
      `build-pages` all pass
- [ ] Deployed and verified on the real origin
- [x] Both dev servers stopped

Two of these need their evidence stated rather than left to the tick.

**Own past entries render from the local plaintext record.** The place
this is observable is the room's echo of a live send, not a reload:
`verify-phase8-chat.mjs` watches an outbound row become a numbered one
carrying the same text, and MLS cannot decrypt a message it produced, so
the only source for that text is what `chat.ts` recorded. A reload
cannot show it, because the stored cursor resumes above everything the
client already saw and it is never re-sent its own entries.
`verify-phase8-e2e.mjs` asserts the criterion's negative half there
instead: after a reload, no past message of the client's own renders as
a decrypt failure.

**Deployed and verified on the real origin.** Not done, and deliberately
not done: redeploying the Worker is the repository owner's call, and no
session may do it unasked. Everything Step 12 would re-run against the
deployed origin -- chat, the leading placeholder, the gone view -- is
verified against `localhost` by the three harnesses. This is the one
item left for the owner.
