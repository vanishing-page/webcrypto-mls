# Realistic Demo Implementation Plan -- Phase 6: Client shell, user and room creation

**Goal:** A page that creates one user, creates a room, and holds an
ordered connection to it.

**Architecture:** One browser is one MLS client, so state is a single
client rather than a map of many -- the departure from
`createDemoState()` is deliberate. All network I/O lives in
`delivery-client.ts`; the rules it obeys live in `delivery-cursor.ts` and
`entry-queue.ts`, which are pure and tested in Node. Inbound entries are
drained one at a time through a serial queue, because applying one is
async and a live entry can arrive mid-replay.

**Tech Stack:** preact + htm, `@preact/signals`, `route-event`, `nanoid`,
the repository's own MLS library from `src/`, Vite 7.

**Scope:** Phase 6 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### realistic-demo.AC1: The Worker serves the page and the API
- **realistic-demo.AC1.1 Success:** An unmatched path such as
  `/aB3xK9pQ2m` returns HTTP 200 with the page, not 404
- **realistic-demo.AC1.2 Success:** The page loads from the deployed
  Worker origin and connects to `wss://` on that same origin, with no
  configured endpoint

### realistic-demo.AC2: A visitor creates one user and one room
- **realistic-demo.AC2.1 Success:** Creating a user generates exactly one
  key package and one non-extractable signature keypair
- **realistic-demo.AC2.2 Success:** Creating a room creates the MLS group
  with the local user as its only member and navigates to `/<roomId>`,
  with the group id generated independently of the room id
- **realistic-demo.AC2.3 Success:** The full room URL is displayed and
  can be copied
- **realistic-demo.AC2.4 Failure:** `create` sent to a room id that
  already has metadata is answered with `error: 'room-exists'`

### realistic-demo.AC9: Ordering integrity
- **realistic-demo.AC9.3 Success:** A live `entry` arriving while a `log`
  batch is still being processed is applied after that batch rather than
  interleaved with it

### realistic-demo.AC10: Cross-cutting behaviors
- **realistic-demo.AC10.4 Logic:** The cursor never moves backward and
  never skips a gap in `seq`
- **realistic-demo.AC10.5 Logic:** Reconnect backoff grows between
  attempts and is capped

**How these are verified.** AC9.3, AC10.4 and AC10.5 are automated:
`entry-queue.ts` and `delivery-cursor.ts` are written with no DOM and no
`WebSocket` reference specifically so the Node harness can exercise them.
AC9.3 in particular is testable because the queue takes its apply
function as an argument. The remaining ACs need a browser and are
verified manually in Task 6.

---

## Codebase verification findings

**MLS API surface**, confirmed against `src/index.ts` and the reference
implementation in `example/demo-actions.ts`:

- `getCipherSuite(cs?, provider?):Promise<CiphersuiteImpl>` and
  `DEFAULT_CIPHERSUITE`, which is
  `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.
- `generateKeyPackage(credential, capabilities, lifetime, extensions,
  cs, options?)` returns `{ publicPackage, privatePackage }`.
  `options.signatureKeyPair` accepts a `CryptoKeyPair`, which is how a
  non-extractable key is supplied.
- `defaultCapabilities()` and `defaultLifetime()`.
- `createGroup(groupId, keyPackage, privateKeyPackage, extensions, cs,
  clientConfig?):Promise<ClientState>`.
- `createApplicationMessage(state, message, cs, authenticatedData)`
  returns `{ newState, privateMessage }`.
- `processMessage(message, state, pskIndex, action, cs)` returns
  `ProcessMessageResult`, a union of
  `{ kind:'newState'; newState; actionTaken }` and
  `{ kind:'applicationMessage'; message:Uint8Array; newState }`.
- `makePskIndex(state, {})` and `acceptAll`.
- `encodeMlsMessage(msg):Uint8Array` and
  `decodeMlsMessage(bytes, 0):[MLSMessage, number]|undefined`.
- **Base64 helpers are split across two modules.** `src/index.ts:136` is
  `export { bytesToBase64, bytesToBase64url } from './util/byte-array.js'`
  -- only the two **encoders**. The matching **decoders**,
  `base64ToBytes` and `base64urlToBytes`, exist in
  `src/util/byte-array.ts` but are **not** re-exported from the package
  entry, and nothing in `example/` imports them today.

  So import encoders from `../../src/index.js` and decoders from
  `../../src/util/byte-array.js`. A deep import inside the same
  repository is the smaller change: adding the decoders to
  `src/index.ts` would alter the published package's public API for a
  demo's benefit, which is outside this work's scope.

  **Do not write new base64 helpers** either way -- all four exist.
- The epoch is `state.groupContext.epoch`, a `bigint`.
- `state.ratchetTree` holds the membership; `state.groupActiveState` is
  the `GroupActiveState` union.

**Non-extractable signature keys**, the pattern from
`example/persistence-demo.ts`, downstream of ADR-001:

```ts
const signatureKeyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false, // not extractable
    ['sign', 'verify']
)
```

The `false` is the whole point. It is passed to `generateKeyPackage` as
`{ signatureKeyPair }`.

**Other confirmed state:**

- `route-event@^8.1.2` and `nanoid@^5.1.16` are devDependencies. Both are
  bundled by Vite at build time, so neither needs promoting.
- `@preact/signals` is used throughout, with `batch` wrapping sequential
  writes and `useSignal` for component-local state.
- `example/style.css` holds the CSS variables the new client reuses.
  Styling beyond a minimum belongs to Phase 8.
- `example-realistic-demo/client/index.ts` and `client/index.html` exist
  as Phase 2 placeholders. This phase replaces `index.ts` entirely.

## External dependency findings

N/A -- every dependency this phase needs is already installed.

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
### Task 1: Write the pure connection rules

**Verifies:** None directly -- Task 2 tests these.

**Files:**
- Create: `example-realistic-demo/client/delivery-cursor.ts`
- Create: `example-realistic-demo/client/entry-queue.ts`

**Step 1: Create `delivery-cursor.ts`**

```ts
import type { LogEntry } from '../protocol.js'

