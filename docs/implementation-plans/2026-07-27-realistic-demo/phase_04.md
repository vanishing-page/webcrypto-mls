# Realistic Demo Implementation Plan -- Phase 4: Room log, replay, and liveness

**Goal:** A room that stores every message in order, replays from any
cursor, and reports who is connected.

**Architecture:** One Durable Object per room, SQLite-backed, reached by
name from the Worker's fetch handler. Sockets are accepted through the
WebSocket Hibernation API so the object sleeps while connections stay
open. The room stores and forwards MLS payloads as opaque base64 and never
decodes one. Liveness is never stored -- it is derived from the open
sockets at read time, because it is a transport observation rather than
protocol state.

**Tech Stack:** Cloudflare Durable Objects (SQLite backend), WebSocket
Hibernation API, TypeScript 5.9, `@substrate-system/tapzero` for the pure
parts.

**Scope:** Phase 4 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### realistic-demo.AC1: The Worker serves the page and the API
- **realistic-demo.AC1.3 Success:** `GET /api/room/:id` for an existing
  room returns its creation and expiry times
- **realistic-demo.AC1.4 Failure:** `GET /api/room/:id` for an unknown
  id returns 404
- **realistic-demo.AC1.5 Failure:** A room id containing characters
  outside the nanoid alphabet, or matching a reserved prefix such as
  `api` or `assets`, is rejected rather than routed

### realistic-demo.AC9: Ordering integrity
- **realistic-demo.AC9.1 Success:** Entries are stored with monotonic
  `seq`, and a replay for a cursor returns only entries after it
- **realistic-demo.AC9.2 Success:** A second socket for the same identity
  replaces the first

**How these are verified.** The design puts anything requiring a
`DurableObject` or a `WebSocket` out of scope for automated tests. So
AC1.3, AC1.4, AC9.1 and AC9.2 are verified operationally against
`wrangler dev`, with the exact commands given in Task 5.

AC1.5 is different: room id validation is pure, so it is extracted into
`room-logic.ts` and unit tested in Node. The replay half of AC9.1 is
already automated by the `entriesAfter` tests from Phase 3; only the
"stored with monotonic seq" half is operational.

---

## Codebase verification findings

This phase builds directly on Phase 2's scaffolding and Phase 3's
modules. Confirmed available:

- `example-realistic-demo/index.ts` exists with a placeholder `Room`
  class extending `DurableObject` and a fetch handler answering
  `/api/health`. This phase replaces both.
- `example-realistic-demo/wrangler.jsonc` already declares the `ROOM`
  binding and registers `Room` with `"storage": "sqlite"` via `exports`.
  No config change is needed in this phase.
- `example-realistic-demo/worker-configuration.d.ts` provides the `Env`
  type including `ROOM`. Use whichever form the generated file exposes
  (global or exported), as established in Phase 2, Task 3, Step 3.
- `protocol.ts` provides `isClientMessage`, `ClientMessage`,
  `RoomMessage`, `LogEntry`, `EntryKind`.
- `room-logic.ts` provides `nextSeq`, `entriesAfter`, `entryFromMls`,
  `assembleRoster`, `classifyStanding`.
- `nanoid@^5.1.16` is a devDependency. Its default alphabet is
  `A-Za-z0-9_-` (64 characters). Room ids are generated client-side in
  Phase 6; this phase only validates them.

## External dependency findings

Verified against current Cloudflare documentation on 2026-07-27.

- `ctx.acceptWebSocket(ws, tags?)` -- tags are an optional
  `Array<string>`, **supplied only at accept time**, max 10 per socket,
  max 256 characters each.
  https://developers.cloudflare.com/durable-objects/api/state/
- `ctx.getWebSockets(tag?)` returns `Array<WebSocket>`, optionally
  filtered by tag.
- `ws.serializeAttachment(value)` / `ws.deserializeAttachment()` persist
  per-connection state across hibernation. Max serialized size **16,384
  bytes**; any structured-cloneable value.
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- In-memory state is reset when the object hibernates. Anything a socket
  needs after a wake must be in storage or in its attachment.
