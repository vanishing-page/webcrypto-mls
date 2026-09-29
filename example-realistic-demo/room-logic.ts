import type { EntryKind, LogEntry, Standing } from './protocol.js'
import { identityProofMessage } from './protocol.js'
import {
    base64urlToBytes,
    bytesToBuffer
} from '../src/util/byte-array.js'

/**
 * The room's decisions that touch no storage, no globals and no network.
 * Pure -- so it can be unit tested in node, and so the parts of the
 * delivery service worth being sure about are the parts under test.
 */

/**
 * Sequence numbers start at 1, so an empty room's high-water mark of 0
 * yields 1. This is the only place a seq is minted, and entries are
 * never renumbered.
 */
export function nextSeq (highWater:number):number {
    return Math.max(0, Math.floor(highWater)) + 1
}

/**
 * What a client with this cursor has not seen. A cursor is the last seq
 * the client applied, so it gets everything strictly after it, in seq
 * order. Sorting here rather than trusting the caller means a replay is
 * ordered even if storage returned rows in another order.
 */
export function entriesAfter (
    entries:LogEntry[],
    cursor:number
):LogEntry[] {
    return entries
        .filter(entry => entry.seq > cursor)
        .sort((a, b) => a.seq - b.seq)
}

/**
 * How many wire characters of entries one replay page may carry, as
 * the JSON array `replayPage` measures. A Cloudflare WebSocket frame is
 * at most 1 MiB; half of it leaves the `log` envelope far more room
 * than it needs, and still holds a thousand ordinary commits.
 */
export const REPLAY_PAGE_BUDGET = 512 * 1024

export interface ReplayPage {
    entries:LogEntry[]
    /** True when entries after the last one on this page remain. */
    more:boolean
}

/**
 * One page of the replay after `cursor`: the longest run of entries, in
 * seq order, whose JSON array fits `budget`. Never empty while anything
 * remains -- a single entry larger than the budget goes alone, which is
 * safe because `MAX_PAYLOAD_LENGTH` already bounds one entry well under
 * a frame. Without that floor an oversized entry would stall the walk.
 */
export function replayPage (
    entries:LogEntry[],
    cursor:number,
    budget:number = REPLAY_PAGE_BUDGET
):ReplayPage {
    const after = entriesAfter(entries, cursor)
    // `[` and `]`, then each entry, with a comma between entries.
    let size = 2
    let count = 0
    for (const entry of after) {
        const next = size + JSON.stringify(entry).length +
            (count > 0 ? 1 : 0)
        if (count > 0 && next > budget) break
        size = next
        count++
    }
    return {
        entries: after.slice(0, count),
        more: count < after.length
    }
}

/**
 * An `mls` message as it goes into the log. `kind` and `payload` cross
 * untouched: the room asserts nothing about either and never decodes an
 * MLS payload. A client that lies about `kind` corrupts its peers'
 * placeholder counts and nothing else.
 */
export function entryFromMls (
    seq:number,
    sender:string,
    kind:EntryKind,
    payload:string
):LogEntry {
    return { seq, sender, kind, payload }
}

/**
 * Who to mark connected. This is a transport observation, not protocol
 * state -- `liveTags` comes from open sockets and `known` from the
 * ledger, and the page presents the result separately from the member
 * list it derives from its own ratchet tree.
 *
 * `known` is every identity the room believes belongs here: the creator,
 * plus everyone admitted and not since removed. A pending requester
 * holds a socket too and is deliberately excluded -- the roster marks
 * members, not visitors.
 *
 * Tags are deduped because a reconnecting client can briefly hold two
 * sockets, and the result is sorted so the message is stable.
 */
export function assembleRoster (
    known:string[],
    liveTags:string[]
):string[] {
    const isKnown = new Set(known)
    const live = new Set(liveTags.filter(tag => isKnown.has(tag)))
    return [...live].sort()
}