/**
 * The two rules the connection obeys, kept apart from the socket that
 * obeys them. Pure -- no DOM, no WebSocket, no signals -- so it can be
 * unit tested in node.
 */

/**
 * Where the cursor goes after applying an entry.
 *
 * A cursor is a promise that everything at or below it has been applied,
 * so it may only advance by exactly one. An entry that skips a seq means
 * something was lost in flight, and moving the cursor past the gap would
 * turn a recoverable gap into permanent silent data loss -- the missing
 * entry would never be replayed, because the next reconnect would ask
 * from beyond it.
 *
 * Returns the unchanged cursor for anything already applied, and for
 * anything that would leave a gap.
 */
export function advanceCursor (cursor:number, seq:number):number {
    if (seq !== cursor + 1) return cursor
    return seq
}

/**
 * Whether an entry is the next one expected. The caller uses this to
 * tell "already seen, skip it" from "gap, stop and resynchronise".
 */
export function entryPosition (
    cursor:number,
    entry:LogEntry
):'next'|'seen'|'gap' {
    if (entry.seq <= cursor) return 'seen'
    if (entry.seq === cursor + 1) return 'next'
    return 'gap'
}

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000

/**
 * How long to wait before reconnect attempt `attempt`, counting from 0.
 * Doubles each time and stops growing at the cap, so a room that is
 * genuinely gone is not hammered while a transient drop still recovers
 * quickly.
 */
export function reconnectDelay (attempt:number):number {
    const n = Math.max(0, Math.floor(attempt))
    const raw = RECONNECT_BASE_MS * Math.pow(2, n)
    return Math.min(raw, RECONNECT_MAX_MS)
}
```

**Step 2: Create `entry-queue.ts`**

```ts
/**
 * A serial queue for inbound entries.
 *
 * Applying an entry is async, because it involves crypto, and a live
 * `entry` can arrive while a `log` batch is still being applied. Without
 * a queue the two interleave, MLS rejects the out-of-order commit, and
 * the client is stuck with no way back. So nothing is ever applied
 * directly -- everything is appended here and drained one at a time.
 *
 * Pure in the sense that matters: the apply function is an argument, so
 * this holds no reference to a socket, a signal or the DOM, and can be
 * tested in node.
 */
export interface EntryQueue<T> {
    push (items:T[]):void

    /**
     * Clear a stop and discard anything left. A stopped queue rejects
     * every later push, so without this a single fatal entry kills the
     * client permanently -- the reconnect would replay and every entry
     * would be silently dropped. The caller resets on reconnect, when
     * the replay is about to re-deliver from a known-good cursor.
     */
    reset ():void

    readonly size:number
    readonly draining:boolean
    readonly stopped:boolean
    idle ():Promise<void>
}

export interface EntryQueueOptions<T> {
    apply (item:T):Promise<void>

    /**
     * Called when `apply` throws. Returning 'stop' halts the queue and
     * discards what is left; returning 'continue' drops that one item
     * and carries on.
     *
     * The difference is the whole point. A commit that fails to process
     * is fatal for group state -- carrying on would silently skip an
     * epoch. An application message that fails to decrypt is ordinary
     * forward secrecy and must not wedge the client.
     */
    onError (err:unknown, item:T):'stop'|'continue'
}

export function createEntryQueue<T> (
    opts:EntryQueueOptions<T>
):EntryQueue<T> {
    const items:T[] = []
    let draining = false
    let stopped = false
    let idleWaiters:Array<() => void> = []

    function settle ():void {
        const waiters = idleWaiters
        idleWaiters = []
        for (const resolve of waiters) resolve()
    }

    async function drain ():Promise<void> {
        if (draining) return
        draining = true

        while (items.length > 0 && !stopped) {
            const item = items.shift() as T
            try {
                await opts.apply(item)
            } catch (err) {
                if (opts.onError(err, item) === 'stop') {
                    stopped = true
                    items.length = 0
                }
            }
        }

        draining = false
        settle()
    }

    return {
        push (next:T[]):void {
            if (stopped) return
            items.push(...next)
            void drain()
        },
        reset ():void {
            stopped = false
            items.length = 0
        },
        get size ():number {
            return items.length
        },
        get draining ():boolean {
            return draining
        },
        get stopped ():boolean {
            return stopped
        },
        idle ():Promise<void> {
            if (!draining && items.length === 0) return Promise.resolve()
            return new Promise(resolve => {
                idleWaiters.push(resolve)
            })
        }
    }
}
```

The `while` loop re-reads `items.length` on every pass, which is what
makes a push during a drain land at the back of the same drain rather
than starting a second one. That is realistic-demo.AC9.3 in one line, and
it is why `push` calls `drain()` unconditionally but `drain()` returns
early when already running.

**Step 3: Do not commit yet**

Task 2 tests both modules.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test the connection rules

**Verifies:** realistic-demo.AC9.3, realistic-demo.AC10.4,
realistic-demo.AC10.5

**Files:**
- Create: `test/example-realistic-demo/delivery-cursor.ts` (unit)
- Create: `test/example-realistic-demo/entry-queue.ts` (unit)
- Modify: `test/index.ts`

Note both test files go under `test/example-realistic-demo/`, matching
Phase 3. The design says `test/example/delivery-cursor.ts`; that would
scatter this demo's tests into the existing demos' directory.

**Step 1: Register the new test files**

Add to the `// Realistic demo tests` block in `test/index.ts`:

```ts
import './example-realistic-demo/delivery-cursor.js'
import './example-realistic-demo/entry-queue.js'
```

**Step 2: Write `test/example-realistic-demo/delivery-cursor.ts`**