- `ctx.setWebSocketAutoResponse(pair)` with
  `new WebSocketRequestResponsePair(req, res)` answers a keepalive
  without waking the object. Request and response are limited to 2,048
  characters each.
- `ctx.storage.sql.exec(query, ...bindings)` is **synchronous** and
  returns a `SqlStorageCursor`. Cursors must be **fully consumed before
  the next `await`** (call `.toArray()` or `.one()` immediately) to keep
  snapshot isolation.
  https://developers.cloudflare.com/durable-objects/api/storage-api/
- `ctx.blockConcurrencyWhile(cb)` has a 30 second timeout. Use it for
  schema setup only.
- Maximum 32,768 WebSocket connections per Durable Object -- far above
  anything this demo reaches, noted only because it is the documented
  ceiling.

## Design correction: identity cannot be a hibernation tag

The design states that the identity is "both a hibernation tag, making
duplicate-socket replacement a tag lookup, and a `serializeAttachment`
value, so it survives hibernation."

**The tag half is not implementable as specified.** Tags are fixed at
`ctx.acceptWebSocket(ws, tags)` time, and `acceptWebSocket` must be called
before the 101 response is returned. At that moment the room does not yet
know who is connecting -- the identity arrives afterwards, in the `hello`
message. There is no API to add or change a tag on an already-accepted
socket.

Two ways out were considered:

1. Put the identity in the upgrade URL as a query parameter so it is
   available at accept time. Rejected: it puts the identity on the wire
   twice, in the URL and in `hello`, which creates a disagreement case
   that has to be detected and handled, and it would mean changing the
   frozen `ClientMessage` contract or living with a redundant field.
2. Carry the identity only in `serializeAttachment`, set when `hello`
   arrives, and find a duplicate by scanning `ctx.getWebSockets()`.

**This plan takes option 2.** Duplicate-socket replacement becomes a scan
over open sockets rather than a tag lookup. The cost is O(n) in the
number of live sockets in one room, which for this demo is a handful and
is bounded by the documented 32,768 ceiling regardless. Nothing else about
the design changes, and the wire contract is untouched.

---

## Commands used throughout this phase

- **Worker typecheck:**
  `npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Root typecheck:**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Run the Worker:** `npm run worker:dev` (port 8787)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add room id validation to the pure logic

**Verifies:** realistic-demo.AC1.5 (partially -- Task 5 confirms the
route actually rejects)

**Files:**
- Modify: `example-realistic-demo/room-logic.ts`

**Step 1: Append to `room-logic.ts`**

Add at the end of the file. This is the only definition of what a room id
may be, shared by the Worker's router and by the client's generator in
Phase 6.

```ts
/**
 * Room ids are generated with nanoid, whose default alphabet is
 * `A-Za-z0-9_-`. Ten characters is 60 bits, which is far more than a
 * demo room needs to avoid collisions.
 */
export const ROOM_ID_LENGTH = 10

/**
 * Words a room id must never be, so an id can never shadow a real path.
 * `api` is routed to the Worker by `run_worker_first`; `assets` is a
 * path the asset manifest may serve. Neither can currently collide,
 * because ids are a fixed ten characters and these are shorter -- the
 * check is here so that changing `ROOM_ID_LENGTH` cannot silently
 * introduce the collision.
 */
export const RESERVED_ROOM_IDS:readonly string[] = [
    'api',
    'assets',
    'docs',
    'index'
]

/**
 * Whether a path segment may be routed to a room. Anything failing this
 * is rejected before a Durable Object is named, so a malformed id can
 * never cause one to be created.
 */
