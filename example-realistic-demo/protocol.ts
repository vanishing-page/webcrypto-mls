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

export type ErrorReason =
    | 'room-exists'
    | 'not-creator'
    | 'not-member'
    | 'bad-message'

export type ClientMessage =
    | {
        type:'create'
        identity:string
    }
    | {
        type:'hello'
        identity:string
        cursor:number
        creatorToken?:string
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

export type RoomMessage =
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
    'bad-message'
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
        isStr(v.sender) &&
        isEntryKind(v.kind) &&
        isStr(v.payload)
    )
}

export function isPendingRequest (v:unknown):v is PendingRequest {
    return (
        isObject(v) &&
        isStr(v.identity) &&
        isStr(v.keyPackage) &&
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
            return isStr(v.identity)
        case 'hello':
            return isStr(v.identity) && isNum(v.cursor) &&
                (v.creatorToken === undefined || isStr(v.creatorToken))
        case 'mls':
            return isEntryKind(v.kind) && isStr(v.payload)
        case 'join-request':
            return isStr(v.identity) && isStr(v.keyPackage)
        case 'approve':
        case 'deny':
        case 'removed':
            return isStr(v.identity)
        case 'welcome':
            return isStr(v.to) && isStr(v.payload)
        default:
            return false
    }
}

export function isRoomMessage (v:unknown):v is RoomMessage {
    if (!isObject(v)) return false

    switch (v.type) {
        case 'created':
            return isStr(v.creatorToken) && isNum(v.expiresAt)
        case 'no-room':
            return true
        case 'room-state':
            return typeof v.isCreator === 'boolean' &&
                isNum(v.createdAt) && isNum(v.expiresAt)
        case 'log':
            return Array.isArray(v.entries) &&
                v.entries.every(isLogEntry)
        case 'entry':
            return isLogEntry(v.entry)
        case 'welcome-you':
            return isStr(v.payload) && isNum(v.cursor) &&
                isNum(v.priorCount)
        case 'pending':
            return Array.isArray(v.requests) &&
                v.requests.every(isPendingRequest)
        case 'roster':
            return Array.isArray(v.live) && v.live.every(isStr)
        case 'error':
            return isErrorReason(v.reason)
        default:
            return false
    }
}
