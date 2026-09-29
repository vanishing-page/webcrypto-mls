/**
 * The wire contract, and the only definition of it. Imported by the
 * Worker, by the browser client, and by the Node test bundle, so it
 * imports nothing -- not the DOM, not Cloudflare globals, not `../src/`.
 *
 * Two kinds of traffic share one socket. MLS payloads are opaque base64
 * the room stores, orders and forwards without ever decoding. Control
 * messages are a small vocabulary the room does understand, enough to
 * keep a ledger of who was admitted.
 *
 * Identity is always the base64url signature public key, never the
 * display name. No message here carries a name as a field of its own --
 * the creator's client reads a name out of a key package when it commits
 * the Add, and every other name comes from the client's own ratchet
 * tree. That is not the same as a name being hidden from the room: a
 * key package carries its name as a basic credential in the clear, so
 * every name except the creator's is readable by anything that sees a
 * `join-request` or the public Add that follows it.
 */

export type EntryKind = 'commit'|'proposal'|'application'

export interface LogEntry {
    seq:number
    sender:string          // b64url signature public key
    kind:EntryKind         // asserted by sender, unverified
    payload:string         // b64 MLSMessage
}

export type Standing = 'stranger'|'pre-approved'|'previously-removed'

export interface PendingRequest {
    identity:string
    keyPackage:string
    requestedAt:number
    standing:Standing
}

/**
 * The last three are the join-request limits, kept apart rather than
 * folded into one refusal: an oversized key package is a bug in the
 * requester, a full queue is the room's state, and a rate limit is
 * temporary. See `classifyJoinRequest` in `room-logic.ts`.
 */
export type ErrorReason =
    | 'room-exists'
    | 'not-creator'
    | 'not-member'
    | 'bad-message'
    | 'key-package-too-large'
    | 'too-many-pending'
    | 'rate-limited'
    | 'commit-not-creator'
    | 'bad-proof'
    | 'log-full'
    | 'log-too-large'

export type ClientMessage =
    | {
        type:'create'
        identity:string
        proof?:string
    }
    | {
        type:'hello'
        identity:string
        cursor:number
        creatorToken?:string
        proof?:string
    }
    | {
        type:'mls'
        kind:EntryKind
        payload:string
    }
    | {
        type:'join-request'
        identity:string
        keyPackage:string
    }
    | {
        type:'approve'
        identity:string
    }
    | {
        type:'deny'
        identity:string
    }
    | {
        type:'removed'
        identity:string
    }
    | {
        type:'welcome'
        to:string
        payload:string
    }
    | {
        // The next replay page, after the last seq the client received.
        // Sent only in answer to a `log` page that said `more`.
        type:'replay'
        cursor:number
    }

export type RoomMessage =
    | {
        type:'challenge'
        challenge:string
    }
    | {
        type:'created'
        creatorToken:string
        expiresAt:number
    }
    | {
        type:'no-room'
    }
    | {
        type:'room-state'
        isCreator:boolean
        createdAt:number
        expiresAt:number
    }
    | {
        type:'log'
        entries:LogEntry[]
        // True when entries after this page remain; the client asks for
        // them with `replay`. Absent means none do. See `replayPage`.
        more?:boolean
    }
    | {
        type:'entry'
        entry:LogEntry
    }
    | {
        type:'welcome-you'
        payload:string
        cursor:number
        priorCount:number
    }
    | {
        type:'pending'
        requests:PendingRequest[]
    }
    | {
        type:'roster'
        live:string[]
    }
    | {
        type:'error'
        reason:ErrorReason
    }

// Anything arriving off a socket is unknown until proven otherwise.
// These narrow it, and are the only place that decision is made.

function isObject (v:unknown):v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStr (v:unknown):v is string {
    return typeof v === 'string'
}

