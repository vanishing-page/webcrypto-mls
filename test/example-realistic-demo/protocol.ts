import { test } from '@substrate-system/tapzero'
import {
    isClientMessage,
    isRoomMessage,
    isEntryKind,
    isErrorReason,
    isLogEntry,
    isPendingRequest,
    MAX_IDENTITY_LENGTH,
    MAX_CREATOR_TOKEN_LENGTH,
    MAX_PAYLOAD_LENGTH,
    MAX_WIRE_MESSAGE_LENGTH,
} from '../../example-realistic-demo/protocol.js'

/**
 * These narrowing helpers were checked by mutation testing: 96 mutants
 * across protocol.ts and room-logic.ts, every killable one now killed.
 *
 * Five survivors remain and are equivalent mutants -- no legitimate test
 * can kill them, so do not add tests chasing them:
 *
 * 1. isNum dropping `typeof v === 'number'`. Number.isFinite does not
 *    coerce, so it already rejects non-numbers on its own.
 * 2. isEntryKind dropping isStr(v).
 * 3. isErrorReason dropping isStr(v).
 * 4. isPendingRequest dropping isStr(v.standing).
 *    For 2-4, Array.prototype.includes uses SameValueZero, so a
 *    non-string can never match a string member. Each isStr is there to
 *    narrow for TypeScript, not to change the result. Keep them.
 * 5. assembleRoster iterating `known` filtered by a live set rather than
 *    `liveTags` filtered by a known set. A sorted, deduped set
 *    intersection is symmetric in its two arguments.
 *
 * One known future hazard, not a present defect: the Standing whitelist
 * in isPendingRequest is hand-maintained alongside the Standing union.
 * Adding a fourth value to the type would leave the guard silently
 * rejecting it, with no compile error. A Record<Standing, true> form
 * would make the two fail together.
 */

// isClientMessage tests -- accept all variants
test('isClientMessage - create', (t) => {
    t.ok(isClientMessage({ type: 'create', identity: 'key1' }))
})

test('isClientMessage - hello without creatorToken', (t) => {
    t.ok(isClientMessage({ type: 'hello', identity: 'key1', cursor: 5 }))
})

test('isClientMessage - hello with creatorToken', (t) => {
    t.ok(isClientMessage({
        type: 'hello',
        identity: 'key1',
        cursor: 5,
        creatorToken: 'token123'
    }))
})

// creatorToken is the creator-authorization credential, so a wrong-typed
// one must be rejected rather than reaching an auth comparison.
test('isClientMessage - hello creatorToken wrong type', (t) => {
    t.ok(!isClientMessage({
        type: 'hello',
        identity: 'key1',
        cursor: 5,
        creatorToken: 12345
    }))
})

test('isClientMessage - mls commit', (t) => {
    t.ok(isClientMessage({
        type: 'mls',
        kind: 'commit',
        payload: 'base64payload'
    }))
})

test('isClientMessage - mls proposal', (t) => {
    t.ok(isClientMessage({
        type: 'mls',
        kind: 'proposal',
        payload: 'base64payload'
    }))
})

test('isClientMessage - mls application', (t) => {
    t.ok(isClientMessage({
        type: 'mls',
        kind: 'application',
        payload: 'base64payload'
    }))
})

test('isClientMessage - join-request', (t) => {
    t.ok(isClientMessage({
        type: 'join-request',
        identity: 'key1',
        keyPackage: 'kp123'
    }))
})

test('isClientMessage - approve', (t) => {
    t.ok(isClientMessage({ type: 'approve', identity: 'key1' }))
})

test('isClientMessage - deny', (t) => {
    t.ok(isClientMessage({ type: 'deny', identity: 'key1' }))
})

test('isClientMessage - removed', (t) => {
    t.ok(isClientMessage({ type: 'removed', identity: 'key1' }))
})

test('isClientMessage - welcome', (t) => {
    t.ok(isClientMessage({
        type: 'welcome',
        to: 'key1',
        payload: 'welcomepayload'
    }))
})

// isClientMessage tests -- reject unknown type
test('isClientMessage - reject unknown type', (t) => {
    t.ok(!isClientMessage({ type: 'nope' }))
})

// isClientMessage tests -- reject cross-direction type
test('isClientMessage - reject room message type', (t) => {
    t.ok(!isClientMessage({ type: 'roster', live: [] }))
})