export function isValidRoomId (id:unknown):id is string {
    if (typeof id !== 'string') return false
    if (id.length !== ROOM_ID_LENGTH) return false
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return false
    return !RESERVED_ROOM_IDS.includes(id.toLowerCase())
}
```

**Step 2: Do not commit yet**

Task 2 adds the tests.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test room id validation

**Verifies:** realistic-demo.AC1.5

**Files:**
- Modify: `test/example-realistic-demo/room-logic.ts`

**Step 1: Add tests to the existing file**

No new registration is needed -- `test/example-realistic-demo/room-logic.js`
is already imported by `test/index.ts` from Phase 3.

Tests must verify realistic-demo.AC1.5:

- A well-formed id of exactly `ROOM_ID_LENGTH` characters drawn from
  `A-Za-z0-9_-` is accepted. Cover ids using `-` and `_`, an all-digit
  id, and a mixed-case id, since those are the alphabet's edges.
- An id containing a character outside the alphabet is rejected. Cover at
  least: a dot (`.`), a slash (`/`), a percent sign, a space, a plus
  (which is in standard base64 but not nanoid's alphabet), and a
  non-ASCII character. The slash case matters most -- it is what a path
  traversal attempt looks like.
- An id of the wrong length is rejected, both shorter and longer.
- Every entry in `RESERVED_ROOM_IDS` is rejected, and rejected
  case-insensitively (`API` and `Api` as well as `api`).
- A non-string is rejected: `null`, `undefined`, a number, an object, an
  array. The empty string too.

**Step 2: Run and verify**

```bash
npm test
```

Expected: passes, with the new cases visible and the total higher than
before.

**Step 3: Typecheck and lint**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

Expected: all clean.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: validate realistic-demo room ids"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Give the Room storage and sockets

**Verifies:** realistic-demo.AC9.1, realistic-demo.AC9.2 (confirmed
operationally in Task 5)

**Files:**
- Modify: `example-realistic-demo/index.ts` (replaces the placeholder
  `Room` class from Phase 2)

**Step 1: Replace the `Room` class**

Write the class below. It handles `create`, `hello` and `mls` only;
Phase 5 adds `join-request`, `approve`, `deny`, `removed` and `welcome`.

```ts
import { DurableObject } from 'cloudflare:workers'
import {
    isClientMessage,
    type ClientMessage,
    type LogEntry,
    type RoomMessage
} from './protocol.js'
import {
    assembleRoster,
    entriesAfter,
    entryFromMls,
    nextSeq
} from './room-logic.js'

const ROOM_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Row shapes are `type` aliases, not interfaces, and this is load
 * bearing. `sql.exec<T>` constrains T to
 * `Record<string, SqlStorageValue>`, and TypeScript gives an implicit
 * index signature to a type alias but not to an interface -- an
 * interface here fails the constraint with TS2344.
 */
type MetaRow = {
    created_at:number
    expires_at:number
    creator_identity:string
    creator_token:string
}

/**
 * The log row as SQLite returns it. Structurally identical to
 * `LogEntry`, but declared here as a type alias for the reason above --
 * `LogEntry` is an interface in the wire contract and must stay one.
 */
type LogRow = {
    seq:number
    sender:string
    kind:string
    payload:string
}

interface SocketState {
    identity:string
}

export class Room extends DurableObject<Env> {
    constructor (ctx:DurableObjectState, env:Env) {
        super(ctx, env)

        ctx.blockConcurrencyWhile(async () => {
            ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS meta (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    creator_identity TEXT NOT NULL,
                    creator_token TEXT NOT NULL
                )
            `)
            ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS log (
                    seq INTEGER PRIMARY KEY,
                    sender TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
            `)
        })