Tests must verify:

- **realistic-demo.AC10.4, never backward.** `advanceCursor` returns the
  input cursor unchanged for a seq below it, and for a seq equal to it.
  Assert the return value is never less than the input across a range of
  inputs.
- **realistic-demo.AC10.4, never skips a gap.** `advanceCursor(5, 7)`
  returns 5, not 7. `advanceCursor(5, 6)` returns 6. `advanceCursor(0, 1)`
  returns 1, which is the first-entry case.
- `entryPosition` returns `'seen'` below and at the cursor, `'next'` at
  exactly cursor + 1, and `'gap'` above that.
- **realistic-demo.AC10.5, grows.** `reconnectDelay(n + 1)` is strictly
  greater than `reconnectDelay(n)` for every n before the cap is reached.
- **realistic-demo.AC10.5, capped.** `reconnectDelay` never exceeds
  `RECONNECT_MAX_MS`, including for a large attempt number such as 50
  and for a value that would overflow if computed naively. Assert
  `reconnectDelay(0)` equals `RECONNECT_BASE_MS`, and that a negative or
  fractional attempt is handled rather than producing `NaN`.

**Step 3: Write `test/example-realistic-demo/entry-queue.ts`**

Tests must verify **realistic-demo.AC9.3** and the error policy:

- **Ordering under a mid-drain push.** This is the AC. Push a batch of
  several items whose `apply` resolves asynchronously (await a resolved
  promise, or a zero timeout, so the drain genuinely yields). While that
  drain is in progress, push one more item. Assert the recorded apply
  order is the whole first batch in order, **then** the late item last --
  never interleaved. Record order by pushing to an array inside `apply`.
- **A single drain.** Assert a push during a drain does not start a
  second concurrent drain: instrument `apply` to assert it is never
  entered while another invocation is outstanding.
- **`'stop'` halts.** With an `onError` returning `'stop'`, an item whose
  `apply` rejects must prevent every later item in the queue from being
  applied. This is the commit case.
- **`'continue'` carries on.** With `onError` returning `'continue'`, a
  rejecting item must not prevent later items from being applied, and the
  failing item must be reported to `onError` exactly once. This is the
  undecryptable-application-message case.
- **`stopped` latches, and `reset()` clears it.** After a `'stop'`,
  assert `stopped` is true and that a further `push` applies nothing.
  Then call `reset()` and assert a subsequent `push` **is** applied
  again. Without this the client would be permanently dead after one
  fatal entry, so the test is what stops the latch being one-way.
- **`reset()` discards the backlog.** Items queued behind a stop are not
  applied after a reset -- they will be re-delivered by the replay.
- **`idle()`** resolves after the queue drains, and resolves immediately
  when the queue is already empty.

Do not test the type declarations. Generate the test code from the real
exported signatures at implementation time.

**Step 4: Run and verify**

```bash
npm test
npm run lint
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

Expected: all pass, test count up.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: cursor, backoff and serial entry queue for the client"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Client state and MLS actions

**Verifies:** realistic-demo.AC2.1 (confirmed in the browser in Task 6)

**Files:**
- Create: `example-realistic-demo/client/state.ts`
- Create: `example-realistic-demo/client/mls-actions.ts`

**Step 1: Create `state.ts`**

One client, not a map. Signals per the repository convention, with
`batch` around sequential writes.

```ts
import { signal, computed, type Signal } from '@preact/signals'
import type { ClientState, CiphersuiteImpl } from '../../src/index.js'
import type { PendingRequest } from '../protocol.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

export type View = 'setup'|'waiting'|'room'|'gone'

export type ConnectionStatus =
    | 'idle'
    | 'connecting'
    | 'open'
    | 'reconnecting'
    | 'closed'

export interface TimelineMessage {
    from:string
    text:string
    seq:number
}

export interface RealisticState {
    ciphersuite:Signal<CiphersuiteImpl|null>
    user:Signal<DemoUser|null>
    group:Signal<ClientState|null>
    roomId:Signal<string|null>
    creatorToken:Signal<string|null>
    isCreator:Signal<boolean>
    expiresAt:Signal<number|null>
    cursor:Signal<number>
    priorCount:Signal<number>
    live:Signal<string[]>
    pending:Signal<PendingRequest[]>
    messages:Signal<TimelineMessage[]>
    persist:Signal<boolean>
    status:Signal<string>
    connection:Signal<ConnectionStatus>
    roomMissing:Signal<boolean>
    removed:Signal<boolean>
    view:Signal<View>
}

export function createRealisticState ():RealisticState {
    const user = signal<DemoUser|null>(null)
    const group = signal<ClientState|null>(null)
    const roomId = signal<string|null>(null)
    const roomMissing = signal(false)

    /**
     * The view is derived, never assigned. Four signals fully determine
     * which of the four screens is correct, so storing the answer
     * separately would only create a way for it to disagree.
     */
    const view = computed<View>(() => {
        if (roomMissing.value) return 'gone'
        if (!user.value || !roomId.value) return 'setup'
        return group.value ? 'room' : 'waiting'
    })

    return {
        ciphersuite: signal(null),
        user,
        group,
        roomId,
        creatorToken: signal(null),
        isCreator: signal(false),
        expiresAt: signal(null),
        cursor: signal(0),
        priorCount: signal(0),
        live: signal([]),
        pending: signal([]),
        messages: signal([]),
        persist: signal(false),
        status: signal('Ready'),
        // Explicit type argument: signal('idle') would infer
        // Signal<string>, which does not satisfy
        // Signal<ConnectionStatus>.
        connection: signal<ConnectionStatus>('idle'),
        roomMissing,
        removed: signal(false),
        view
    }
}
```

`DemoUser` is imported from `example-shared/`, which is exactly the
reuse Phase 1 existed to enable.

**Step 2: Create `mls-actions.ts`**

Every MLS operation the client performs. It imports from `../../src/`,
never reimplementing anything the library already provides -- in
particular the base64 helpers.

```ts
import {
    getCipherSuite,
    generateKeyPackage,
    createGroup,
    createApplicationMessage,
    encodeMlsMessage,
    bytesToBase64,
    bytesToBase64url,
    defaultCapabilities,
    defaultLifetime,
    type CiphersuiteImpl,
    type ClientState,
    type KeyPackage
} from '../../src/index.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