/**
 * Length bounds, in wire characters -- these count UTF-16 code units of
 * the JSON string, not decoded bytes, because the room stores and
 * forwards exactly what it was given and never decodes a payload.
 *
 * Bounding is separate from parsing on purpose. Without it every string
 * here is checked for its type and nothing else, so an admitted member
 * can append a multi-megabyte `mls` payload that the room persists for
 * three days and re-broadcasts to every peer on every reconnect. The
 * question the type checks answer is who may write; these answer how
 * large a write may be.
 *
 * Every bound is generous against real traffic:
 *
 * - An identity is the base64url of a signature public key: 43
 *   characters for Ed25519, 178 for the largest NIST curve MLS defines.
 *   512 leaves several times that.
 * - A creator token is a `crypto.randomUUID()`, 36 characters.
 * - A payload is base64 of one MLSMessage. Application messages are a
 *   few hundred bytes; a commit with an UpdatePath grows with the group,
 *   on the order of a kilobyte per member. 256 KiB is a room of
 *   thousands, which this demo will never be, and still refuses the
 *   megabyte writes an unbounded field invites.
 *
 * - A challenge is 32 random bytes as base64url, 43 characters.
 * - A proof is a signature as base64url: 86 characters for Ed25519.
 *
 * A display name has no bound of its own because it has no field of its
 * own -- it rides inside a key package as a basic credential, so it is
 * bounded by whatever bounds the key package.
 *
 * `MAX_WIRE_MESSAGE_LENGTH` is the whole-frame wall, checked before
 * `JSON.parse` so an enormous frame costs no parse. It sits above
 * `MAX_PAYLOAD_LENGTH` because a legal maximum-size payload still has to
 * fit inside a legal frame, with its JSON envelope.
 *
 * A join request's key package is bounded here at `MAX_PAYLOAD_LENGTH`,
 * which is the structural wall rather than the real rule.
 * `MAX_KEY_PACKAGE_LENGTH` in `room-logic.ts` is much tighter and is
 * what a requester is actually held to; keeping the wall loose is what
 * lets a merely-too-big key package be answered `key-package-too-large`
 * instead of a bare `bad-message`.
 */
export const MAX_IDENTITY_LENGTH = 512
export const MAX_CREATOR_TOKEN_LENGTH = 128
export const MAX_CHALLENGE_LENGTH = 128
export const MAX_PROOF_LENGTH = 512
export const MAX_PAYLOAD_LENGTH = 256 * 1024
export const MAX_WIRE_MESSAGE_LENGTH = MAX_PAYLOAD_LENGTH + 64 * 1024

// A string of at most `max` characters. The bound is inclusive: a value
// of exactly `max` is legal, and one character more is not.
function isBounded (v:unknown, max:number):v is string {
    return isStr(v) && v.length <= max
}

function isIdentity (v:unknown):v is string {
    return isBounded(v, MAX_IDENTITY_LENGTH)
}

function isPayload (v:unknown):v is string {
    return isBounded(v, MAX_PAYLOAD_LENGTH)
}

// Optional until every client sends one; see `verifyIdentityProof` in
// `room-logic.ts` for what it proves.
function isOptionalProof (v:unknown):boolean {
    return v === undefined || isBounded(v, MAX_PROOF_LENGTH)
}

// Rejects NaN and Infinity, which survive a `typeof === 'number'` check
// and would otherwise corrupt a cursor or a seq comparison.
function isNum (v:unknown):v is number {
    return typeof v === 'number' && Number.isFinite(v)
}

const ENTRY_KINDS:readonly string[] = [
    'commit',
    'proposal',
    'application'
]

const ERROR_REASONS:readonly string[] = [
    'room-exists',
    'not-creator',
    'not-member',
    'bad-message',
    'key-package-too-large',
    'too-many-pending',
    'rate-limited',
    'commit-not-creator',
    'bad-proof',
    'log-full',
    'log-too-large'
]

export function isEntryKind (v:unknown):v is EntryKind {
    return isStr(v) && ENTRY_KINDS.includes(v)
}