        // Answers keepalives without waking the object. Re-set on every
        // wake, which is harmless -- it replaces the same pair.
        ctx.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair('ping', 'pong')
        )
    }

    /**
     * The existence probe, called as RPC from the fetch handler. Returns
     * null when the room has no metadata, which is the same answer an
     * expired room gives -- after the alarm deletes everything, nothing
     * distinguishes expired from never-existed.
     */
    roomInfo ():{ createdAt:number; expiresAt:number }|null {
        const meta = this.readMeta()
        if (!meta) return null
        return {
            createdAt: meta.created_at,
            expiresAt: meta.expires_at
        }
    }

    async fetch (req:Request):Promise<Response> {
        if (req.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected websocket', { status: 426 })
        }

        const pair = new WebSocketPair()

        // Accepted untagged: the identity is not known until `hello`,
        // and tags cannot be added after accept. Identity is attached in
        // `hello` instead, via serializeAttachment.
        this.ctx.acceptWebSocket(pair[1])

        return new Response(null, { status: 101, webSocket: pair[0] })
    }

    async webSocketMessage (
        ws:WebSocket,
        raw:string|ArrayBuffer
    ):Promise<void> {
        if (typeof raw !== 'string') {
            return this.send(ws, { type: 'error', reason: 'bad-message' })
        }

        let parsed:unknown
        try {
            parsed = JSON.parse(raw)
        } catch (_err) {
            return this.send(ws, { type: 'error', reason: 'bad-message' })
        }

        if (!isClientMessage(parsed)) {
            return this.send(ws, { type: 'error', reason: 'bad-message' })
        }

        await this.handle(ws, parsed)
    }

    async webSocketClose (ws:WebSocket):Promise<void> {
        // The socket is already closing, so it is excluded from the
        // roster this broadcast computes.
        this.broadcastRoster(ws)
    }

    async webSocketError (ws:WebSocket):Promise<void> {
        this.broadcastRoster(ws)
    }

    // ---- message handling ----

    private async handle (
        ws:WebSocket,
        msg:ClientMessage
    ):Promise<void> {
        switch (msg.type) {
            case 'create':
                return this.onCreate(ws, msg.identity)
            case 'hello':
                return this.onHello(ws, msg.identity, msg.cursor)
            case 'mls':
                return this.onMls(ws, msg.kind, msg.payload)
            default:
                // Phase 5 adds the remaining control messages.
                return this.send(ws, {
                    type: 'error',
                    reason: 'bad-message'
                })
        }
    }

    private onCreate (ws:WebSocket, identity:string):void {
        if (this.readMeta()) {
            return this.send(ws, { type: 'error', reason: 'room-exists' })
        }

        const now = Date.now()
        const expiresAt = now + ROOM_LIFETIME_MS
        const token = crypto.randomUUID()

        this.ctx.storage.sql.exec(
            `INSERT INTO meta
                (id, created_at, expires_at, creator_identity,
                 creator_token)
             VALUES (1, ?, ?, ?, ?)`,
            now, expiresAt, identity, token
        )

        this.attach(ws, identity)
        this.send(ws, {
            type: 'created',
            creatorToken: token,
            expiresAt
        })
        this.broadcastRoster()
    }

    private onHello (
        ws:WebSocket,
        identity:string,
        cursor:number
    ):void {
        const meta = this.readMeta()
        if (!meta) {
            return this.send(ws, { type: 'no-room' })
        }

        this.replaceExistingSocket(ws, identity)
        this.attach(ws, identity)

        this.send(ws, {
            type: 'room-state',
            isCreator: meta.creator_identity === identity,
            createdAt: meta.created_at,
            expiresAt: meta.expires_at
        })

        const missed = this.entriesSince(cursor)
        if (missed.length > 0) {
            this.send(ws, { type: 'log', entries: missed })
        }

        this.broadcastRoster()
    }

    private onMls (
        ws:WebSocket,
        kind:LogEntry['kind'],
        payload:string
    ):void {
        const state = this.readAttachment(ws)
        if (!state) {
            return this.send(ws, {
                type: 'error',
                reason: 'bad-message'
            })
        }

        if (!this.readMeta()) {
            return this.send(ws, { type: 'no-room' })
        }

        const seq = nextSeq(this.highWater())
        // kind and payload cross untouched. The room never decodes an
        // MLS payload and asserts nothing about what is inside it.
        const entry = entryFromMls(seq, state.identity, kind, payload)

        this.ctx.storage.sql.exec(
            `INSERT INTO log (seq, sender, kind, payload)
             VALUES (?, ?, ?, ?)`,
            entry.seq, entry.sender, entry.kind, entry.payload
        )

        // Broadcast to everyone except the sender: an MLS sender cannot
        // decrypt its own application message, so echoing it back would
        // only ever produce a decrypt failure.
        for (const peer of this.ctx.getWebSockets()) {
            if (peer === ws) continue
            this.send(peer, { type: 'entry', entry })
        }
    }

    // ---- storage helpers ----

    private readMeta ():MetaRow|null {
        const rows = this.ctx.storage.sql
            .exec<MetaRow>('SELECT * FROM meta WHERE id = 1')
            .toArray()
        return rows[0] ?? null
    }

    private highWater ():number {
        const rows = this.ctx.storage.sql
            .exec<{ hw:number }>(
                'SELECT COALESCE(MAX(seq), 0) AS hw FROM log'
            )
            .toArray()
        return rows[0]?.hw ?? 0
    }

    private entriesSince (cursor:number):LogEntry[] {
        const rows = this.ctx.storage.sql
            .exec<LogRow>(
                `SELECT seq, sender, kind, payload FROM log
                 WHERE seq > ? ORDER BY seq ASC`,
                cursor
            )
            .toArray()

        // `kind` comes back as a plain string from SQLite. It only ever
        // got there from an already-narrowed EntryKind, so the cast is
        // recovering a fact rather than asserting a new one.
        const entries = rows.map(row => ({
            seq: row.seq,
            sender: row.sender,
            kind: row.kind as LogEntry['kind'],
            payload: row.payload
        }))

        // The WHERE clause is the fast path; entriesAfter is the tested
        // statement of the rule and re-asserts both the strict
        // inequality and the ordering regardless of what storage
        // returned.
        return entriesAfter(entries, cursor)
    }

    // ---- socket helpers ----

    private attach (ws:WebSocket, identity:string):void {
        const state:SocketState = { identity }
        ws.serializeAttachment(state)
    }

    private readAttachment (ws:WebSocket):SocketState|null {
        const value = ws.deserializeAttachment()
        if (!value || typeof value !== 'object') return null
        const identity = (value as SocketState).identity
        return typeof identity === 'string' ? { identity } : null
    }

    /**
     * A second socket for one identity replaces the first. Reconnects
     * are common -- a laptop lid, a tunnel -- and leaving the stale
     * socket open would double every broadcast and make the roster lie.
     *
     * This is a scan rather than a tag lookup because tags can only be
     * set at accept time, before `hello` has said who this is.
     */
    private replaceExistingSocket (
        incoming:WebSocket,
        identity:string
    ):void {
        for (const peer of this.ctx.getWebSockets()) {
            if (peer === incoming) continue
            const state = this.readAttachment(peer)
            if (state?.identity !== identity) continue
            try {
                peer.close(1000, 'replaced by a newer connection')
            } catch (_err) {
                // Already closing. Nothing to do.
            }
        }
    }

    private send (ws:WebSocket, msg:RoomMessage):void {
        try {
            ws.send(JSON.stringify(msg))
        } catch (_err) {
            // Socket closed underneath us. The close handler will
            // reconcile the roster.
        }
    }

    /**
     * Liveness is derived, never stored. `excluding` is the socket that
     * is currently closing, which still appears in getWebSockets().
     */
    private broadcastRoster (excluding?:WebSocket):void {
        const meta = this.readMeta()
        if (!meta) return

        const known = [meta.creator_identity]
        const liveTags:string[] = []

        for (const peer of this.ctx.getWebSockets()) {
            if (peer === excluding) continue
            const state = this.readAttachment(peer)
            if (state) liveTags.push(state.identity)
        }

        // Phase 5 extends `known` with the admitted-minus-removed
        // ledger. Until then only the creator is known to belong.
        const live = assembleRoster(known, liveTags)
        const msg:RoomMessage = { type: 'roster', live }

        for (const peer of this.ctx.getWebSockets()) {
            if (peer === excluding) continue
            this.send(peer, msg)
        }
    }
}
```

Four things here are deliberate and must not be "simplified":

- `seq` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, and the value
  comes from `nextSeq(this.highWater())`. Letting SQLite assign it would
  work too, but then the monotonicity rule would live in the database
  where the Node test harness cannot reach it. A Durable Object is
  single-threaded, so computing it in JavaScript has no race.
- Every `sql.exec` is followed immediately by `.toArray()`. Cloudflare
  requires cursors be fully consumed before the next `await`; a cursor
  left open across one loses snapshot isolation.
- `onMls` broadcasts to every socket *except* the sender. This is what
  makes "a sender cannot read its own message" a non-issue while live.
  It resurfaces on replay, which Phase 8 handles.
- `broadcastRoster` takes an `excluding` socket. During
  `webSocketClose` the closing socket is still returned by
  `getWebSockets()`, so without this the roster would report a member as
  connected at the exact moment they disconnected.

**Step 2: Typecheck**

```bash
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