export async function initCiphersuite ():Promise<CiphersuiteImpl> {
    return getCipherSuite()
}

/**
 * Exactly one key package and exactly one signature keypair, generated
 * non-extractable so its private bits can never leave the browser. The
 * `false` is ADR-001 in one argument.
 */
export async function createUser (
    name:string,
    cs:CiphersuiteImpl
):Promise<DemoUser> {
    const signatureKeyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false,
        ['sign', 'verify']
    )

    const { publicPackage, privatePackage } = await generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name)
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        cs,
        { signatureKeyPair: signatureKeyPair as CryptoKeyPair }
    )

    return {
        name,
        keyPackage: publicPackage,
        privateKeys: privatePackage
    }
}

/**
 * Identity on the wire is the signature public key, never the display
 * name. Names never cross the socket at all.
 */
export function identityOf (keyPackage:KeyPackage):string {
    return bytesToBase64url(keyPackage.leafNode.signaturePublicKey)
}

/**
 * The group id is random and has nothing to do with the room id. The
 * room id is a URL people paste to each other; the group id is MLS
 * state. Deriving one from the other would tie a protocol identifier to
 * a routing one for no benefit.
 */
export async function createOwnGroup (
    user:DemoUser,
    cs:CiphersuiteImpl
):Promise<ClientState> {
    if (!user.keyPackage || !user.privateKeys) {
        throw new Error('user has no key package')
    }

    const groupId = cs.rng.randomBytes(32)

    return createGroup(
        groupId,
        user.keyPackage,
        user.privateKeys,
        [],
        cs
    )
}

export async function encryptMessage (
    state:ClientState,
    text:string,
    cs:CiphersuiteImpl
):Promise<{ newState:ClientState; payload:string }> {
    const result = await createApplicationMessage(
        state,
        new TextEncoder().encode(text),
        cs,
        new Uint8Array(0)
    )

    const bytes = encodeMlsMessage({
        wireformat: 'mls_private_message',
        version: 'mls10',
        privateMessage: result.privateMessage
    })

    return {
        newState: result.newState,
        payload: bytesToBase64(bytes)
    }
}
```

**Step 3: Typecheck and lint**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

Expected: clean. If `generateKeyPackage`'s options type rejects the cast,
read its real signature in `src/key-package.ts` and match it exactly
rather than widening with `any`.

**Step 4: Do not commit yet**

Task 4 gives these a socket.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: The delivery client

**Verifies:** realistic-demo.AC1.2, realistic-demo.AC2.4 (both confirmed
in the browser in Task 6)

**Files:**
- Create: `example-realistic-demo/client/delivery-client.ts`

**Step 1: Create the module**

All network I/O lives here and nowhere else.

```ts
import { batch } from '@preact/signals'
import {
    isRoomMessage,
    type ClientMessage,
    type LogEntry,
    type RoomMessage
} from '../protocol.js'
import { advanceCursor, reconnectDelay } from './delivery-cursor.js'
import { createEntryQueue, type EntryQueue } from './entry-queue.js'
import type { RealisticState } from './state.js'

/**
 * The socket is same-origin and derived from where the page was loaded
 * from. There is no configured endpoint and no build-time origin
 * variable -- that is the entire reason one Worker serves both the page
 * and the delivery service.
 */