// isClientMessage tests -- reject non-object
test('isClientMessage - reject null', (t) => {
    t.ok(!isClientMessage(null))
})

test('isClientMessage - reject undefined', (t) => {
    t.ok(!isClientMessage(undefined))
})

test('isClientMessage - reject number', (t) => {
    t.ok(!isClientMessage(42))
})

test('isClientMessage - reject string', (t) => {
    t.ok(!isClientMessage('hello'))
})

test('isClientMessage - reject boolean', (t) => {
    t.ok(!isClientMessage(true))
})

test('isClientMessage - reject array', (t) => {
    t.ok(!isClientMessage([]))
})

test('isClientMessage - reject array with discriminant', (t) => {
    // typeof [] === 'object', so without the Array.isArray guard an array
    // carrying a valid discriminant would narrow as a message.
    const arr = Object.assign([], { type: 'create', identity: 'k1' })
    t.ok(!isClientMessage(arr))
})

// isClientMessage tests -- reject missing required fields
test('isClientMessage - create missing identity', (t) => {
    t.ok(!isClientMessage({ type: 'create' }))
})

test('isClientMessage - hello missing identity', (t) => {
    t.ok(!isClientMessage({ type: 'hello', cursor: 5 }))
})

test('isClientMessage - hello missing cursor', (t) => {
    t.ok(!isClientMessage({ type: 'hello', identity: 'key1' }))
})

test('isClientMessage - hello cursor as string', (t) => {
    t.ok(!isClientMessage({
        type: 'hello',
        identity: 'key1',
        cursor: '5'
    }))
})

test('isClientMessage - hello cursor as NaN', (t) => {
    t.ok(!isClientMessage({
        type: 'hello',
        identity: 'key1',
        cursor: NaN
    }))
})

test('isClientMessage - hello cursor as Infinity', (t) => {
    t.ok(!isClientMessage({
        type: 'hello',
        identity: 'key1',
        cursor: Infinity
    }))
})

test('isClientMessage - mls missing kind', (t) => {
    t.ok(!isClientMessage({ type: 'mls', payload: 'base64' }))
})

test('isClientMessage - mls missing payload', (t) => {
    t.ok(!isClientMessage({ type: 'mls', kind: 'commit' }))
})

test('isClientMessage - mls invalid kind', (t) => {
    t.ok(!isClientMessage({
        type: 'mls',
        kind: 'invalid',
        payload: 'base64'
    }))
})

test('isClientMessage - join-request missing identity', (t) => {
    t.ok(!isClientMessage({ type: 'join-request', keyPackage: 'kp' }))
})

test('isClientMessage - join-request missing keyPackage', (t) => {
    t.ok(!isClientMessage({ type: 'join-request', identity: 'key1' }))
})

test('isClientMessage - approve missing identity', (t) => {
    t.ok(!isClientMessage({ type: 'approve' }))
})

test('isClientMessage - deny missing identity', (t) => {
    t.ok(!isClientMessage({ type: 'deny' }))
})

test('isClientMessage - removed missing identity', (t) => {
    t.ok(!isClientMessage({ type: 'removed' }))
})

test('isClientMessage - welcome missing to', (t) => {
    t.ok(!isClientMessage({ type: 'welcome', payload: 'p' }))
})

test('isClientMessage - welcome missing payload', (t) => {
    t.ok(!isClientMessage({ type: 'welcome', to: 'key1' }))
})

// isRoomMessage tests -- accept all variants
test('isRoomMessage - created', (t) => {
    t.ok(isRoomMessage({
        type: 'created',
        creatorToken: 'token123',
        expiresAt: 1234567890
    }))
})

test('isRoomMessage - no-room', (t) => {
    t.ok(isRoomMessage({ type: 'no-room' }))
})

test('isRoomMessage - room-state', (t) => {
    t.ok(isRoomMessage({
        type: 'room-state',
        isCreator: true,
        createdAt: 1234567890,
        expiresAt: 1234567999
    }))
})

test('isRoomMessage - log empty', (t) => {
    t.ok(isRoomMessage({ type: 'log', entries: [] }))
})

test('isRoomMessage - log populated', (t) => {
    t.ok(isRoomMessage({
        type: 'log',
        entries: [
            {
                seq: 1,
                sender: 'key1',
                kind: 'commit',
                payload: 'base64'
            }
        ]
    }))
})

