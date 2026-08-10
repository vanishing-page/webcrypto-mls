import type { EntryKind, LogEntry, Standing } from './protocol.js'

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
 * storage growth by a stranger, not a disclosure. It is not
 * authentication either -- an identity is a public signature key that
 * anyone who has seen the log knows, so a stranger who copies an admitted
 * member's identity still gets through. What it stops is a caller who has
 * never been admitted at all.
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