export function socketUrl (roomId:string):string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${location.host}/api/room/${roomId}/ws`
}

export interface DeliveryClient {
    connect (roomId:string):void
    send (msg:ClientMessage):boolean
    close ():void
    readonly queue:EntryQueue<LogEntry>
}

export interface DeliveryOptions {
    state:RealisticState
    applyEntry (entry:LogEntry):Promise<void>
    onRoomMessage (msg:RoomMessage):void

    /**
     * Called once each time the socket opens, including after every
     * reconnect. The caller sends `hello` or `create` from here.
     *
     * This hook is not optional decoration. `connect()` returns as soon
     * as the WebSocket is constructed, while `readyState` is still
     * CONNECTING, so anything sent immediately after it is dropped by
     * `send()`. And a reconnected socket carries no `serializeAttachment`
     * until it says `hello` again, so without this the room answers
     * `bad-message` to everything and never replays.
     */
    onOpen (isReconnect:boolean):void
}

export function createDeliveryClient (
    opts:DeliveryOptions
):DeliveryClient {
    const { state } = opts
    let ws:WebSocket|null = null
    let attempt = 0
    let closedByUs = false
    let timer:ReturnType<typeof setTimeout>|null = null
    let keepalive:ReturnType<typeof setInterval>|null = null

    const queue = createEntryQueue<LogEntry>({
        apply: opts.applyEntry,
        onError (err, entry) {
            // A commit that will not process is fatal for group state.
            // Advancing past it would corrupt the epoch silently, so
            // stop and say so.
            if (entry.kind === 'commit') {
                state.status.value =
                    'Could not process a group change. Reload to ' +
                    'resynchronise.'
                return 'stop'
            }

            // An application message that will not decrypt is ordinary
            // forward secrecy, not an error. Count it and keep going.
            //
            // This advance is required, not incidental. Leaving the
            // cursor behind here would make every following entry
            // report a gap, and a run of undecryptable entries could
            // never be traversed -- which is exactly what AC6.4 asks
            // for. This is the second and only other place the cursor
            // moves; see connection.ts for the success path.
            state.cursor.value = advanceCursor(
                state.cursor.value,
                entry.seq
            )
            return 'continue'
        }
    })

    function connect (roomId:string):void {
        // Never leave a previous socket open. connect() is called on
        // first use and on every reconnect, and two live sockets for
        // one identity would make the room close one of them anyway.
        //
        // No flag is set around this. The old socket's close event
        // fires asynchronously, by which time any shared flag would
        // have been reset -- the listeners below identify their own
        // socket instead.
        if (ws) ws.close()

        closedByUs = false
        stopKeepalive()
        state.connection.value = attempt === 0 ?
            'connecting' :
            'reconnecting'

        const socket = new WebSocket(socketUrl(roomId))
        ws = socket

        socket.addEventListener('open', () => {
            // A socket that is no longer the current one has been
            // retired by a later connect(). Ignore it entirely.
            if (socket !== ws) return

            const isReconnect = attempt > 0
            attempt = 0
            state.connection.value = 'open'
            startKeepalive(socket)
            // Identity is re-established here, every time. Nothing else
            // may be sent before this.
            opts.onOpen(isReconnect)
        })

        socket.addEventListener('message', ev => {
            const data = String(ev.data)

            // The room's auto-response to a keepalive. Not a
            // RoomMessage and not JSON.
            if (data === 'pong') return

            let parsed:unknown
            try {
                parsed = JSON.parse(data)
            } catch (_err) {
                return
            }
            if (!isRoomMessage(parsed)) return
            opts.onRoomMessage(parsed)
        })

        socket.addEventListener('close', () => {
            // A retired socket closing is expected and must not
            // schedule anything -- otherwise replacing a socket would
            // trigger a reconnect that replaces it again, forever.
            if (socket !== ws) return

            if (closedByUs) {
                state.connection.value = 'closed'
                return
            }
            scheduleReconnect(roomId)
        })

        socket.addEventListener('error', () => {
            // 'close' always follows, so reconnection is handled there.
            socket.close()
        })
    }

    /**
     * The room configures an auto-response pair so a keepalive is
     * answered without waking the Durable Object. Sending one
     * periodically is what makes that configuration do anything, and it
     * keeps intermediaries from closing an idle socket.
     *
     * The literal must be exactly 'ping' -- it is matched against the
     * WebSocketRequestResponsePair the room registered.
     */
    function stopKeepalive ():void {
        if (keepalive === null) return
        clearInterval(keepalive)
        keepalive = null
    }

    function startKeepalive (socket:WebSocket):void {
        // Only one ever runs. Without clearing the previous one first,
        // each reconnect would leave another interval alive.
        stopKeepalive()
        keepalive = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN) {
                stopKeepalive()
                return
            }
            socket.send('ping')
        }, 30_000)
    }

    function scheduleReconnect (roomId:string):void {
        const delay = reconnectDelay(attempt)
        attempt = attempt + 1

        batch(() => {
            state.connection.value = 'reconnecting'
            state.status.value = 'Connection lost. Reconnecting...'
        })

        timer = setTimeout(() => connect(roomId), delay)
    }

    return {
        connect,
        send (msg:ClientMessage):boolean {
            // A send while disconnected is reported, never silently
            // dropped -- the caller decides what to tell the person.
            if (!ws || ws.readyState !== WebSocket.OPEN) return false
            ws.send(JSON.stringify(msg))
            return true
        },
        close ():void {
            closedByUs = true
            if (timer) clearTimeout(timer)
            stopKeepalive()
            ws?.close()
        },
        queue
    }
}
```

Note the socket is never told where to connect. `socketUrl` reads
`location`, so the page connects to whatever origin served it -- which is
realistic-demo.AC1.2, and is only possible because one Worker does both
jobs.

**Step 2: Typecheck and lint**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

Expected: clean.

**Step 3: Do not commit yet**

Task 5 mounts it.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Mount the page and the setup view

**Verifies:** realistic-demo.AC1.1, realistic-demo.AC2.2,
realistic-demo.AC2.3, realistic-demo.AC2.4 (all confirmed in the browser
in Task 6)

**Files:**
- Create: `example-realistic-demo/client/views/setup.ts`
- Create: `example-realistic-demo/client/views/room.ts` (minimal
  placeholder; Phase 8 builds the chat pane)
- Create: `example-realistic-demo/client/style.css`
- Modify: `example-realistic-demo/client/index.ts` (replaces the Phase 2
  placeholder)
- Modify: `example-realistic-demo/client/index.html`

**Step 1: Write `views/setup.ts`**

A preact component using `htm`, matching the style of
`example-shared/card-header.ts`. It must:

- Show a name field and a "Create room" action when there is no user and
  no room id in the path.
- On submit: initialise the ciphersuite if needed, call `createUser`,
  then `createOwnGroup`, then generate a room id with
  `nanoid(ROOM_ID_LENGTH)` imported from `../../room-logic.js`, then
  `connect(roomId)`.

  **Do not send `create` here.** `connect()` returns while the socket is
  still CONNECTING. Record that a create is intended -- Task 6's
  `onOpen` handler sends `{ type:'create', identity }` once the socket is
  actually open.
- Wrap sequential signal writes in `batch`.
- Use `useSignal` for component-local state such as the typed name --
  never `useState`.
- On `created`, store the `creatorToken` and `expiresAt`, set
  `isCreator`, and navigate to `/<roomId>` with
  `history.pushState` followed by dispatching the route event so
  `route-event` picks it up.
- On `error` with reason `room-exists`, surface it in `state.status`
  rather than throwing. Generating a fresh id and retrying once is
  acceptable; silently ignoring it is not.
- Render the **full absolute room URL** (`location.origin + '/' + roomId`)
  and a copy control using `navigator.clipboard.writeText`, with a
  visible confirmation that it copied. This is
  realistic-demo.AC2.3.