/**
 * How the room classifies a requester against its ledger. Removal wins
 * over admission: an identity that was admitted and later removed is
 * exactly the case the creator most needs to see before approving it
 * again.
 *
 * The ledger is fed entirely by claims the creator's client makes and
 * the room can verify none of them, so this classification is a memory
 * aid rather than an authority.
 */
export function classifyStanding (
    identity:string,
    admitted:string[],
    removed:string[]
):Standing {
    if (removed.includes(identity)) return 'previously-removed'
    if (admitted.includes(identity)) return 'pre-approved'
    return 'stranger'
}

/**
 * Whether an identity may append to the room's log. The creator always
 * may, and is never in the ledger -- they do not approve themselves -- so
 * the flag has to be its own case rather than a lookup. Everyone else has
 * to have been admitted and not since removed, which is the same
 * membership the roster's `known` set is built from.
 *
 * This settles a question left open through Phase 5: before it, any
 * socket that had said `hello` could append. Payloads are opaque and
 * end-to-end encrypted, so what this closes is log noise and unbounded
 * storage growth by a stranger, not a disclosure. It does not
 * authenticate: the identity it is handed has already been proved, at
 * `hello`, by a signature over the socket's challenge (see
 * `verifyIdentityProof`), and the room attaches no identity to a socket
 * that has not. What this adds is membership -- it stops a caller who
 * holds a real key but has never been admitted.
 */
export function mayWriteLog (
    identity:string,
    isCreator:boolean,
    admitted:string[],
    removed:string[]
):boolean {
    if (isCreator) return true
    if (removed.includes(identity)) return false
    return admitted.includes(identity)
}

/**
 * What a room id currently holds. `tombstoned` is an id whose room
 * expired: the alarm deleted every row of group data and left only the
 * record that the id was used.
 */
export type RoomState = 'absent'|'live'|'tombstoned'

/**
 * Whether a `create` may claim an id. Only an id that never held a room
 * may. A tombstoned id stays dead, so an old invitation link or a saved
 * session cannot reconnect into a room somebody else created under the
 * same id after the first one expired.
 */
export function mayCreateRoom (state:RoomState):boolean {
    return state === 'absent'
}

/**
 * Whether a member may write an entry of this kind. Only the creator
 * commits in this demo -- approvals and removals are both theirs -- so a
 * `commit` from anyone else is a replay or a forgery, and every other
 * member's client would have to decide what to do with it. Asked after
 * `mayWriteLog`: this narrows what a member may write, it does not
 * admit anyone.
 *
 * `kind` is still the sender's claim; the room never decodes a payload.
 * A member who labels a commit `application` gets it into the log, and
 * the client's own verdict in `commit-verdict.ts` is what stops that one.
 */
export function mayWriteKind (
    kind:LogEntry['kind'],
    isCreator:boolean
):boolean {
    return kind !== 'commit' || isCreator
}

/**
 * Whether an incoming socket may close the live socket held by
 * `liveIdentity`. Only a socket that proved that same identity may: an
 * identity is a public key everyone in the room has seen, so a bare
 * claim to it would let anyone evict any member, and a proof of some
 * other identity is not a reconnect of this one.
 */
export function mayReplaceSocket (
    liveIdentity:string,
    incoming:{ identity:string, proven:boolean }
):boolean {
    return incoming.proven && incoming.identity === liveIdentity
}

/**
 * How many application messages sit at or below a cursor. A newcomer
 * gets this with its Welcome so the page can render one honest
 * placeholder -- "12 messages before you joined" -- rather than twelve
 * decrypt failures.
 *
 * Only `application` entries count. Commits and proposals are protocol
 * traffic and were never anything a person could read.
 *
 * The boundary is inclusive because a cursor is the last seq the client
 * has, not the first it is missing.
 */
export function countApplicationsAtOrBelow (
    entries:LogEntry[],
    cursor:number
):number {
    return entries.filter(entry => {
        return entry.kind === 'application' && entry.seq <= cursor
    }).length
}