export function isErrorReason (v:unknown):v is ErrorReason {
    return isStr(v) && ERROR_REASONS.includes(v)
}

export function isLogEntry (v:unknown):v is LogEntry {
    return (
        isObject(v) &&
        isNum(v.seq) &&
        isIdentity(v.sender) &&
        isEntryKind(v.kind) &&
        isPayload(v.payload)
    )
}

export function isPendingRequest (v:unknown):v is PendingRequest {
    return (
        isObject(v) &&
        isIdentity(v.identity) &&
        isPayload(v.keyPackage) &&
        isNum(v.requestedAt) &&
        isStr(v.standing) &&
        ['stranger', 'pre-approved', 'previously-removed']
            .includes(v.standing)
    )
}

export function isClientMessage (v:unknown):v is ClientMessage {
    if (!isObject(v)) return false

    switch (v.type) {
        case 'create':
            return isIdentity(v.identity) && isOptionalProof(v.proof)
        case 'hello':
            return isIdentity(v.identity) && isNum(v.cursor) &&
                (v.creatorToken === undefined ||
                    isBounded(v.creatorToken, MAX_CREATOR_TOKEN_LENGTH)) &&
                isOptionalProof(v.proof)
        case 'mls':
            return isEntryKind(v.kind) && isPayload(v.payload)
        case 'join-request':
            return isIdentity(v.identity) && isPayload(v.keyPackage)
        case 'approve':
        case 'deny':
        case 'removed':
            return isIdentity(v.identity)
        case 'welcome':
            return isIdentity(v.to) && isPayload(v.payload)
        case 'replay':
            return isNum(v.cursor)
        default:
            return false
    }
}

export function isRoomMessage (v:unknown):v is RoomMessage {
    if (!isObject(v)) return false

    switch (v.type) {
        case 'challenge':
            return isBounded(v.challenge, MAX_CHALLENGE_LENGTH)
        case 'created':
            return isBounded(v.creatorToken, MAX_CREATOR_TOKEN_LENGTH) &&
                isNum(v.expiresAt)
        case 'no-room':
            return true
        case 'room-state':
            return typeof v.isCreator === 'boolean' &&
                isNum(v.createdAt) && isNum(v.expiresAt)
        case 'log':
            return Array.isArray(v.entries) &&
                v.entries.every(isLogEntry) &&
                (v.more === undefined || typeof v.more === 'boolean')
        case 'entry':
            return isLogEntry(v.entry)
        case 'welcome-you':
            return isPayload(v.payload) && isNum(v.cursor) &&
                isNum(v.priorCount)
        case 'pending':
            return Array.isArray(v.requests) &&
                v.requests.every(isPendingRequest)
        case 'roster':
            return Array.isArray(v.live) && v.live.every(isIdentity)
        case 'error':
            return isErrorReason(v.reason)
        default:
            return false
    }
}

/**
 * The bytes a client signs to prove it holds the identity it claims.
 * A fixed label keeps the signature from meaning anything anywhere
 * else, and the room id binds it to one room, so a proof captured in
 * one room is refused in another. Each part is length-prefixed, so no
 * split of room id and challenge can collide with another.
 *
 * Shared by the room, which verifies, and the client, which signs, so
 * the two cannot drift apart.
 */
export const IDENTITY_PROOF_LABEL = 'webcrypto-mls realistic demo hello v1'

export function identityProofMessage (
    roomId:string,
    challenge:string
):Uint8Array<ArrayBuffer> {
    const enc = new TextEncoder()
    const parts = [IDENTITY_PROOF_LABEL, roomId, challenge]
        .map(part => enc.encode(part))
    const out = new Uint8Array(
        parts.reduce((n, part) => n + 4 + part.length, 0)
    )
    const view = new DataView(out.buffer)
    let at = 0
    for (const part of parts) {
        view.setUint32(at, part.length)
        out.set(part, at + 4)
        at += 4 + part.length
    }
    return out
}