test('isRoomMessage - entry', (t) => {
    t.ok(isRoomMessage({
        type: 'entry',
        entry: {
            seq: 1,
            sender: 'key1',
            kind: 'commit',
            payload: 'base64'
        }
    }))
})

test('isRoomMessage - welcome-you', (t) => {
    t.ok(isRoomMessage({
        type: 'welcome-you',
        payload: 'welcomepayload',
        cursor: 5,
        priorCount: 0
    }))
})

test('isRoomMessage - pending', (t) => {
    t.ok(isRoomMessage({
        type: 'pending',
        requests: [{
            identity: 'key1',
            keyPackage: 'kp123',
            requestedAt: 1234567890,
            standing: 'stranger'
        }]
    }))
})

test('isRoomMessage - roster', (t) => {
    t.ok(isRoomMessage({
        type: 'roster',
        live: ['key1', 'key2']
    }))
})

test('isRoomMessage - error room-exists', (t) => {
    t.ok(isRoomMessage({
        type: 'error',
        reason: 'room-exists'
    }))
})

test('isRoomMessage - error not-creator', (t) => {
    t.ok(isRoomMessage({
        type: 'error',
        reason: 'not-creator'
    }))
})

test('isRoomMessage - error not-member', (t) => {
    t.ok(isRoomMessage({
        type: 'error',
        reason: 'not-member'
    }))
})

test('isRoomMessage - error bad-message', (t) => {
    t.ok(isRoomMessage({
        type: 'error',
        reason: 'bad-message'
    }))
})

// isRoomMessage tests -- reject unknown type
test('isRoomMessage - reject unknown type', (t) => {
    t.ok(!isRoomMessage({ type: 'nope' }))
})

// isRoomMessage tests -- reject cross-direction type
test('isRoomMessage - reject client message type', (t) => {
    t.ok(!isRoomMessage({ type: 'create', identity: 'key1' }))
})

// isRoomMessage tests -- reject non-object
test('isRoomMessage - reject null', (t) => {
    t.ok(!isRoomMessage(null))
})

test('isRoomMessage - reject undefined', (t) => {
    t.ok(!isRoomMessage(undefined))
})

test('isRoomMessage - reject number', (t) => {
    t.ok(!isRoomMessage(42))
})

test('isRoomMessage - reject string', (t) => {
    t.ok(!isRoomMessage('hello'))
})

test('isRoomMessage - reject boolean', (t) => {
    t.ok(!isRoomMessage(false))
})

test('isRoomMessage - reject array', (t) => {
    t.ok(!isRoomMessage([]))
})

test('isRoomMessage - reject array with discriminant', (t) => {
    // `no-room` needs no other field, so this is the cheapest frame that
    // would narrow if the Array.isArray guard were dropped.
    const arr = Object.assign([], { type: 'no-room' })
    t.ok(!isRoomMessage(arr))
})

// isRoomMessage tests -- reject missing required fields
test('isRoomMessage - created missing creatorToken', (t) => {
    t.ok(!isRoomMessage({
        type: 'created',
        expiresAt: 1234567890
    }))
})

test('isRoomMessage - created expiresAt NaN', (t) => {
    t.ok(!isRoomMessage({
        type: 'created',
        creatorToken: 't',
        expiresAt: NaN
    }))
})

test('isRoomMessage - created missing expiresAt', (t) => {
    t.ok(!isRoomMessage({
        type: 'created',
        creatorToken: 'token'
    }))
})

test('isRoomMessage - room-state missing isCreator', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        createdAt: 123,
        expiresAt: 456
    }))
})

test('isRoomMessage - room-state missing createdAt', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        isCreator: true,
        expiresAt: 456
    }))
})

test('isRoomMessage - room-state createdAt wrong type', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        isCreator: true,
        createdAt: 'yesterday',
        expiresAt: 456
    }))
})

test('isRoomMessage - room-state missing expiresAt', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        isCreator: true,
        createdAt: 1
    }))
})

// isNum exists to reject NaN and Infinity, which survive a bare typeof
// check. expiresAt drives room expiry, so a non-finite one must not pass.
test('isRoomMessage - room-state expiresAt Infinity', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        isCreator: true,
        createdAt: 1,
        expiresAt: Infinity
    }))
})

test('isRoomMessage - room-state createdAt NaN', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        isCreator: true,
        createdAt: NaN,
        expiresAt: 2
    }))
})