**Step 2: Write a minimal `views/room.ts`**

Enough to prove the connection: show the room URL, the connection status,
the epoch from `state.group.value?.groupContext.epoch`, and the live
list. Phase 7 adds membership and approvals; Phase 8 adds chat. Do not
build those here.

**Step 3: Write `client/index.ts`**

```ts
import { render } from 'preact'
import { html } from 'htm/preact'
import Route from 'route-event'
import { createRealisticState } from './state.js'
// ...view imports
```

It must:

- Create the state once at module scope.
- Read `location.pathname` on load. A path of `/` is the setup view. A
  path of `/<something>` is a room id -- validate it with
  `isValidRoomId` from `../room-logic.js`, and treat an invalid one as
  `gone` rather than attempting to connect.
- Subscribe with `route-event` so `pushState` navigation re-renders.
- For a valid room id with no local user, probe `GET /api/room/<id>`
  first. A 404 sets `roomMissing`, giving the `gone` view. A 200 stores
  the times and shows the join path, which Phase 7 completes.
- Render the view named by the `view` computed signal.
- Catch any error from restore or setup and write it into
  `state.status` rather than letting it escape module evaluation, as the
  other persisting demos already do.

Task 6 adds the delivery client wiring this module needs. Write
`index.ts` in this task with the routing and rendering only; Task 6 fills
in the connection.

**Step 4: Write a minimal `client/style.css`**

**Copy** the CSS custom-property declarations from `example/style.css`
into this file -- do not `@import` that stylesheet. Importing it would
pull the existing demos' entire ruleset into a separate application and
couple the two appearances together. Copying just the variable block
keeps one palette without that coupling.

Do not invent a second palette, and **do not modify `example/style.css`**.
Use nested selectors rather than a proliferation of class names, and no
font size below 1rem. Keep it minimal; Phase 8 owns the finished look.

Link it from `client/index.html`.

**Step 5: Typecheck, lint, build**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
npm test
npm run build:realistic
```

Expected: all clean; the build writes `example-realistic-demo/dist`.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: realistic demo client shell, user and room creation"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Wire the connection -- dispatcher, open hook and cursor

**Verifies:** realistic-demo.AC10.4 (the wiring half; Task 2 tested the
rule)

**Files:**
- Create: `example-realistic-demo/client/connection.ts`
- Modify: `example-realistic-demo/client/index.ts`

Tasks 4 and 5 built a socket and a page. Nothing yet routes an inbound
`RoomMessage` to either, advances the cursor, or says `hello`. This task
owns all three. **Phases 7 and 8 both extend the functions created here**
-- they refer to "the entry-applying function", which is `applyEntry`
below.

**Step 1: Create `connection.ts`**

It exports one factory that builds the delivery client with all four
callbacks wired, so the page has a single place to look.

```ts
import { batch } from '@preact/signals'
import type { LogEntry, RoomMessage } from '../protocol.js'
import { advanceCursor, entryPosition } from './delivery-cursor.js'
import {
    createDeliveryClient,
    type DeliveryClient
} from './delivery-client.js'
import type { RealisticState } from './state.js'

export interface ConnectionDeps {
    state:RealisticState

    /** What this client will call itself in `hello` / `create`. */
    identity ():string|null

    /** True when this client is creating the room, not joining it. */
    isCreating ():boolean

    /** Apply one entry to group state. Phases 7 and 8 extend this. */
    applyEntry (entry:LogEntry):Promise<void>

    /**
     * Handle a control message. Phases 7 and 8 extend this.
     *
     * May return a promise, and for `welcome-you` it must: joining from
     * a Welcome is async, and the connection has to know when the group
     * exists before it can apply anything to it.
     */
    onControl (msg:RoomMessage):void|Promise<void>
}