Expected: clean. If `Env` is not found, check how
`worker-configuration.d.ts` exposes it and import or reference it
accordingly.

**Step 3: Do not commit yet**

Task 4 replaces the fetch handler, without which none of this is
reachable.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Route the API to the room

**Verifies:** realistic-demo.AC1.3, realistic-demo.AC1.4,
realistic-demo.AC1.5 (confirmed operationally in Task 5)

**Files:**
- Modify: `example-realistic-demo/index.ts` (the default export)

**Step 1: Replace the default export**

Add `isValidRoomId` to the existing import from `./room-logic.js`, then
replace the placeholder fetch handler:

```ts
export default {
    async fetch (req:Request, env:Env):Promise<Response> {
        const url = new URL(req.url)

        // Answered without naming a Durable Object, so a health check
        // never causes one to exist.
        if (url.pathname === '/api/health') {
            return Response.json({ ok: true })
        }

        const match = /^\/api\/room\/([^/]*)(\/ws)?$/
            .exec(url.pathname)

        if (!match) {
            return new Response('not found', { status: 404 })
        }

        const roomId = match[1]
        const wantsSocket = match[2] === '/ws'

        // Validated before the room is named. An id that cannot be a
        // room never causes a Durable Object to be created, which is
        // what stops a malformed or reserved id from being routed.
        if (!isValidRoomId(roomId)) {
            return new Response('bad room id', { status: 400 })
        }

        const room = env.ROOM.getByName(roomId)

        if (wantsSocket) {
            if (req.headers.get('Upgrade') !== 'websocket') {
                return new Response('expected websocket', { status: 426 })
            }
            return room.fetch(req)
        }

        if (req.method !== 'GET') {
            return new Response('method not allowed', { status: 405 })
        }

        const info = await room.roomInfo()

        if (!info) {
            return new Response('no such room', { status: 404 })
        }

        return Response.json(info)
    }
}
```