test('isRoomMessage - room-state isCreator wrong type', (t) => {
    t.ok(!isRoomMessage({
        type: 'room-state',
        isCreator: 'yes',
        createdAt: 123,
        expiresAt: 456
    }))
})

test('isRoomMessage - log entries not array', (t) => {
    t.ok(!isRoomMessage({
        type: 'log',
        entries: { seq: 1 }
    }))
})

// A non-object element reaches isLogEntry's own isObject guard.
test('isRoomMessage - log entry element not an object', (t) => {
    t.ok(!isRoomMessage({ type: 'log', entries: [null] }))
})

// One bad element hidden among good ones. Every other rejection frame
// here holds a single invalid element, which `some` would reject too --
// only a mixed array proves the arm demands every entry be valid.
test('isRoomMessage - log rejects mixed valid and invalid entries', (t) => {
    t.ok(!isRoomMessage({
        type: 'log',
        entries: [
            { seq: 1, sender: 'key1', kind: 'commit', payload: 'p' },
            { seq: 2, sender: 'key2', kind: 'bogus-kind', payload: 'p' }
        ]
    }))
})

// An array carrying entry-shaped fields passes every field check, so
// only isLogEntry's isObject guard rejects it. A null element cannot
// prove that guard exists -- optional chaining would reject null too.
test('isRoomMessage - log entry element is an array', (t) => {
    const entry = Object.assign([], {
        seq: 1,
        sender: 'key1',
        kind: 'commit',
        payload: 'base64'
    })
    t.ok(!isRoomMessage({ type: 'log', entries: [entry] }))
})

test('isRoomMessage - log malformed entry', (t) => {
    t.ok(!isRoomMessage({
        type: 'log',
        entries: [
            {
                seq: 'not-a-number',
                sender: 'key1',
                kind: 'commit',
                payload: 'base64'
            }
        ]
    }))
})

test('isRoomMessage - log entry with non-string sender', (t) => {
    t.ok(!isRoomMessage({
        type: 'log',
        entries: [
            {
                seq: 1,
                sender: 123,
                kind: 'commit',
                payload: 'base64'
            }
        ]
    }))
})

test('isRoomMessage - log entry with invalid kind', (t) => {
    t.ok(!isRoomMessage({
        type: 'log',
        entries: [
            {
                seq: 1,
                sender: 'key1',
                kind: 'invalid-kind',
                payload: 'base64'
            }
        ]
    }))
})

test('isRoomMessage - log entry with missing payload', (t) => {
    t.ok(!isRoomMessage({
        type: 'log',
        entries: [
            {
                seq: 1,
                sender: 'key1',
                kind: 'commit'
            }
        ]
    }))
})

test('isRoomMessage - entry missing entry', (t) => {
    t.ok(!isRoomMessage({ type: 'entry' }))
})

test('isRoomMessage - entry malformed', (t) => {
    t.ok(!isRoomMessage({
        type: 'entry',
        entry: {
            seq: NaN,
            sender: 'key1',
            kind: 'commit',
            payload: 'base64'
        }
    }))
})

test('isRoomMessage - entry with non-string sender', (t) => {
    t.ok(!isRoomMessage({
        type: 'entry',
        entry: {
            seq: 1,
            sender: 456,
            kind: 'commit',
            payload: 'base64'
        }
    }))
})

test('isRoomMessage - entry with invalid kind', (t) => {
    t.ok(!isRoomMessage({
        type: 'entry',
        entry: {
            seq: 1,
            sender: 'key1',
            kind: 'bogus-kind',
            payload: 'base64'
        }
    }))
})

test('isRoomMessage - entry with missing payload', (t) => {
    t.ok(!isRoomMessage({
        type: 'entry',
        entry: {
            seq: 1,
            sender: 'key1',
            kind: 'commit'
        }
    }))
})

test('isRoomMessage - welcome-you missing payload', (t) => {
    t.ok(!isRoomMessage({
        type: 'welcome-you',
        cursor: 5,
        priorCount: 0
    }))
})

test('isRoomMessage - welcome-you missing cursor', (t) => {
    t.ok(!isRoomMessage({
        type: 'welcome-you',
        payload: 'p',
        priorCount: 0
    }))
})