/**
 * How many distinct identities may sit in the pending queue at once.
 *
 * A join request is the one write a complete stranger can cause: the
 * handler asks only that the room exist. `pending` is keyed by identity,
 * so every fresh random identity is a new row, and a scripted client can
 * mint identities as fast as it can open sockets. The cap is what turns
 * that from unbounded storage growth into a queue that fills and then
 * refuses.
 *
 * Sixty-four is far more than a demo room's creator would ever work
 * through by hand, and small enough that a filled queue is a rounding
 * error against the storage a room already holds.
 */
export const MAX_PENDING_REQUESTS = 64

/**
 * The longest a join request's key package may be, measured in the
 * characters that arrive on the wire -- the room stores the base64 it was
 * given and never decodes it.
 *
 * A real MLS KeyPackage is a few hundred bytes to a couple of kilobytes
 * depending on the ciphersuite and credential, so 16 KiB leaves room for
 * a large credential and still refuses the megabyte payloads the cap
 * alone would happily store sixty-four of.
 */
export const MAX_KEY_PACKAGE_LENGTH = 16 * 1024

/**
 * The shortest gap between two join requests from one socket.
 *
 * The client publishes exactly one request per socket it opens, so this
 * costs an honest requester nothing; what it costs is the loop that holds
 * one socket open and asks thousands of times a second. Reconnecting is
 * the only way to reset it, and that is deliberate -- a reconnect is
 * exactly when a legitimate re-publish happens.
 */
export const JOIN_REQUEST_INTERVAL_MS = 1000

/**
 * Why a join request was refused, or `ok`. Each limit gets its own answer
 * rather than a shared refusal, because they mean different things to the
 * requester: an oversized key package is the client's bug, a full queue
 * is the room's state, and a rate limit is temporary.
 */
export type JoinRequestVerdict =
    | 'ok'
    | 'key-package-too-large'
    | 'too-many-pending'
    | 'rate-limited'

/**
 * Whether a join request may be recorded.
 *
 * The order decides which reason wins when more than one limit applies,
 * and it runs most-specific-first: an oversized key package is named as
 * such even from a throttled socket into a full queue, because that is
 * the one refusal waiting will never resolve.
 *
 * `alreadyPending` is what keeps the cap counting rows rather than
 * requests: a repeat request from a queued identity replaces its own row
 * and grows the queue by nothing, so refusing it would strand a requester
 * whose key package changed behind a queue they are already in.
 *
 * A `lastRequestAt` in the future is treated as no prior request. The
 * timestamp survives a hibernation and the clock that produced it is not
 * guaranteed to be the one comparing it, so the alternative is a socket
 * locked out until the clock catches up.
 */
export function classifyJoinRequest (req:{
    keyPackageLength:number
    pendingCount:number
    alreadyPending:boolean
    lastRequestAt:number|null
    now:number
}):JoinRequestVerdict {
    if (req.keyPackageLength > MAX_KEY_PACKAGE_LENGTH) {
        return 'key-package-too-large'
    }

    if (req.lastRequestAt !== null) {
        const elapsed = req.now - req.lastRequestAt
        if (elapsed >= 0 && elapsed < JOIN_REQUEST_INTERVAL_MS) {
            return 'rate-limited'
        }
    }

    if (!req.alreadyPending && req.pendingCount >= MAX_PENDING_REQUESTS) {
        return 'too-many-pending'
    }

    return 'ok'
}

/**
 * The shortest gap between two `mls` writes from one socket.
 *
 * Short on purpose. The creator sends commits back to back while it
 * walks a pending list, and a refused commit leaves the creator at an
 * epoch nobody else reached, so the interval has to sit below the time
 * one commit takes to build. What it still stops is the loop that holds
 * a socket open and writes as fast as the frames go out: twenty writes
 * a second is far past any honest chat and far below a flood.
 */