`getByName(roomId)` is used rather than `idFromName` then `get`. Both
route deterministically to the same object; `getByName` is the current
documented form and is one call instead of two.

`roomInfo()` is called as an RPC method, not through `fetch`. The
WebSocket upgrade is the one thing that must go through `fetch`, because
it returns a 101 with a socket attached.

**Step 2: Typecheck and lint**

```bash
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

Expected: both clean.

**Step 3: Confirm nothing else regressed**

```bash
npm test
npm run build-example
```

Expected: tests pass with the count unchanged from Task 2, and the
existing demos still build.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: room log, replay and liveness over hibernating sockets"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Verify the room against a running Worker

**Verifies:** realistic-demo.AC1.3, realistic-demo.AC1.4,
realistic-demo.AC1.5, realistic-demo.AC9.1, realistic-demo.AC9.2

**Files:**
- Create: `example-realistic-demo/scripts/probe.mjs` (a development
  helper, committed so the checks are repeatable)

These behaviors need a real Durable Object and a real WebSocket, which the
Node test harness cannot provide. A small script makes them repeatable
rather than a one-off session of manual clicking.

Note the extension: `.mjs` is outside the `./**/*.{ts,js}` lint glob and
outside every tsconfig, so this file is committed code with no automated
gate on it. That is accepted deliberately -- it is a development probe,
not shipped code, and it must run under plain `node` with no build step.
Keep it simple enough that the absence of a typechecker does not matter.

**Step 1: Write the probe script**

Create `example-realistic-demo/scripts/probe.mjs`, a plain Node script
using the built-in `WebSocket` global (Node 22, which CI pins). It takes
a base URL argument defaulting to `http://localhost:8787` and runs the
checks below, printing a pass or fail line for each and exiting non-zero
if any failed.