test('isRoomMessage - welcome-you cursor as NaN', (t) => {
    t.ok(!isRoomMessage({
        type: 'welcome-you',
        payload: 'p',
        cursor: NaN,
        priorCount: 0
    }))
})

test('isRoomMessage - welcome-you missing priorCount', (t) => {
    t.ok(!isRoomMessage({
        type: 'welcome-you',
        payload: 'p',
        cursor: 5
    }))
})

test('isRoomMessage - welcome-you priorCount as NaN', (t) => {
    t.ok(!isRoomMessage({
        type: 'welcome-you',
        payload: 'p',
        cursor: 5,
        priorCount: NaN
    }))
})

// A non-object element reaches isPendingRequest's own isObject guard.
test('isRoomMessage - pending request element not an object', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: ['not-an-object']
    }))
})

// The mixed-array case, as for `log` above.
test('isRoomMessage - pending rejects mixed valid and invalid', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: [
            {
                identity: 'k1',
                keyPackage: 'kp',
                requestedAt: 1,
                standing: 'stranger'
            },
            {
                identity: 'k2',
                keyPackage: 'kp',
                requestedAt: 2,
                standing: 'bogus'
            }
        ]
    }))
})

// As with log entries, only an array carrying request-shaped fields
// distinguishes the isObject guard from a null-safe field check.
test('isRoomMessage - pending request element is an array', (t) => {
    const request = Object.assign([], {
        identity: 'key1',
        keyPackage: 'kp123',
        requestedAt: 1,
        standing: 'stranger'
    })
    t.ok(!isRoomMessage({ type: 'pending', requests: [request] }))
})

test('isRoomMessage - pending request with non-string identity', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: [{
            identity: 42,
            keyPackage: 'kp123',
            requestedAt: 1,
            standing: 'stranger'
        }]
    }))
})

test('isRoomMessage - pending requests not array', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: { identity: 'key1' }
    }))
})

test('isRoomMessage - pending request missing keyPackage', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: [{
            identity: 'key1',
            requestedAt: 1234567890,
            standing: 'stranger'
        }]
    }))
})

test('isRoomMessage - pending request with unknown standing', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: [{
            identity: 'key1',
            keyPackage: 'kp123',
            requestedAt: 1234567890,
            standing: 'unknown-standing'
        }]
    }))
})

test('isRoomMessage - pending request with NaN requestedAt', (t) => {
    t.ok(!isRoomMessage({
        type: 'pending',
        requests: [{
            identity: 'key1',
            keyPackage: 'kp123',
            requestedAt: NaN,
            standing: 'stranger'
        }]
    }))
})

test('isRoomMessage - roster live not array', (t) => {
    t.ok(!isRoomMessage({
        type: 'roster',
        live: 'key1'
    }))
})

test('isRoomMessage - roster live contains number', (t) => {
    t.ok(!isRoomMessage({
        type: 'roster',
        live: ['key1', 123]
    }))
})

test('isRoomMessage - error missing reason', (t) => {
    t.ok(!isRoomMessage({ type: 'error' }))
})

test('isRoomMessage - error invalid reason', (t) => {
    t.ok(!isRoomMessage({
        type: 'error',
        reason: 'invalid-error'
    }))
})

// isLogEntry direct tests
test('isLogEntry - valid entry', (t) => {
    t.ok(isLogEntry({
        seq: 1,
        sender: 'key1',
        kind: 'commit',
        payload: 'base64'
    }))
})

test('isLogEntry - reject non-string sender', (t) => {
    t.ok(!isLogEntry({
        seq: 1,
        sender: 123,
        kind: 'commit',
        payload: 'base64'
    }))
})

test('isLogEntry - reject invalid kind', (t) => {
    t.ok(!isLogEntry({
        seq: 1,
        sender: 'key1',
        kind: 'invalid-kind',
        payload: 'base64'
    }))
})

test('isLogEntry - reject missing payload', (t) => {
    t.ok(!isLogEntry({
        seq: 1,
        sender: 'key1',
        kind: 'commit'
    }))
})

// isPendingRequest direct tests
test('isPendingRequest - valid request', (t) => {
    t.ok(isPendingRequest({
        identity: 'key1',
        keyPackage: 'kp123',
        requestedAt: 1234567890,
        standing: 'stranger'
    }))
})