export function createConnection (deps:ConnectionDeps):DeliveryClient {
    const { state } = deps

    // A `welcome-you` is followed immediately by the `log` batch, but
    // joining from the Welcome is async -- HPKE decryption, several
    // turns of the event loop. The batch would otherwise arrive while
    // `state.group` is still null and be thrown away, which is exactly
    // the offline-joiner case the demo exists to show. So entries are
    // held from the moment a Welcome arrives until the join resolves.
    let joinPending = false
    const held:LogEntry[] = []

    function pushEntries (entries:LogEntry[]):void {
        if (state.group.value) {
            delivery.queue.push(entries)
            return
        }

        if (joinPending) {
            held.push(...entries)
            return
        }

        // No group, and no Welcome in flight. This is a client waiting
        // for approval: the creator sends `mls{commit}` before
        // `welcome`, so the Add commit arrives before there is anything
        // to apply it to. Dropping is safe -- the replay that follows
        // `welcome-you` re-delivers it.
    }

    const delivery = createDeliveryClient({
        state,

        /**
         * Runs on the first open and on every reconnect. Identity has to
         * be re-established each time, because a reconnected socket
         * carries no attachment until it says `hello`.
         */
        onOpen (_isReconnect:boolean):void {
            const identity = deps.identity()
            if (!identity) return

            // A stop from a previous connection is cleared here, not on
            // the failure itself. The replay about to arrive re-delivers
            // from the last good cursor, so this is the one moment the
            // queue can safely accept entries again. Without it a single
            // fatal entry kills the client permanently.
            delivery.queue.reset()

            // `isCreating` stays true until `created` actually arrives,
            // so a socket that drops mid-creation retries the create
            // rather than sending `hello` to a room that was never
            // made and getting `no-room`.
            if (deps.isCreating()) {
                delivery.send({ type: 'create', identity })
                return
            }

            // Resume from the stored cursor so the room replays only
            // what was missed.
            delivery.send({
                type: 'hello',
                identity,
                cursor: state.cursor.value,
                creatorToken: state.creatorToken.value ?? undefined
            })
        },

        /**
         * Every entry goes through the queue, never straight to
         * applyEntry -- that is what keeps a live `entry` from
         * interleaving with a `log` batch.
         */
        async applyEntry (entry:LogEntry):Promise<void> {
            const position = entryPosition(state.cursor.value, entry)

            // Already applied. Happens whenever a replay overlaps what
            // was seen live.
            if (position === 'seen') return

            if (position === 'gap') {
                // Something was lost. Advancing would strand it
                // permanently, so stop and let the reconnect replay
                // from the last good cursor instead.
                throw new Error(
                    `gap before seq ${entry.seq}; ` +
                    `cursor is ${state.cursor.value}`
                )
            }

            await deps.applyEntry(entry)

            // Advanced only after a successful apply, and only by one.
            state.cursor.value = advanceCursor(
                state.cursor.value,
                entry.seq
            )
        },

        onRoomMessage (msg:RoomMessage):void {
            switch (msg.type) {
                case 'created':
                    batch(() => {
                        state.creatorToken.value = msg.creatorToken
                        state.expiresAt.value = msg.expiresAt
                        state.isCreator.value = true
                    })
                    break

                case 'room-state':
                    batch(() => {
                        state.isCreator.value = msg.isCreator
                        state.expiresAt.value = msg.expiresAt
                    })
                    break

                case 'no-room':
                    state.roomMissing.value = true
                    break

                case 'log':
                    // One push, so the whole batch drains before
                    // anything pushed after it.
                    pushEntries(msg.entries)
                    break

                case 'entry':
                    pushEntries([msg.entry])
                    break

                case 'welcome-you':
                    // Set before onControl runs, so the `log` message
                    // arriving next is held rather than dropped.
                    joinPending = true
                    break

                case 'roster':
                    state.live.value = msg.live
                    break

                case 'pending':
                    state.pending.value = msg.requests
                    break

                case 'error':
                    state.status.value =
                        `Server rejected that: ${msg.reason}`
                    break
            }

            // Every message is then offered to the page. Phases 7 and 8
            // hook onto specific ones -- `welcome-you` for joining,
            // `pending` for the approval prompt -- without
            // re-implementing this switch. Exactly one call, so a
            // handler never runs twice.
            const handled = deps.onControl(msg)

            if (msg.type !== 'welcome-you') {
                // The handler is async for every message type, not just
                // welcome-you -- `pending` runs the pre-approved
                // auto-commit inside it. An unobserved rejection there
                // would fail realistic-demo.AC4.2 silently, showing the
                // creator nothing but an unhandled-rejection warning in
                // the console.
                void Promise.resolve(handled).catch(err => {
                    state.status.value =
                        `Something failed handling ${msg.type}: ${err}`
                })
                return
            }

            // The group now exists (or the join failed). Either way the
            // hold is over.
            void Promise.resolve(handled).then(
                () => {
                    joinPending = false
                    const queued = held.splice(0)
                    if (queued.length > 0) delivery.queue.push(queued)
                },
                () => {
                    // The join failed. Discard rather than apply
                    // entries to a group that was never constructed.
                    joinPending = false
                    held.length = 0
                    state.status.value =
                        'Could not join from the invitation.'
                }
            )
        }
    })

    return delivery
}
```

Three notes for whoever extends this.

`log` is pushed as **one** array so the queue treats it as a single
batch. Pushing entries one at a time would still be ordered, but would
lose the batch boundary that realistic-demo.AC9.3 is about.

The cursor moves in exactly **two** places, and both are required.
Here, on the success path, after an entry applies. And in
`delivery-client.ts`'s `onError`, for an `application` entry that failed
to decrypt -- without that one, an undecryptable entry would leave the
cursor stuck and every following entry would report a gap, so a run of
them could never be traversed and realistic-demo.AC6.4 would be
impossible. It never moves from a control message.

`queue.reset()` is called from `onOpen`, not from the failure. A stop
must persist until a replay is about to re-deliver from the last good
cursor, which is precisely what a reconnect brings.

**Step 2: Handle a joiner's pre-join entries**

A joiner adopts a cursor from `welcome-you` that sits at the commit which
added it. Phase 5 makes the room send `welcome-you` before the `log`
batch, so by the time entries arrive the cursor is already correct and
`entryPosition` reports everything older as `'seen'` -- which the
`applyEntry` above skips.

Two distinct things have to be true here, and conflating them is the
easiest way to break the offline joiner.

**Order on the wire.** Phase 5 Task 4 Step 4 makes the room send
`welcome-you` before the `log` batch. If a joiner's `log` arrives first,
that fix is not in place -- check `onHello` in the Worker.

**Timing in the client.** Order on the wire is not sufficient, because
joining from the Welcome is **async**: `joinFromWelcome` does HPKE
decryption and settles many turns after the message handler returns. The
`log` message is dispatched as the very next WebSocket event, long before
`state.group` is set. A plain `if (!state.group.value) break` would
therefore throw away the entire replay of a joiner who was offline when
approved -- the demo's headline scenario -- and nothing would re-request
it, because the keepalive prevents the reconnect that would recover it.

That is why `pushEntries` distinguishes three states rather than two:
group present (apply), join in flight (hold, then flush), and neither
(drop, because the creator sends `mls{commit}` before `welcome`, so a
client awaiting approval genuinely has nothing to apply it to and the
post-Welcome replay re-delivers it).

If a joiner ends up missing messages sent while it was away, look at
`joinPending` and the flush, not at Phase 5.

**Step 3: Wire it into `index.ts`**

Replace the placeholder connection handling with `createConnection`,
passing:

- `identity`: `state.user.value` mapped through `identityOf`, or null.
- `isCreating`: true on the create-a-room path from Task 5, and staying
  true until a `created` message arrives. Do not clear it merely because
  the first socket opened -- a drop mid-creation must retry the create.
- `applyEntry`: for now, a function that handles nothing and resolves.
  Phase 7 adds commit processing and Phase 8 adds application messages.
- `onControl`: for now, a no-op. Phases 7 and 8 extend it.

**Call `delivery.connect(roomId)` only once an identity exists** -- that
is, after the user has been created or restored, never on page load for a
bare room id. `onOpen` returns without sending anything when
`identity()` is null, so connecting earlier produces a socket that
identifies itself to nobody and receives nothing. The probe of
`GET /api/room/<id>` is what the page uses before an identity exists;
the socket comes after.

Connect exactly once per room. `connect()` closes any previous socket
before opening a new one, so a second call is survivable, but two
independent call sites racing is not a design to rely on.

**Step 4: Typecheck, lint, test**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
npm test
npm run build:realistic
```