It must perform, in order:

1. `GET /api/room/<valid-unused-id>` and assert **404**. This is
   realistic-demo.AC1.4, and it must run before any socket creates the
   room.
2. `GET /api/room/<invalid-id>` for each of: an id with a `/`, an id with
   a `.`, an id of the wrong length, and the literal `api`. Assert
   **400** for each, not 404 and not 500. This is realistic-demo.AC1.5 at
   the routing layer.
3. Open a socket to `/api/room/<id>/ws`, send
   `{"type":"create","identity":"<A>"}`, and assert a `created` reply
   carrying a `creatorToken` and an `expiresAt` roughly three days out.
4. `GET /api/room/<id>` and assert **200** with `createdAt` and
   `expiresAt` matching. This is realistic-demo.AC1.3.
5. Send three `mls` messages from A with distinct payloads. Open a
   second socket as identity B, send
   `{"type":"hello","identity":"<B>","cursor":0}`, and assert the `log`
   batch contains exactly those three entries with `seq` 1, 2, 3 in
   ascending order, and that each `payload` and `kind` came back
   **byte-identical** to what was sent. This is realistic-demo.AC9.1 and
   the storage half of realistic-demo.AC10.3.
6. Send a fourth `mls` from A and assert B receives it as a live `entry`
   with `seq` 4, and that **A does not receive its own entry back**.
7. Reconnect B with `cursor: 3` and assert the replay contains only
   `seq` 4 -- not entries 1 through 3. This is the replay half of
   realistic-demo.AC9.1.
8. Open a third socket, also as identity B, and send `hello`. Assert the
   **socket opened in check 7 receives a close event** -- that is B's
   currently-live socket; the original B socket from check 5 was already
   replaced. This is realistic-demo.AC9.2. Then assert the subsequent
   `roster` does not list B twice.

Use a fresh random room id per run so the script is repeatable without
clearing local state.

**Step 2: Start the Worker**

```bash
npm run worker:dev
```

**Step 3: Run the probe**

In a second terminal:

```bash
node example-realistic-demo/scripts/probe.mjs
```

Expected: every check prints a pass and the script exits 0.

If check 5 fails on payload comparison, something in the room is
transforming an MLS payload -- find it and remove it. The room must never
touch that string.

If check 8 fails, `replaceExistingSocket` is not matching on identity;
confirm `hello` is calling `attach` and that `deserializeAttachment`
returns the object that was stored.

**Step 4: Confirm liveness reflects a real disconnect**

With the Worker still running, open two sockets in the same room with
different identities, then kill one process. The surviving socket must
receive a `roster` that no longer lists the departed identity. The
departed member is only marked disconnected -- nothing removes them from
anything, because the room has no idea what group membership is.

**Step 5: Stop the Worker**

Stop the `wrangler dev` process. Do not leave it running.

**Step 6: Commit the probe script**

```bash
git add example-realistic-demo/scripts/probe.mjs
git commit -m "test: add realistic-demo room probe script"
```
<!-- END_TASK_5 -->

---

## Phase 4 completion checklist

- [ ] `isValidRoomId` unit tested, including the `/` and reserved-word
      cases
- [ ] `meta` and `log` tables created in `blockConcurrencyWhile`
- [ ] Every `sql.exec` consumed with `.toArray()` before any `await`
- [ ] `seq` minted through `nextSeq`, monotonic across inserts
- [ ] Replay for a cursor returns only entries strictly after it
- [ ] `payload` and `kind` round-trip byte-identical
- [ ] A sender does not receive its own live entry
- [ ] A second socket for one identity closes the first
- [ ] A closed socket drops out of the next `roster`
- [ ] A disconnected member is marked, never removed
- [ ] `GET /api/room/:id` returns 200 with times, or 404 when unknown
- [ ] An invalid or reserved id returns 400 without naming a room
- [ ] `npm test`, `npm run lint`, both typechecks pass
- [ ] Worker stopped