// One accept frame per Standing value, matching what isEntryKind and
// isErrorReason already get. Without these, dropping a value from the
// whitelist would make the client reject the whole `pending` message
// for that requester and no test would notice.
test('isPendingRequest - valid request pre-approved', (t) => {
    t.ok(isPendingRequest({
        identity: 'key1',
        keyPackage: 'kp123',
        requestedAt: 1234567890,
        standing: 'pre-approved'
    }))
})

test('isPendingRequest - valid request previously-removed', (t) => {
    t.ok(isPendingRequest({
        identity: 'key1',
        keyPackage: 'kp123',
        requestedAt: 1234567890,
        standing: 'previously-removed'
    }))
})

test('isPendingRequest - reject missing keyPackage', (t) => {
    t.ok(!isPendingRequest({
        identity: 'key1',
        requestedAt: 1234567890,
        standing: 'stranger'
    }))
})

test('isPendingRequest - reject unknown standing', (t) => {
    t.ok(!isPendingRequest({
        identity: 'key1',
        keyPackage: 'kp123',
        requestedAt: 1234567890,
        standing: 'unknown-standing'
    }))
})

test('isPendingRequest - reject NaN requestedAt', (t) => {
    t.ok(!isPendingRequest({
        identity: 'key1',
        keyPackage: 'kp123',
        requestedAt: NaN,
        standing: 'stranger'
    }))
})

// identity is the b64url signature public key and the room's only notion
// of who someone is, so a wrong-typed one must not reach the approval UI.
test('isPendingRequest - reject non-string identity', (t) => {
    t.ok(!isPendingRequest({
        identity: 42,
        keyPackage: 'kp123',
        requestedAt: 1234567890,
        standing: 'stranger'
    }))
})

test('isPendingRequest - reject non-object', (t) => {
    t.ok(!isPendingRequest(null))
    t.ok(!isPendingRequest('not-an-object'))
})

// isEntryKind tests
test('isEntryKind - commit', (t) => {
    t.ok(isEntryKind('commit'))
})

test('isEntryKind - proposal', (t) => {
    t.ok(isEntryKind('proposal'))
})

test('isEntryKind - application', (t) => {
    t.ok(isEntryKind('application'))
})

test('isEntryKind - reject near-miss', (t) => {
    t.ok(!isEntryKind('committ'))
})

test('isEntryKind - reject non-string', (t) => {
    t.ok(!isEntryKind(123))
})

// isErrorReason tests
test('isErrorReason - room-exists', (t) => {
    t.ok(isErrorReason('room-exists'))
})

test('isErrorReason - not-creator', (t) => {
    t.ok(isErrorReason('not-creator'))
})

test('isErrorReason - not-member', (t) => {
    t.ok(isErrorReason('not-member'))
})

test('isErrorReason - bad-message', (t) => {
    t.ok(isErrorReason('bad-message'))
})

// The three join-request limits. Each is a distinct reason on the wire,
// so a client can tell "your key package is too big" from "come back
// later" without parsing prose.
test('isErrorReason - key-package-too-large', (t) => {
    t.ok(isErrorReason('key-package-too-large'))
})

test('isErrorReason - too-many-pending', (t) => {
    t.ok(isErrorReason('too-many-pending'))
})

test('isErrorReason - rate-limited', (t) => {
    t.ok(isErrorReason('rate-limited'))
})

test('isErrorReason - reject near-miss', (t) => {
    t.ok(!isErrorReason('room-exist'))
})

test('isErrorReason - reject non-string', (t) => {
    t.ok(!isErrorReason(456))
})

/**
 * Length bounds (security-audit M1). Every string off the wire is
 * bounded, so an admitted member cannot append a multi-MB payload that
 * the room persists for three days and re-broadcasts on every
 * reconnect.
 *
 * Each bound is tested at both edges: exactly at the limit is accepted,
 * one character over is refused. The over-limit half is what fails if a
 * bound is removed; the at-limit half is what fails if a bound is
 * tightened past what real MLS traffic needs.
 */

test('isClientMessage - mls payload at the limit', (t) => {
    t.ok(isClientMessage({
        type: 'mls',
        kind: 'application',
        payload: 'A'.repeat(MAX_PAYLOAD_LENGTH)
    }))
})

test('isClientMessage - mls payload one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'mls',
        kind: 'application',
        payload: 'A'.repeat(MAX_PAYLOAD_LENGTH + 1)
    }))
})