export const MLS_WRITE_INTERVAL_MS = 50

/**
 * How many entries the log may hold. A demo room lives three days;
 * ten thousand entries is a busy conversation well past anything a
 * demo sees, and it is the worst case a paginated replay has to walk.
 */
export const MAX_LOG_ROWS = 10_000

/**
 * How many payload characters the log may hold in total, counted as the
 * room stores them (base64 wire characters, never decoded). Each entry
 * may be up to `MAX_PAYLOAD_LENGTH`, so the row cap alone would allow
 * gigabytes; 32 MiB is thousands of ordinary commits and messages and
 * keeps a full replay a bounded number of frames.
 */
export const MAX_LOG_BYTES = 32 * 1024 * 1024

/**
 * Why an `mls` write was refused, or `ok`. The throttle shares its
 * reason with the join-request throttle, because to the writer both mean
 * "wait". The two caps are separate reasons: a full log and a heavy log
 * are both permanent for this room, but only one says the payload size
 * mattered.
 */
export type MlsWriteVerdict =
    | 'ok'
    | 'rate-limited'
    | 'log-full'
    | 'log-too-large'

/**
 * Whether an `mls` write may be appended to the log.
 *
 * Most-specific-first, as in `classifyJoinRequest`: the throttle is
 * about this socket alone, so it is named even into a full log -- a
 * flooder hears that it is being throttled rather than learning the
 * room's size. The row cap comes before the byte cap because it does
 * not depend on the payload in hand; the byte cap is the only check
 * that a smaller payload could pass.
 *
 * `logRows` and `logBytes` are read from storage by the caller (a count
 * and a sum over the log), never from a counter that could drift.
 *
 * A `lastMlsAt` in the future counts as no prior write, for the same
 * hibernation reason as `lastRequestAt` in `classifyJoinRequest`.
 */
export function classifyMlsWrite (req:{
    payloadLength:number
    logRows:number
    logBytes:number
    lastMlsAt:number|null
    now:number
}):MlsWriteVerdict {
    if (req.lastMlsAt !== null) {
        const elapsed = req.now - req.lastMlsAt
        if (elapsed >= 0 && elapsed < MLS_WRITE_INTERVAL_MS) {
            return 'rate-limited'
        }
    }

    if (req.logRows >= MAX_LOG_ROWS) return 'log-full'

    if (req.logBytes + req.payloadLength > MAX_LOG_BYTES) {
        return 'log-too-large'
    }

    return 'ok'
}

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
 * Whether an id is one of the reserved words, compared case-insensitively
 * so `API` cannot slip past a list written in lower case.
 *
 * Exported separately because at the current `ROOM_ID_LENGTH` this can
 * never decide anything: every reserved word is shorter than an id, so
 * `isValidRoomId` rejects them on length before reaching this. Testing it
 * through `isValidRoomId` would therefore pass whether or not the rule
 * worked. Calling it directly is what makes the rule verifiable, which
 * matters because its whole purpose is to still be correct if
 * `ROOM_ID_LENGTH` ever changes.
 *
 * Consequence worth knowing: the call to this from `isValidRoomId` can be
 * deleted without failing a test, and that is not a coverage hole. While
 * every reserved word is shorter than an id, the call decides nothing, so
 * no honest test can require it. Shorten `ROOM_ID_LENGTH` to any reserved
 * word's length and the call starts mattering immediately.
 */
export function isReservedRoomId (id:string):boolean {
    return RESERVED_ROOM_IDS.includes(id.toLowerCase())
}

/**
 * Whether a path segment may be routed to a room. Anything failing this
 * is rejected before a Durable Object is named, so a malformed id can
 * never cause one to be created.
 */
export function isValidRoomId (id:unknown):id is string {
    if (typeof id !== 'string') return false
    if (id.length !== ROOM_ID_LENGTH) return false
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return false
    return !isReservedRoomId(id)
}

