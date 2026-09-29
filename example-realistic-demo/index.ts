import { DurableObject } from 'cloudflare:workers'
import {
    isClientMessage,
    MAX_WIRE_MESSAGE_LENGTH,
    type ClientMessage,
    type LogEntry,
    type PendingRequest,
    type RoomMessage
} from './protocol.js'
import { bytesToBase64url } from '../src/util/byte-array.js'
import {
    assembleRoster,
    classifyJoinRequest,
    classifyMlsWrite,
    classifyStanding,
    verifyIdentityProof,
    mayReplaceSocket,
    replayPage,
    entriesAfter,
    entryFromMls,
    isValidRoomId,
    mayCreateRoom,
    mayWriteLog,
    mayWriteKind,
    nextSeq,
    roomInfoDecision,
    securityHeaders,
    type RegistryEntry,
    type RoomState
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

/** A stored Welcome, waiting for its recipient to reconnect. */
type MailRow = {
    payload:string
    cursor:number
    prior_count:number
}

/** An outstanding join request, as the creator will be shown it. */
type PendingRow = {
    identity:string
    key_package:string
    requested_at:number
}

// The path every room lives under; `route` and `Room.fetch` both read it.
const ROOM_PREFIX = '/api/room/'

/**
 * What a socket carries across a hibernation. A `type` alias like the row
 * shapes above, for consistency rather than necessity -- this one is not
 * constrained by `sql.exec`, but a data shape declared two ways in one
 * file reads as a decision when it is not one.
 *
 * `isCreator` lives here rather than being re-derived per message because
 * the attachment is server-side state a client cannot reach or forge, and
 * because it means the token is compared once, at `hello`, instead of on
 * every control message.
 */
type SocketState = {
    /**
     * Always a proven identity. `attach` is only reached after
     * `requireProof`, and `readAttachment` reads a socket as unattached
     * unless `proven` is set, so no handler can see a claimed identity
     * that was never signed for.
     */
    identity:string
    proven:true
    isCreator:boolean

    /**
     * When this socket last had a join request accepted, or null if it
     * never has. Kept here rather than in a table because it throttles a
     * socket, not an identity: identities are free to mint, so a
     * per-identity limit would throttle nobody, and a socket is the one
     * thing a flooder has to pay to open.
     *
     * It rides the attachment across a hibernation, which is what stops a
     * flooder resetting it by going quiet for a moment.
     */
    lastJoinRequestAt:number|null

    /**
     * When this socket last had an `mls` write accepted, or null. Same
     * shape and same reasoning as `lastJoinRequestAt`: socket-scoped,
     * carried by `attach` across every rewrite.
     */
    lastMlsAt:number|null

    /**
     * The random challenge this socket was issued when it was accepted,
     * and the room id it was accepted for, which a `hello` or `create`
     * proves an identity over. See `verifyIdentityProof` in
     * `room-logic.ts`. Like the throttle, it is socket-scoped and has to
     * survive every `attach` rewrite: a socket is challenged once, so
     * losing it would leave nothing to prove against on the next
     * `hello`.
     */
    handshake:Handshake|null
}

type Handshake = {
    challenge:string
    roomId:string
}

export class Room extends DurableObject<Env> {
    constructor (ctx:DurableObjectState, env:Env) {
        super(ctx, env)

        ctx.blockConcurrencyWhile(async () => {
            this.ensureSchema()
        })

        // Answers keepalives without waking the object. Re-set on every
        // wake, which is harmless -- it replaces the same pair.
        ctx.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair('ping', 'pong')
        )
    }

    /**
     * Called on construction and again after the expiry alarm, because
     * `deleteAll()` drops the tables themselves rather than just their
     * rows. Without the second call every later `readMeta()` throws
     * `no such table: meta` instead of returning null, so an expired room
     * answered 500 and a `hello` to it got no answer at all.
     *
     * An expired room and an id that never existed then give the same
     * answer to every read of group data, because both hold no group
     * rows. They differ only in the `tombstone` row the alarm writes,
     * which is what stops `create` from reusing an expired id.
     */
    private ensureSchema ():void {
        const sql = this.ctx.storage.sql

        sql.exec(`
            CREATE TABLE IF NOT EXISTS meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                creator_identity TEXT NOT NULL,
                creator_token TEXT NOT NULL
            )
        `).toArray()
        sql.exec(`
            CREATE TABLE IF NOT EXISTS log (
                seq INTEGER PRIMARY KEY,
                sender TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL
            )
        `).toArray()
        // identity is the primary key, which is what makes a repeat
        // request replace the first rather than queue a second for the
        // creator to wade through. The schema enforces it, not
        // application logic that could be forgotten.
        sql.exec(`
            CREATE TABLE IF NOT EXISTS pending (
                identity TEXT PRIMARY KEY,
                key_package TEXT NOT NULL,
                requested_at INTEGER NOT NULL
            )
        `).toArray()
        // Likewise: one pending Welcome per recipient, replaced if
        // reissued.
        sql.exec(`
            CREATE TABLE IF NOT EXISTS mailbox (
                recipient TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                cursor INTEGER NOT NULL,
                prior_count INTEGER NOT NULL
            )
        `).toArray()
        // A composite key, so one identity can hold both rows at once.
        // That pair is what classifyStanding reads to answer
        // `previously-removed`. It is a current status rather than a
        // history: approving clears the removed row, because a member
        // let back in is a member.
        sql.exec(`
            CREATE TABLE IF NOT EXISTS ledger (
                identity TEXT NOT NULL,
                status TEXT NOT NULL,
                PRIMARY KEY (identity, status)
            )
        `).toArray()
        // The id this object was named by, written at `create` so the
        // alarm can tell the registry which id expired: a Durable Object
        // is not told its own name. Emptied by the alarm like group data.
        sql.exec(`
            CREATE TABLE IF NOT EXISTS name (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                room_id TEXT NOT NULL
            )
        `).toArray()
        // The record that this id held a room which expired. It carries
        // no group data, only the time, and one row at most.
        sql.exec(`
            CREATE TABLE IF NOT EXISTS tombstone (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                expired_at INTEGER NOT NULL
            )
        `).toArray()
    }

    /**
     * The existence probe, called as RPC from the fetch handler. Returns
     * null when the room has no metadata. An expired room answers null
     * too: the alarm deletes the metadata and leaves only a tombstone,
     * which this probe does not reveal, so the client shows the same
     * gone view for both. The tombstone matters only to `create`.
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
        // RFC 6455 makes the token case-insensitive.
        const upgrade = req.headers.get('Upgrade') ?? ''
        if (upgrade.toLowerCase() !== 'websocket') {
            return new Response('expected websocket', { status: 426 })
        }

        // `route` has already validated this id and named this object
        // by it; the object has no other way to learn its own name.
        const path = new URL(req.url).pathname
        const roomId = path.slice(ROOM_PREFIX.length, -'/ws'.length)
        if (!isValidRoomId(roomId)) {
            return new Response('bad room id', { status: 400 })
        }

        const pair = new WebSocketPair()

        // Accepted untagged: the identity is not known until `hello`,
        // and tags cannot be added after accept. Identity is attached in
        // `hello` instead, via serializeAttachment.
        this.ctx.acceptWebSocket(pair[1])

        // Challenged before it has said anything. Until `hello` the
        // attachment holds the challenge and nothing else, so
        // `readAttachment` still reads the socket as unattached.
        const challenge = bytesToBase64url(
            crypto.getRandomValues(new Uint8Array(32))
        )
        const handshake:Handshake = { challenge, roomId }
        pair[1].serializeAttachment({ handshake })
        this.send(pair[1], { type: 'challenge', challenge })

        return new Response(null, { status: 101, webSocket: pair[0] })
    }

    async webSocketMessage (
        ws:WebSocket,
        raw:string|ArrayBuffer
    ):Promise<void> {
        if (typeof raw !== 'string') {
            return this.send(ws, { type: 'error', reason: 'bad-message' })
        }

        // Before JSON.parse, not after: the per-field bounds in
        // isClientMessage only apply to a frame that has already been
        // parsed, and parsing a multi-megabyte frame is itself the cost
        // worth refusing. See MAX_WIRE_MESSAGE_LENGTH in protocol.ts.
        if (raw.length > MAX_WIRE_MESSAGE_LENGTH) {
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

    /**
     * The socket is already closing, so it is excluded from the roster
     * this broadcast computes.
     *
     * The `close` call is what completes the closing handshake. Without
     * it a client that closes its own socket never sees the close event
     * and sits in CLOSING until it times out -- measured, not assumed:
     * before this, `readyState` stayed at 2 indefinitely. Cloudflare's
     * documented example calls it, and the flag that would make the
     * runtime auto-reply does not exist in this workerd build.
     *
     * The code is sanitised because 1005 (no status received) and 1006
     * (abnormal closure) are receive-only -- echoing either back throws.
     */
    async webSocketClose (
        ws:WebSocket,
        code:number,
        reason:string
    ):Promise<void> {
        this.broadcastRoster(ws)

        const sendable = code === 1000 || (code >= 3000 && code <= 4999)
        try {
            ws.close(sendable ? code : 1000, reason)
        } catch (_err) {
            // Already fully closed. Nothing to do.
        }
    }

    async webSocketError (ws:WebSocket):Promise<void> {
        this.broadcastRoster(ws)
    }

    /**
     * The room's whole life ends here. Alarms retry on failure, so this
     * must be safe to run twice: deleting an already-empty room is a
     * no-op, closing an already-closed socket is caught, and the
     * tombstone is a single-row upsert, so a second run still leaves
     * exactly one tombstone and no group data.
     *
     * The id does not become free again. A tombstone stays behind so
     * `create` refuses the id, or anyone who knew it could claim it and
     * old invitation links would reconnect into their room.
     */
    async alarm ():Promise<void> {
        // Close first. After deleteAll the room cannot answer anything
        // meaningful, and a client left holding an open socket to a room
        // that no longer exists would sit there waiting.
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.close(1000, 'room expired')
            } catch (_err) {
                // Already closed. Nothing to do.
            }
        }

        const named = this.ctx.storage.sql
            .exec<{ room_id:string }>('SELECT room_id FROM name WHERE id = 1')
            .toArray()[0]

        await this.ctx.storage.deleteAll()

        // Redundant under our compatibility date, where deleteAll also
        // clears the alarm. Kept because it is free and idempotent, and
        // because a future compatibility-date change must not silently
        // leave an alarm on a deleted room.
        await this.ctx.storage.deleteAlarm()

        // deleteAll drops the tables, not just the rows, and this object
        // may keep serving requests without ever being reconstructed. So
        // put the empty schema back, or every read from here on throws
        // `no such table` instead of reporting an absent room.
        this.ensureSchema()

        this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO tombstone (id, expired_at)
             VALUES (1, ?)`,
            Date.now()
        ).toArray()

        // Last, so a failure here retries the whole alarm, and every step
        // above is idempotent. A room created before the registry existed
        // has no name row and was never listed, so there is nothing to
        // mark.
        if (named) await registry(this.env).markExpired(named.room_id)
    }

    // ---- message handling ----

    private async handle (
        ws:WebSocket,
        msg:ClientMessage
    ):Promise<void> {
        switch (msg.type) {
            case 'create':
                return this.onCreate(ws, msg.identity, msg.proof)
            case 'hello':
                return this.onHello(
                    ws, msg.identity, msg.cursor, msg.creatorToken,
                    msg.proof
                )
            case 'mls':
                return this.onMls(ws, msg.kind, msg.payload)
            case 'join-request':
                return this.onJoinRequest(
                    ws, msg.identity, msg.keyPackage
                )
            case 'approve':
                return this.onApprove(ws, msg.identity)
            case 'deny':
                return this.onDeny(ws, msg.identity)
            case 'removed':
                return this.onRemoved(ws, msg.identity)
            case 'welcome':
                return this.onWelcome(ws, msg.to, msg.payload)
            case 'replay':
                return this.onReplay(ws, msg.cursor)
            default:
                // Unreachable for anything isClientMessage accepts. Kept
                // so a message type added to the contract without a
                // handler here is answered rather than ignored.
                return this.send(ws, {
                    type: 'error',
                    reason: 'bad-message'
                })
        }
    }

    private async onCreate (
        ws:WebSocket,
        identity:string,
        proof?:string
    ):Promise<void> {
        if (!mayCreateRoom(this.roomState())) {
            return this.send(ws, { type: 'error', reason: 'room-exists' })
        }
        if (!await this.requireProof(ws, identity, proof)) return

        // The proof is checked across an await, and a second `create`
        // can land in that gap.
        if (!mayCreateRoom(this.roomState())) {
            return this.send(ws, { type: 'error', reason: 'room-exists' })
        }

        const roomId = this.readHandshake(ws)?.roomId
        if (!roomId) {
            return this.send(ws, { type: 'error', reason: 'bad-message' })
        }

        // Listed before the room exists, and awaited before `created` is
        // sent, so an invitee's GET can never miss a room its creator has
        // already been told about. The reverse order could leave a live
        // room the GET route answers 404 for.
        await registry(this.env).markLive(roomId)

        // The registry call awaited, and a second `create` can land in
        // that gap too.
        if (!mayCreateRoom(this.roomState())) {
            return this.send(ws, { type: 'error', reason: 'room-exists' })
        }

        const now = Date.now()
        const expiresAt = now + ROOM_LIFETIME_MS
        const token = crypto.randomUUID()

        this.ctx.storage.sql.exec(
            'INSERT OR REPLACE INTO name (id, room_id) VALUES (1, ?)',
            roomId
        ).toArray()

        this.ctx.storage.sql.exec(
            `INSERT INTO meta
                (id, created_at, expires_at, creator_identity,
                 creator_token)
             VALUES (1, ?, ?, ?, ?)`,
            now, expiresAt, identity, token
        ).toArray()

        // Ordering is deliberate: the row is written before the alarm is
        // set. If the alarm write failed here, a room would exist that
        // never expires, which is recoverable. The reverse -- an alarm
        // with no room -- would fire against nothing. The cursor above is
        // consumed by .toArray() before this await, which is what keeps
        // snapshot isolation.
        await this.ctx.storage.setAlarm(expiresAt)

        // The caller who creates the room is its creator by definition.
        // No token comparison is possible here -- this is the moment the
        // token comes into existence.
        this.attach(ws, identity, true)
        this.send(ws, {
            type: 'created',
            creatorToken: token,
            expiresAt
        })
        this.broadcastRoster()
    }

    private async onHello (
        ws:WebSocket,
        identity:string,
        cursor:number,
        creatorToken?:string,
        proof?:string
    ):Promise<void> {
        if (!this.requireRoom(ws)) return
        if (!await this.requireProof(ws, identity, proof)) return

        // Read after the proof, which awaits: the room can expire in
        // that gap.
        const meta = this.readMeta()
        if (!meta) {
            return this.send(ws, { type: 'no-room' })
        }

        // Both halves must hold, and the token is the half that actually
        // authorizes. An identity is a signature public key that everyone
        // in the room has already seen, so claiming the creator's
        // identity proves nothing at all.
        const isCreator = (
            creatorToken !== undefined &&
            creatorToken === meta.creator_token &&
            identity === meta.creator_identity
        )

        this.replaceExistingSocket(ws, identity)
        this.attach(ws, identity, isCreator)

        this.send(ws, {
            type: 'room-state',
            isCreator,
            createdAt: meta.created_at,
            expiresAt: meta.expires_at
        })

        // The mailbox first. A joiner arrives with cursor 0, so the
        // replay below would otherwise deliver the whole log before the
        // Welcome that makes any of it processable.
        this.deliverMailbox(identity)

        // The first page only. The client asks for each next one with
        // `replay`, so no single frame outgrows the WebSocket limit.
        this.sendReplayPage(ws, cursor, false)

        this.broadcastRoster()
        if (isCreator) this.sendPendingToCreator()
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

        if (!this.requireRoom(ws)) return
        if (!this.requireMember(ws, state)) return
        if (!this.requireKind(ws, state, kind)) return
        const now = Date.now()
        if (!this.requireLogRoom(ws, state, payload.length, now)) return

        const seq = nextSeq(this.highWater())
        // kind and payload cross untouched. The room never decodes an
        // MLS payload and asserts nothing about what is inside it.
        const entry = entryFromMls(seq, state.identity, kind, payload)

        this.ctx.storage.sql.exec(
            `INSERT INTO log (seq, sender, kind, payload)
             VALUES (?, ?, ?, ?)`,
            entry.seq, entry.sender, entry.kind, entry.payload
        ).toArray()

        // Only an accepted write starts the next throttle window.
        this.attach(ws, state.identity, state.isCreator, { lastMlsAt: now })

        // Broadcast to everyone, the sender included. The sender is the
        // one member that cannot decrypt this entry -- MLS cannot open a
        // message it produced -- but it is also the only way the sender
        // learns the seq the room gave it, and a cursor that skips its
        // own writes reads the next entry from anybody else as a gap and
        // stops. The client recognises its own entry by `sender` and
        // renders it from the plaintext it recorded at send time rather
        // than attempting a decrypt; see `apply-entry.ts`. The replay a
        // reconnect asks for has always included the asker's own
        // entries, so this makes live delivery and replay the same shape
        // instead of two.
        // Proven sockets only. A socket that has not said who it is gets
        // the challenge and nothing else.
        for (const peer of this.ctx.getWebSockets()) {
            if (!this.readAttachment(peer)) continue
            this.send(peer, { type: 'entry', entry })
        }
    }

    /**
     * A request outlives the tab that made it. `INSERT OR REPLACE` on a
     * primary key of identity means asking twice replaces the first ask
     * rather than queueing a duplicate for the creator to wade through.
     *
     * This is the only write a complete stranger can cause -- the room
     * asks only that it exist and that the requester proved, at `hello`,
     * the identity it is asking for, because the join flow is open -- so
     * it is also the only handler with limits of its own.
     * `classifyJoinRequest` holds them; a refusal writes nothing at all,
     * not even the throttle, so a refused request cannot itself be the
     * storage growth the limits exist to stop.
     */
    private onJoinRequest (
        ws:WebSocket,
        identity:string,
        keyPackage:string
    ):void {
        if (!this.requireRoom(ws)) return

        // The identity is a separate field from the one `hello` proved,
        // so the two have to agree, or any socket could queue a request
        // under a key it does not hold.
        const state = this.readAttachment(ws)
        if (state?.identity !== identity) {
            return this.send(ws, { type: 'error', reason: 'bad-proof' })
        }

        const now = Date.now()
        const verdict = classifyJoinRequest({
            keyPackageLength: keyPackage.length,
            pendingCount: this.pendingCount(),
            alreadyPending: this.isPending(identity),
            lastRequestAt: state.lastJoinRequestAt,
            now
        })

        if (verdict !== 'ok') {
            return this.send(ws, { type: 'error', reason: verdict })
        }

        this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO pending
                (identity, key_package, requested_at)
             VALUES (?, ?, ?)`,
            identity, keyPackage, now
        ).toArray()

        // Re-attached only to record the throttle; the identity and the
        // creator flag are the ones `hello` already settled.
        //
        // `now` is what starts this socket's next throttle window. It is
        // recorded on the accepted request only: a refused one leaves the
        // window where it was, so a socket cannot push its own next
        // chance further out by asking again.
        this.attach(ws, identity, state.isCreator, {
            lastJoinRequestAt: now
        })
        this.sendPendingToCreator()
    }

    /** How many identities are queued, for the cap. */
    private pendingCount ():number {
        const row = this.ctx.storage.sql
            .exec<{ n:number }>('SELECT COUNT(*) AS n FROM pending')
            .toArray()[0]
        return row ? row.n : 0
    }

    /**
     * Whether this identity already holds a row. A repeat request
     * replaces its own row, so it grows the queue by nothing and the cap
     * does not apply to it.
     */
    private isPending (identity:string):boolean {
        return this.ctx.storage.sql
            .exec<{ n:number }>(
                'SELECT COUNT(*) AS n FROM pending WHERE identity = ?',
                identity
            )
            .toArray()[0].n > 0
    }

    /**
     * Recording an admission is an act of faith. The room was told a
     * commit exists; it did not check, and could not.
     *
     * The removed row is cleared, so the ledger records what an identity
     * *is* rather than everything it has ever been. Re-approval is a
     * flow the room deliberately supports -- `previously-removed` exists
     * precisely so the creator can weigh letting someone back in -- and
     * `broadcastRoster` subtracts removed from admitted, so leaving the
     * row behind would readmit a member who never appears on the roster
     * again. Nothing else ever deletes it, and the composite primary key
     * means the admitted row happily coexists with it.
     */
    private onApprove (ws:WebSocket, identity:string):void {
        if (!this.requireRoom(ws)) return
        if (!this.requireCreator(ws)) return

        this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO ledger (identity, status)
             VALUES (?, 'admitted')`,
            identity
        ).toArray()
        this.ctx.storage.sql.exec(
            `DELETE FROM ledger
             WHERE identity = ? AND status = 'removed'`,
            identity
        ).toArray()
        this.ctx.storage.sql.exec(
            'DELETE FROM pending WHERE identity = ?',
            identity
        ).toArray()

        this.sendPendingToCreator()
        this.broadcastRoster()
    }

    /**
     * Denial discards the request and records nothing. A denied identity
     * is not `previously-removed` -- it was never admitted, so it stays a
     * stranger and may ask again.
     */
    private onDeny (ws:WebSocket, identity:string):void {
        if (!this.requireRoom(ws)) return
        if (!this.requireCreator(ws)) return

        this.ctx.storage.sql.exec(
            'DELETE FROM pending WHERE identity = ?',
            identity
        ).toArray()
        this.ctx.storage.sql.exec(
            'DELETE FROM mailbox WHERE recipient = ?',
            identity
        ).toArray()

        this.sendPendingToCreator()
    }

    private onRemoved (ws:WebSocket, identity:string):void {
        if (!this.requireRoom(ws)) return
        if (!this.requireCreator(ws)) return

        this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO ledger (identity, status)
             VALUES (?, 'removed')`,
            identity
        ).toArray()
        this.ctx.storage.sql.exec(
            'DELETE FROM mailbox WHERE recipient = ?',
            identity
        ).toArray()

        this.broadcastRoster()
    }

    /**
     * The room stamps the cursor, not the client. Because one socket
     * processes messages in order and the creator sends the commit before
     * the Welcome, that commit is already in the log by the time this
     * runs -- so the current high-water mark is exactly the epoch the
     * newcomer is joining at. Letting the client compute this would add a
     * round trip and an opportunity to get it wrong.
     */
    private onWelcome (
        ws:WebSocket,
        to:string,
        payload:string
    ):void {
        if (!this.requireRoom(ws)) return
        if (!this.requireCreator(ws)) return

        const cursor = this.highWater()
        // A COUNT rather than every row: `countApplicationsAtOrBelow` in
        // `room-logic.ts` is the tested statement of this rule, and the
        // query must say the same thing.
        const counted = this.ctx.storage.sql
            .exec<{ n:number }>(
                `SELECT COUNT(*) AS n FROM log
                 WHERE kind = 'application' AND seq <= ?`,
                cursor
            )
            .toArray()
        const priorCount = counted[0]?.n ?? 0

        this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO mailbox
                (recipient, payload, cursor, prior_count)
             VALUES (?, ?, ?, ?)`,
            to, payload, cursor, priorCount
        ).toArray()

        // Deliver now if they are here; otherwise it waits in the mailbox
        // until their next connect.
        this.deliverMailbox(to)
    }

    /**
     * The next replay page, for a socket that already said `hello`. An
     * attached socket is a proven one -- `onHello` attaches only after
     * `requireProof` -- and a proven socket was already sent the first
     * page, so asking for the rest tells it nothing new.
     */
    private onReplay (ws:WebSocket, cursor:number):void {
        if (!this.requireRoom(ws)) return
        if (!this.readAttachment(ws)?.identity) {
            return this.send(ws, {
                type: 'error',
                reason: 'bad-message'
            })
        }
        this.sendReplayPage(ws, cursor, true)
    }

    /**
     * One `log` page after `cursor`, chosen by `replayPage`. The page
     * after `hello` is skipped when empty; one answering `replay` is
     * sent even so, as the answer the client asked for.
     */
    private sendReplayPage (
        ws:WebSocket,
        cursor:number,
        evenIfEmpty:boolean
    ):void {
        const page = replayPage(this.entriesSince(cursor), cursor)
        if (page.entries.length === 0 && !evenIfEmpty) return
        this.send(ws, {
            type: 'log',
            entries: page.entries,
            more: page.more
        })
    }

    // ---- storage helpers ----

    private readMeta ():MetaRow|null {
        const rows = this.ctx.storage.sql
            .exec<MetaRow>('SELECT * FROM meta WHERE id = 1')
            .toArray()
        return rows[0] ?? null
    }

    private roomState ():RoomState {
        if (this.readMeta()) return 'live'
        const tomb = this.ctx.storage.sql
            .exec('SELECT id FROM tombstone WHERE id = 1')
            .toArray()
        return tomb.length > 0 ? 'tombstoned' : 'absent'
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

    private ledgerIdentities (status:string):string[] {
        return this.ctx.storage.sql
            .exec<{ identity:string }>(
                'SELECT identity FROM ledger WHERE status = ?',
                status
            )
            .toArray()
            .map(row => row.identity)
    }

    /**
     * A Welcome issued while its recipient was offline is delivered on
     * their next connect. Delivered mail is deleted -- a Welcome is
     * consumed once, and replaying it later would try to rejoin a group
     * the client is already in.
     */
    private deliverMailbox (identity:string):void {
        const rows = this.ctx.storage.sql
            .exec<MailRow>(
                `SELECT payload, cursor, prior_count FROM mailbox
                 WHERE recipient = ?`,
                identity
            )
            .toArray()

        const mail = rows[0]
        if (!mail) return

        for (const peer of this.ctx.getWebSockets()) {
            // A closing socket is still in getWebSockets() -- the whole
            // reason broadcastRoster takes an `excluding` argument. Here
            // it matters more than it does there, because delivery
            // consumes: `send` swallows a failure on a closing socket by
            // design, so a corpse matching this identity would eat the
            // Welcome and the row would be deleted having reached no
            // one. Reachable on a plain reconnect, where the replaced
            // socket can still be closing when the replacement says
            // hello and the mailbox is read.
            if (peer.readyState !== WebSocket.OPEN) continue

            const state = this.readAttachment(peer)
            if (state?.identity !== identity) continue

            this.send(peer, {
                type: 'welcome-you',
                payload: mail.payload,
                cursor: mail.cursor,
                priorCount: mail.prior_count
            })

            this.ctx.storage.sql.exec(
                'DELETE FROM mailbox WHERE recipient = ?',
                identity
            ).toArray()
            return
        }
    }

    /**
     * Pending requests go only to the creator, and only to a socket that
     * proved it with the token.
     */
    private sendPendingToCreator ():void {
        const rows = this.ctx.storage.sql
            .exec<PendingRow>(
                `SELECT identity, key_package, requested_at FROM pending
                 ORDER BY requested_at ASC`
            )
            .toArray()

        const admitted = this.ledgerIdentities('admitted')
        const removed = this.ledgerIdentities('removed')

        const requests:PendingRequest[] = rows.map(row => ({
            identity: row.identity,
            keyPackage: row.key_package,
            requestedAt: row.requested_at,
            standing: classifyStanding(row.identity, admitted, removed)
        }))

        for (const peer of this.ctx.getWebSockets()) {
            const state = this.readAttachment(peer)
            if (!state?.isCreator) continue
            this.send(peer, { type: 'pending', requests })
        }
    }

    // ---- socket helpers ----

    /**
     * The throttles (`lastJoinRequestAt`, `lastMlsAt`) are carried over
     * from the existing attachment unless this call sets them. Every
     * other field is rewritten from scratch on each attach, and doing
     * the same to a throttle would hand a flooder a reset: send `hello`,
     * be attached afresh, ask again. Throttles are socket-scoped, so
     * they survive the identity changing.
     */
    private attach (
        ws:WebSocket,
        identity:string,
        isCreator:boolean,
        throttles:{
            lastJoinRequestAt?:number
            lastMlsAt?:number
        } = {}
    ):void {
        const prior = this.readAttachment(ws)
        const state:SocketState = {
            identity,
            proven: true,
            isCreator,
            lastJoinRequestAt: throttles.lastJoinRequestAt ??
                prior?.lastJoinRequestAt ??
                null,
            lastMlsAt: throttles.lastMlsAt ?? prior?.lastMlsAt ?? null,
            handshake: this.readHandshake(ws)
        }
        ws.serializeAttachment(state)
    }

    /**
     * `isCreator` is read as `=== true` rather than for truthiness, so an
     * attachment written by an older version of this Worker -- before the
     * field existed -- reads as not-creator rather than as undefined
     * flowing into an authorization decision.
     */
    private readAttachment (ws:WebSocket):SocketState|null {
        const value = ws.deserializeAttachment()
        if (!value || typeof value !== 'object') return null
        const state = value as Partial<SocketState>
        if (typeof state.identity !== 'string') return null
        // Same reasoning as `isCreator` below: an attachment that does
        // not say it was proven reads as unattached.
        if (state.proven !== true) return null
        const last = state.lastJoinRequestAt
        const lastMls = state.lastMlsAt
        return {
            identity: state.identity,
            proven: true,
            isCreator: state.isCreator === true,
            // Same reasoning as `isCreator`: an attachment written before
            // the field existed reads as "never asked" rather than
            // letting undefined flow into a comparison.
            lastJoinRequestAt: typeof last === 'number' &&
                Number.isFinite(last) ?
                last :
                null,
            lastMlsAt: typeof lastMls === 'number' &&
                Number.isFinite(lastMls) ?
                lastMls :
                null,
            handshake: this.readHandshake(ws)
        }
    }

    /**
     * The challenge this socket was issued, read from the raw attachment
     * rather than through `readAttachment`: before `hello` there is no
     * identity, and the challenge is exactly what `hello` needs.
     */
    private readHandshake (ws:WebSocket):Handshake|null {
        const value = ws.deserializeAttachment()
        if (!value || typeof value !== 'object') return null
        const { handshake } = value as { handshake?:Partial<Handshake> }
        if (
            !handshake ||
            typeof handshake.challenge !== 'string' ||
            typeof handshake.roomId !== 'string'
        ) return null
        return { challenge: handshake.challenge, roomId: handshake.roomId }
    }

    /**
     * Whether this socket proved `identity`, answering `bad-proof` if
     * it did not. Asked after `requireRoom`, for the reason given at
     * `requireMember`. A missing proof is a failed one: the room link
     * alone must reveal nothing and let nobody act as anyone.
     */
    private async requireProof (
        ws:WebSocket,
        identity:string,
        proof?:string
    ):Promise<boolean> {
        const handshake = this.readHandshake(ws)
        const holds = (
            proof !== undefined &&
            handshake !== null
        ) && await verifyIdentityProof(
            identity,
            handshake.challenge,
            handshake.roomId,
            proof
        )
        if (holds) return true
        this.send(ws, { type: 'error', reason: 'bad-proof' })
        return false
    }

    /**
     * Whether the room still exists, answering `no-room` if it does not.
     *
     * Every handler that writes has to ask, not just the two that face
     * strangers. The expiry alarm closes each socket before it deletes,
     * but a close is not instantaneous and a message already in flight is
     * still delivered, so a creator's socket can outlive its room by a
     * moment. A write accepted in that moment lands in a room with no
     * meta and no alarm: rows that nothing will ever expire, in a room
     * that reports itself gone. Refusing keeps the invariant the alarm
     * exists to establish -- an expired room holds no group data, only
     * its tombstone.
     */
    private requireRoom (ws:WebSocket):boolean {
        if (this.readMeta()) return true
        this.send(ws, { type: 'no-room' })
        return false
    }

    /**
     * Control messages that write to the ledger or the mailbox are
     * creator-only. The room cannot verify the claims themselves -- it
     * never parses a commit -- so the token is the only thing standing
     * between the ledger and anyone who can open a socket.
     */
    private requireCreator (ws:WebSocket):SocketState|null {
        const state = this.readAttachment(ws)
        if (!state?.isCreator) {
            this.send(ws, { type: 'error', reason: 'not-creator' })
            return null
        }
        return state
    }

    /**
     * Whether this socket's identity is one the room admits, answering
     * `not-member` if it is not.
     *
     * Asked after `requireRoom`, deliberately. An expired room's ledger
     * is empty, so asking in the other order would answer `not-member` to
     * a member whose room had simply ended -- true, but the wrong thing
     * to tell them.
     */
    /**
     * Applies `classifyMlsWrite`. The room totals are a count and a sum
     * over the log itself, so they cannot drift from what is stored. A
     * refusal sends the verdict and writes nothing.
     */
    private requireLogRoom (
        ws:WebSocket,
        state:SocketState,
        payloadLength:number,
        now:number
    ):boolean {
        const row = this.ctx.storage.sql.exec<{
            rows:number
            bytes:number|null
        }>(
            'SELECT COUNT(*) AS rows, SUM(LENGTH(payload)) AS bytes FROM log'
        ).one()
        const verdict = classifyMlsWrite({
            payloadLength,
            logRows: row.rows,
            logBytes: row.bytes ?? 0,
            lastMlsAt: state.lastMlsAt,
            now
        })
        if (verdict === 'ok') return true
        this.send(ws, { type: 'error', reason: verdict })
        return false
    }

    private requireMember (ws:WebSocket, state:SocketState):boolean {
        const may = mayWriteLog(
            state.identity,
            state.isCreator,
            this.ledgerIdentities('admitted'),
            this.ledgerIdentities('removed')
        )
        if (may) return true
        this.send(ws, { type: 'error', reason: 'not-member' })
        return false
    }

    /**
     * Whether this member may write this kind of entry, answering
     * `commit-not-creator` if not. Asked after `requireMember`, so a
     * stranger hears that they are not a member rather than something
     * about commits. A refusal writes nothing and reaches no peer.
     */
    private requireKind (
        ws:WebSocket,
        state:SocketState,
        kind:LogEntry['kind']
    ):boolean {
        if (mayWriteKind(kind, state.isCreator)) return true
        this.send(ws, { type: 'error', reason: 'commit-not-creator' })
        return false
    }

    /**
     * A second socket for one identity replaces the first. Reconnects
     * are common -- a laptop lid, a tunnel -- and leaving the stale
     * socket open would double every broadcast and make the roster lie.
     *
     * This is a scan rather than a tag lookup because tags can only be
     * set at accept time, before `hello` has said who this is.
     *
     * An identity is a public signature key everyone in the room has
     * seen, so a bare claim to one would let anyone evict any member --
     * keep the creator from approving, or a joiner from receiving their
     * Welcome. `mayReplaceSocket` therefore lets only a socket that
     * proved the same identity replace it. This is called after
     * `requireProof`, so the incoming socket is proven; the rule is asked
     * anyway so that stays a stated condition rather than a call order.
     */
    private replaceExistingSocket (
        incoming:WebSocket,
        identity:string
    ):void {
        for (const peer of this.ctx.getWebSockets()) {
            if (peer === incoming) continue
            const state = this.readAttachment(peer)
            if (!state) continue
            const may = mayReplaceSocket(
                state.identity,
                { identity, proven: true }
            )
            if (!may) continue
            try {
                peer.close(1000, 'replaced by a newer connection')
            } catch (_err) {
                // Already closing. Nothing to do.
            }
        }
    }

    /**
     * A send that fails on an open socket is not the same event as one
     * that fails because the peer went away, and the two must not be
     * collapsed. Losing a frame to a closing socket is expected and the
     * close handler reconciles it. Losing one on an open socket means
     * something like an oversize `log` replay, and swallowing that
     * leaves the client believing it is caught up when it is not -- a
     * silent desync that outlives the room's three days. So the second
     * case is surfaced to the observability logs rather than discarded.
     */
    private send (ws:WebSocket, msg:RoomMessage):void {
        try {
            ws.send(JSON.stringify(msg))
        } catch (err) {
            const closing = (
                ws.readyState === WebSocket.CLOSING ||
                ws.readyState === WebSocket.CLOSED
            )
            if (!closing) {
                console.error('room: send failed on an open socket', {
                    type: msg.type,
                    error: String(err)
                })
            }
        }
    }

    /**
     * Liveness is derived, never stored. `excluding` is the socket that
     * is currently closing, which still appears in getWebSockets().
     */
    private broadcastRoster (excluding?:WebSocket):void {
        const meta = this.readMeta()
        if (!meta) return

        // The creator is always known and never appears in the ledger --
        // they do not approve themselves.
        const admitted = this.ledgerIdentities('admitted')
        const removed = new Set(this.ledgerIdentities('removed'))
        const known = [
            meta.creator_identity,
            ...admitted.filter(id => !removed.has(id))
        ]

        const liveTags:string[] = []

        for (const peer of this.ctx.getWebSockets()) {
            if (peer === excluding) continue
            const state = this.readAttachment(peer)
            if (state) liveTags.push(state.identity)
        }

        const live = assembleRoster(known, liveTags)
        const msg:RoomMessage = { type: 'roster', live }

        // Sent, like it is counted, only to proven sockets.
        for (const peer of this.ctx.getWebSockets()) {
            if (peer === excluding) continue
            if (!this.readAttachment(peer)) continue
            this.send(peer, msg)
        }
    }
}

/**
 * The one registry object, named by a fixed string.
 */
function registry (env:Env):DurableObjectStub<RoomRegistry> {
    return env.REGISTRY.getByName('rooms')
}

/**
 * Which room ids are live and which have expired, so the GET route can
 * answer an unknown id without naming a room object. A single Durable
 * Object rather than KV, because KV may serve a cached miss for up to a
 * minute and an invitee opening a fresh link would be told the room is
 * gone. See "The room registry" in AGENTS.md.
 *
 * The registry is not the authority on whether an id may be created --
 * the room's own tombstone is. It only lets the Worker avoid
 * instantiating objects.
 */
export class RoomRegistry extends DurableObject<Env> {
    constructor (ctx:DurableObjectState, env:Env) {
        super(ctx, env)
        ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS rooms (
                room_id TEXT PRIMARY KEY,
                status TEXT NOT NULL
            )
        `).toArray()
    }

    markLive (roomId:string):void {
        this.write(roomId, 'live')
    }

    markExpired (roomId:string):void {
        this.write(roomId, 'expired')
    }

    lookup (roomId:string):RegistryEntry {
        const row = this.ctx.storage.sql
            .exec<{ status:string }>(
                'SELECT status FROM rooms WHERE room_id = ?',
                roomId
            )
            .toArray()[0]
        if (row?.status === 'live' || row?.status === 'expired') {
            return row.status
        }
        return null
    }

    private write (roomId:string, status:'live'|'expired'):void {
        this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO rooms (room_id, status)
             VALUES (?, ?)`,
            roomId, status
        ).toArray()
    }
}

/**
 * Copies the security headers onto a response. The response may have
 * come back from the ASSETS binding or from a Durable Object, and those
 * arrive with immutable headers, so it is rebuilt rather than mutated.
 *
 * A 101 is returned untouched: it is a completed WebSocket upgrade whose
 * headers the runtime owns, and the page that opened the socket was
 * already served under the policy.
 */
function withSecurityHeaders (res:Response, origin:string):Response {
    if (res.status === 101) return res

    const out = new Response(res.body, res)

    for (const [name, value] of Object.entries(securityHeaders(origin))) {
        out.headers.set(name, value)
    }

    return out
}

export default {
    async fetch (req:Request, env:Env):Promise<Response> {
        const url = new URL(req.url)
        const res = await route(req, env, url)
        return withSecurityHeaders(res, url.origin)
    }
}

/**
 * Every reply the demo makes, before the headers go on. Split out so
 * there is exactly one place a response can leave the Worker, and no
 * later branch can be added that skips the policy.
 */
async function route (req:Request, env:Env, url:URL):Promise<Response> {
    const API_PREFIX = '/api/'

    // Not an API path, so it is the client: the SPA shell, a hashed
    // asset, or a 404 from the assets binding. Forwarded unchanged.
    if (!url.pathname.startsWith(API_PREFIX)) {
        return env.ASSETS.fetch(req)
    }

    // Answered without naming a Durable Object, so a health check
    // never causes one to exist.
    if (url.pathname === '/api/health') {
        return Response.json({ ok: true })
    }

    if (!url.pathname.startsWith(ROOM_PREFIX)) {
        return new Response('not found', { status: 404 })
    }

    // Everything after the prefix is treated as a candidate id and
    // handed to isValidRoomId, rather than being pre-filtered by the
    // route pattern. A pattern that only matched a single clean
    // segment would answer 404 for `/api/room/a/b`, hiding a
    // traversal-shaped request behind the same status as a typo.
    // Letting the tested predicate decide means every malformed id
    // gets one answer, 400, whatever shape it arrives in.
    const rest = url.pathname.slice(ROOM_PREFIX.length)
    const wantsSocket = rest.endsWith('/ws')
    const roomId = wantsSocket ? rest.slice(0, -'/ws'.length) : rest

    // Validated before the room is named. An id that cannot be a
    // room never causes a Durable Object to be created, which is
    // what stops a malformed or reserved id from being routed.
    if (!isValidRoomId(roomId)) {
        return new Response('bad room id', { status: 400 })
    }

    if (wantsSocket) {
        // Limited before the room is named, so a refused upgrade costs
        // no object. The Worker cannot tell a `create` from a `hello`
        // here, so every upgrade counts; see UPGRADE_LIMIT.
        const key = req.headers.get('CF-Connecting-IP') ?? 'unknown'
        const { success } = await env.UPGRADE_LIMITER.limit({ key })
        if (!success) {
            return new Response('too many requests', { status: 429 })
        }

        // RFC 6455 makes the token case-insensitive.
        const upgrade = req.headers.get('Upgrade') ?? ''
        if (upgrade.toLowerCase() !== 'websocket') {
            return new Response('expected websocket', { status: 426 })
        }
        return env.ROOM.getByName(roomId).fetch(req)
    }

    if (req.method !== 'GET') {
        return new Response('method not allowed', { status: 405 })
    }

    const listed = await registry(env).lookup(roomId)
    if (roomInfoDecision(listed) === 'no-room') {
        return new Response('no such room', { status: 404 })
    }

    const info = await env.ROOM.getByName(roomId).roomInfo()

    if (!info) {
        return new Response('no such room', { status: 404 })
    }

    return Response.json(info)
}