test('isClientMessage - create identity at the limit', (t) => {
    t.ok(isClientMessage({
        type: 'create',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH)
    }))
})

test('isClientMessage - create identity one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'create',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH + 1)
    }))
})

test('isClientMessage - hello identity one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'hello',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH + 1),
        cursor: 0
    }))
})

test('isClientMessage - hello creatorToken one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'hello',
        identity: 'key1',
        cursor: 0,
        creatorToken: 'A'.repeat(MAX_CREATOR_TOKEN_LENGTH + 1)
    }))
})

test('isClientMessage - approve identity one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'approve',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH + 1)
    }))
})

test('isClientMessage - deny identity one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'deny',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH + 1)
    }))
})

test('isClientMessage - removed identity one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'removed',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH + 1)
    }))
})

/**
 * The join-request key package gets the structural wall here and the
 * tighter, named limit in `classifyJoinRequest`. A key package between
 * the two is still answered `key-package-too-large` rather than
 * `bad-message`, which is why the wall is the payload bound and not
 * MAX_KEY_PACKAGE_LENGTH.
 */
test('isClientMessage - join-request key package at the wall', (t) => {
    t.ok(isClientMessage({
        type: 'join-request',
        identity: 'key1',
        keyPackage: 'A'.repeat(MAX_PAYLOAD_LENGTH)
    }))
})

test('isClientMessage - join-request key package over the wall', (t) => {
    t.ok(!isClientMessage({
        type: 'join-request',
        identity: 'key1',
        keyPackage: 'A'.repeat(MAX_PAYLOAD_LENGTH + 1)
    }))
})

test('isClientMessage - join-request identity over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'join-request',
        identity: 'A'.repeat(MAX_IDENTITY_LENGTH + 1),
        keyPackage: 'kp123'
    }))
})

test('isClientMessage - welcome payload one over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'welcome',
        to: 'key1',
        payload: 'A'.repeat(MAX_PAYLOAD_LENGTH + 1)
    }))
})

test('isClientMessage - welcome recipient over the limit', (t) => {
    t.ok(!isClientMessage({
        type: 'welcome',
        to: 'A'.repeat(MAX_IDENTITY_LENGTH + 1),
        payload: 'w'
    }))
})

// The same strings come back out in room messages, so the client
// applies the same bounds on the way in.

test('isLogEntry - payload one over the limit', (t) => {
    t.ok(!isLogEntry({
        seq: 1,
        sender: 'key1',
        kind: 'application',
        payload: 'A'.repeat(MAX_PAYLOAD_LENGTH + 1)
    }))
})

test('isLogEntry - sender one over the limit', (t) => {
    t.ok(!isLogEntry({
        seq: 1,
        sender: 'A'.repeat(MAX_IDENTITY_LENGTH + 1),
        kind: 'application',
        payload: 'p'
    }))
})

test('isPendingRequest - key package over the wall', (t) => {
    t.ok(!isPendingRequest({
        identity: 'key1',
        keyPackage: 'A'.repeat(MAX_PAYLOAD_LENGTH + 1),
        requestedAt: 1,
        standing: 'stranger'
    }))
})

test('isRoomMessage - welcome-you payload over the limit', (t) => {
    t.ok(!isRoomMessage({
        type: 'welcome-you',
        payload: 'A'.repeat(MAX_PAYLOAD_LENGTH + 1),
        cursor: 0,
        priorCount: 0
    }))
})

test('isRoomMessage - created token over the limit', (t) => {
    t.ok(!isRoomMessage({
        type: 'created',
        creatorToken: 'A'.repeat(MAX_CREATOR_TOKEN_LENGTH + 1),
        expiresAt: 1
    }))
})

test('isRoomMessage - roster identity over the limit', (t) => {
    t.ok(!isRoomMessage({
        type: 'roster',
        live: ['ok', 'A'.repeat(MAX_IDENTITY_LENGTH + 1)]
    }))
})

/**
 * The whole-frame wall, applied before JSON.parse rather than after, so
 * a multi-megabyte frame is dropped without being parsed at all. It has
 * to sit above MAX_PAYLOAD_LENGTH or a legal maximum-size payload could
 * never fit inside a legal frame.
 */
test('the frame wall leaves room for a maximum-size payload', (t) => {
    t.ok(MAX_WIRE_MESSAGE_LENGTH > MAX_PAYLOAD_LENGTH)
})