/**
 * The socket scheme that matches a page scheme. Anything not listed --
 * `file:` in a test, some future scheme -- gets no socket source at all
 * rather than a guess, so the policy can never be widened by an origin
 * this does not understand.
 */
const SOCKET_SCHEME:Record<string, string> = {
    'http:': 'ws:',
    'https:': 'wss:'
}

/**
 * The response headers every reply carries, API and static asset alike.
 * Defense in depth: no injection vector is known, and the policy is what
 * would keep a future one from reaching the group state on `window`.
 *
 * `origin` is the origin the request arrived at, which is what makes the
 * `connect-src` socket source exact -- `ws://localhost:8787` in
 * development, `wss://<host>` in production -- rather than a scheme
 * wildcard. CSP 3 says `'self'` already covers a same-origin socket, but
 * not every browser in the field implements that, and naming the origin
 * costs nothing.
 *
 * `default-src 'none'` means every directive not listed below is denied,
 * so the app's own scripts, styles and socket are the whole of what is
 * permitted. There is no inline script or style attribute anywhere in
 * the client, which is what lets `script-src` and `style-src` stay at
 * `'self'` with no `unsafe-inline`.
 */
export function securityHeaders (origin:string):Record<string, string> {
    const url = new URL(origin)
    const scheme = SOCKET_SCHEME[url.protocol]
    const socket = scheme ? ` ${scheme}//${url.host}` : ''

    const policy = [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "font-src 'self'",
        `connect-src 'self'${socket}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
    ].join('; ')

    return {
        'Content-Security-Policy': policy,
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff'
    }
}

/**
 * Whether `proof` is a signature over this room's `challenge` by the key
 * that `identity` names. An identity is the base64url of an Ed25519
 * signature public key, so the identity is its own verification key and
 * the room needs no registry.
 *
 * Anything malformed -- an identity that is not a key, a proof that is
 * not base64url -- is a failed proof, never a throw: every input here
 * came off a socket.
 */
export async function verifyIdentityProof (
    identity:string,
    challenge:string,
    roomId:string,
    proof:string
):Promise<boolean> {
    try {
        const subtle = crypto.subtle
        const key = await subtle.importKey(
            'raw',
            bytesToBuffer(base64urlToBytes(identity)),
            { name: 'Ed25519' },
            false,
            ['verify']
        )
        return await subtle.verify(
            { name: 'Ed25519' },
            key,
            bytesToBuffer(base64urlToBytes(proof)),
            identityProofMessage(roomId, challenge)
        )
    } catch {
        return false
    }
}

/**
 * What the room registry says of an id: `live` from `create` until the
 * expiry alarm, `expired` after it, and null for an id no room was ever
 * created under.
 */
export type RegistryEntry = 'live'|'expired'|null

/**
 * How the GET route answers an id, decided before any room object is
 * named. Only a live id is worth asking for its times; anything else is
 * answered 404 from the registry alone, so a GET for an unused id never
 * instantiates a Durable Object to say it has no room.
 */
export function roomInfoDecision (
    entry:RegistryEntry
):'no-room'|'ask-room' {
    return entry === 'live' ? 'ask-room' : 'no-room'
}

/**
 * The per-address limit on socket upgrades, applied at the Worker before
 * a room is named. The Worker cannot tell a `create` from a `hello`
 * before the socket opens, so this bounds both and has to leave room for
 * honest reconnect backoff (`reconnectDelay` in
 * `client/delivery-cursor.ts`) from several tabs behind one address.
 *
 * These are copies: the binding reads its numbers from the `ratelimits`
 * block in `wrangler.jsonc`, which cannot import them. Change the two
 * together. The binding accepts a period of 10 or 60 seconds only.
 */
export const UPGRADE_LIMIT = 100
export const UPGRADE_PERIOD_SECONDS = 60