Expected: all clean.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire the delivery connection, dispatcher and cursor"
```
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Verify in a browser

**Verifies:** realistic-demo.AC1.1, realistic-demo.AC1.2,
realistic-demo.AC2.1, realistic-demo.AC2.2, realistic-demo.AC2.3,
realistic-demo.AC2.4

**Files:** None modified unless a defect is found.

**Step 1: Start both processes**

```bash
npm run worker:dev
```

and in a second terminal:

```bash
npm run dev:realistic
```

**Step 2: Create a user and a room (realistic-demo.AC2.1, AC2.2)**

Open `http://localhost:1234/`. Enter a name and create a room.

Confirm in the browser devtools console:

- Exactly one key package was generated. Log
  `state.user.value.keyPackage` once and confirm it is a single object,
  not an array or a repeated call.
- The signature private key is **non-extractable**. Evaluate
  `state.user.value.privateKeys.signaturePrivateKey` and confirm the
  underlying `CryptoKey` reports `extractable === false`. If it reports
  `true`, the `false` argument was lost somewhere between
  `crypto.subtle.generateKey` and `generateKeyPackage`.
- The group has exactly one member. Confirm the epoch is `0n` and the
  ratchet tree holds a single leaf.
- The group id is **not** derived from the room id. Compare
  `bytesToBase64url(state.group.value.groupContext.groupId)` against the
  room id in the URL and confirm they are unrelated.

Confirm the URL became `/<roomId>` and the page did not reload.

**Step 3: Check the room URL display (realistic-demo.AC2.3)**

Confirm the full absolute URL is shown, including origin, and that the
copy control puts exactly that string on the clipboard. Paste it
somewhere to check.

**Step 4: Check the SPA fallback (realistic-demo.AC1.1)**

Hard-reload the page at `/<roomId>`. It must render, not 404. Then
against the Worker directly:

```bash
curl -o /dev/null -w '%{http_code}\n' http://localhost:8787/aB3xK9pQ2m
```

Expected: `200`.

**Step 5: Check the socket origin (realistic-demo.AC1.2)**

In the devtools Network tab, filter to WS. Confirm the socket URL host
matches the page host exactly, and that nothing in the source contains a
hardcoded or configured endpoint:

```bash
grep -rn "localhost:8787\|workers.dev\|VITE_" example-realistic-demo/client
```

Expected: no output. The only place `8787` may appear is the Vite proxy
config, which is development-only.

**Step 6: Check duplicate creation (realistic-demo.AC2.4)**

With the room already created, send a second `create` for the same room
id. The simplest way is from the devtools console on the open socket, or
by extending the probe script. Assert the reply is
`{"type":"error","reason":"room-exists"}` and that the page surfaces it
rather than failing silently.

**Step 7: Check the reconnect path (supports realistic-demo.AC10.5)**

With the page open, stop `wrangler dev`. The status must report
reconnecting, and the retry interval must visibly grow rather than
hammering. Restart `wrangler dev` and confirm the page reconnects on its
own and the connection status returns to open.

**Step 8: Stop both processes**

Stop the Vite server and `wrangler dev`. Do not leave either running.
<!-- END_TASK_7 -->

---

## Phase 6 completion checklist

- [ ] `delivery-cursor.ts` and `entry-queue.ts` are free of DOM and
      WebSocket references and are unit tested
- [ ] Cursor never moves backward and never crosses a gap
- [ ] Backoff grows and is capped
- [ ] A push during a drain is applied after the batch, never
      interleaved, and starts no second drain
- [ ] A failing commit stops the queue; a failing decrypt does not
- [ ] `onOpen` sends `create` or `hello` on first open and on every
      reconnect; nothing is sent while the socket is CONNECTING
- [ ] One function owns the `RoomMessage` switch, and every variant is
      handled
- [ ] The cursor moves in exactly two places -- the queue's success
      path, and `onError` for an undecryptable `application` entry --
      and never from a control message
- [ ] `queue.reset()` is called from `onOpen`, so a stop does not
      permanently kill the client
- [ ] `log` and `entry` are held while a Welcome is in flight and
      flushed when the join resolves, not dropped
- [ ] `onControl` may return a promise, and `welcome-you` returns one
- [ ] A rejection from `onControl` is observed for every message type,
      not only `welcome-you`
- [ ] `deps.onControl` is called exactly once per message
- [ ] `connect()` is called only once an identity exists
- [ ] `isCreating` stays true until `created` arrives
- [ ] Only one keepalive interval exists at a time, and `close()` clears
      it
- [ ] A `log` batch is pushed as one array, not entry by entry
- [ ] Exactly one key package and one non-extractable signature keypair
      per user
- [ ] Group created with the local user as its only member, at epoch 0
- [ ] Group id independent of the room id
- [ ] Navigation to `/<roomId>` without a reload
- [ ] Full absolute room URL displayed and copyable
- [ ] `room-exists` surfaced rather than swallowed
- [ ] No configured endpoint anywhere in `client/`
- [ ] `npm test`, `npm run lint`, typecheck, and `build:realistic` pass
- [ ] Both dev servers stopped
