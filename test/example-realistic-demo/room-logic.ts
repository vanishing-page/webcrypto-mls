import { test } from '@substrate-system/tapzero'
import {
    nextSeq,
    entriesAfter,
    entryFromMls,
    assembleRoster,
    classifyStanding,
    mayWriteLog,
    isValidRoomId,
    isReservedRoomId,
    countApplicationsAtOrBelow,
    classifyJoinRequest,
    RESERVED_ROOM_IDS,
    MAX_PENDING_REQUESTS,
    MAX_KEY_PACKAGE_LENGTH,
    JOIN_REQUEST_INTERVAL_MS,
    securityHeaders,
} from '../../example-realistic-demo/room-logic.js'
import type { LogEntry } from '../../example-realistic-demo/protocol.js'

// nextSeq tests
test('nextSeq - empty room starts at 1', (t) => {
    t.equal(nextSeq(0), 1)
})

test('nextSeq - increments by 1', (t) => {
    t.equal(nextSeq(1), 2)
    t.equal(nextSeq(100), 101)
})

test('nextSeq - never at or below input', (t) => {
    const result = nextSeq(42)
    t.ok(result > 42)
})

test('nextSeq - floors float input', (t) => {
    t.equal(nextSeq(5.7), 6)
})

test('nextSeq - handles negative by flooring to 0', (t) => {
    t.equal(nextSeq(-5), 1)
})

// entriesAfter tests
test('entriesAfter - returns empty for cursor at high water', (t) => {
    const entries:LogEntry[] = [
        { seq: 1, sender: 'k1', kind: 'commit', payload: 'p1' },
        { seq: 2, sender: 'k2', kind: 'proposal', payload: 'p2' }
    ]
    const result = entriesAfter(entries, 2)
    t.equal(result.length, 0)
})

test('entriesAfter - returns only seqs greater than cursor', (t) => {
    const entries:LogEntry[] = [
        { seq: 1, sender: 'k1', kind: 'commit', payload: 'p1' },
        { seq: 2, sender: 'k2', kind: 'proposal', payload: 'p2' },
        { seq: 3, sender: 'k3', kind: 'application', payload: 'p3' }
    ]
    const result = entriesAfter(entries, 1)
    t.equal(result.length, 2)
    t.equal(result[0].seq, 2)
    t.equal(result[1].seq, 3)
})

test('entriesAfter - returns everything for cursor 0', (t) => {
    const entries:LogEntry[] = [
        { seq: 1, sender: 'k1', kind: 'commit', payload: 'p1' },
        { seq: 2, sender: 'k2', kind: 'proposal', payload: 'p2' }
    ]
    const result = entriesAfter(entries, 0)
    t.equal(result.length, 2)
})

test('entriesAfter - returns empty array for empty input', (t) => {
    const result = entriesAfter([], 0)
    t.equal(result.length, 0)
})

test('entriesAfter - sorts shuffled input', (t) => {
    const entries:LogEntry[] = [
        { seq: 3, sender: 'k3', kind: 'application', payload: 'p3' },
        { seq: 1, sender: 'k1', kind: 'commit', payload: 'p1' },
        { seq: 2, sender: 'k2', kind: 'proposal', payload: 'p2' }
    ]
    const result = entriesAfter(entries, 0)
    t.equal(result.length, 3)
    t.equal(result[0].seq, 1)
    t.equal(result[1].seq, 2)
    t.equal(result[2].seq, 3)
})

test('entriesAfter - cursor beyond highest seq', (t) => {
    const entries:LogEntry[] = [
        { seq: 1, sender: 'k1', kind: 'commit', payload: 'p1' }
    ]
    const result = entriesAfter(entries, 100)
    t.equal(result.length, 0)
})

// entryFromMls tests
test('entryFromMls - passes through seq', (t) => {
    const entry = entryFromMls(1, 'sender1', 'commit', 'payload1')
    t.equal(entry.seq, 1)
})

test('entryFromMls - passes through sender', (t) => {
    const entry = entryFromMls(1, 'sender1', 'commit', 'payload1')
    t.equal(entry.sender, 'sender1')
})

test('entryFromMls - passes through kind unaltered', (t) => {
    const entry = entryFromMls(1, 'sender1', 'proposal', 'payload1')
    t.equal(entry.kind, 'proposal')
})

test('entryFromMls - passes through payload unaltered', (t) => {
    const entry = entryFromMls(1, 'sender1', 'commit', 'payload1')
    t.equal(entry.payload, 'payload1')
})

test('entryFromMls - preserves base64 padding', (t) => {
    const payloadWithPadding = 'SGVsbG8gV29ybGQ='
    const entry = entryFromMls(1, 'sender1', 'commit', payloadWithPadding)
    t.equal(entry.payload, payloadWithPadding)
})

test('entryFromMls - preserves empty string payload', (t) => {
    const entry = entryFromMls(1, 'sender1', 'commit', '')
    t.equal(entry.payload, '')
})

// The plan requires the payload not be trimmed. A padded or empty
// payload is trim-invariant, so only surrounding whitespace proves it.
test('entryFromMls - does not trim the payload', (t) => {
    const padded = '  SGVsbG8=  '
    const entry = entryFromMls(1, 'sender1', 'commit', padded)
    t.equal(entry.payload, padded)
})

test('entryFromMls - application kind', (t) => {
    const entry = entryFromMls(99, 'sender', 'application', 'payload')
    t.equal(entry.kind, 'application')
})

// classifyStanding tests -- AC4.5 stranger
test('classifyStanding - stranger when in neither list', (t) => {
    const standing = classifyStanding('identity1', ['other1'], ['other2'])
    t.equal(standing, 'stranger')
})

test('classifyStanding - stranger when both lists empty', (t) => {
    const standing = classifyStanding('identity1', [], [])
    t.equal(standing, 'stranger')
})

test('classifyStanding - stranger when others in lists', (t) => {
    const standing = classifyStanding(
        'identity1',
        ['other1', 'other2'],
        ['other3']
    )
    t.equal(standing, 'stranger')
})

// classifyStanding tests -- AC4.6 pre-approved
test('classifyStanding - pre-approved when admitted', (t) => {
    const standing = classifyStanding('identity1', ['identity1'], [])
    t.equal(standing, 'pre-approved')
})

test('classifyStanding - pre-approved not removed', (t) => {
    const standing = classifyStanding(
        'identity1',
        ['identity1', 'other'],
        ['other2']
    )
    t.equal(standing, 'pre-approved')
})

// classifyStanding tests -- AC4.7 previously-removed
test('classifyStanding - previously-removed when in removed', (t) => {
    const standing = classifyStanding('identity1', [], ['identity1'])
    t.equal(standing, 'previously-removed')
})

test('classifyStanding - previously-removed when in both lists', (t) => {
    const standing = classifyStanding(
        'identity1',
        ['identity1'],
        ['identity1']
    )
    t.equal(standing, 'previously-removed')
})

test('classifyStanding - removal takes precedence', (t) => {
    const standing = classifyStanding(
        'identity1',
        ['identity1', 'admitted'],
        ['identity1', 'removed']
    )
    t.equal(standing, 'previously-removed')
})

// assembleRoster tests
test('assembleRoster - includes known and live', (t) => {
    const roster = assembleRoster(['key1', 'key2'], ['key1'])
    t.ok(roster.includes('key1'))
})

test('assembleRoster - excludes live but not known', (t) => {
    const roster = assembleRoster(['key1'], ['key1', 'key2'])
    t.ok(!roster.includes('key2'))
})

test('assembleRoster - excludes known but not live', (t) => {
    const roster = assembleRoster(['key1', 'key2'], ['key1'])
    t.ok(!roster.includes('key2'))
})

test('assembleRoster - dedupes reconnect case', (t) => {
    const roster = assembleRoster(['key1'], ['key1', 'key1'])
    t.equal(roster.length, 1)
})

test('assembleRoster - returns sorted array', (t) => {
    const roster = assembleRoster(
        ['z', 'a', 'b'],
        ['z', 'a', 'b']
    )
    t.deepEqual(roster, ['a', 'b', 'z'])
})

test('assembleRoster - empty known', (t) => {
    const roster = assembleRoster([], ['key1'])
    t.equal(roster.length, 0)
})

test('assembleRoster - empty live', (t) => {
    const roster = assembleRoster(['key1'], [])
    t.equal(roster.length, 0)
})

test('assembleRoster - both empty', (t) => {
    const roster = assembleRoster([], [])
    t.equal(roster.length, 0)
})

// isValidRoomId tests

// Accept: well-formed ids of exactly ROOM_ID_LENGTH
test('isValidRoomId - accepts 10-char id from valid alphabet', (t) => {
    t.ok(isValidRoomId('aBcDeFgHiJ'))
})

test('isValidRoomId - accepts id with hyphen', (t) => {
    t.ok(isValidRoomId('abc-defghi'))
})

test('isValidRoomId - accepts id with underscore', (t) => {
    t.ok(isValidRoomId('abc_defghi'))
})

test('isValidRoomId - accepts all-digit id', (t) => {
    t.ok(isValidRoomId('0123456789'))
})

test('isValidRoomId - accepts mixed-case id', (t) => {
    t.ok(isValidRoomId('AbCdEfGhIj'))
})

// Reject: out-of-alphabet characters
test('isValidRoomId - rejects id with dot', (t) => {
    t.ok(!isValidRoomId('abc.defghi'))
})

test('isValidRoomId - rejects id with slash', (t) => {
    t.ok(!isValidRoomId('abc/defghi'))
})

test('isValidRoomId - rejects id with percent', (t) => {
    t.ok(!isValidRoomId('abc%defghi'))
})

test('isValidRoomId - rejects id with space', (t) => {
    t.ok(!isValidRoomId('abc defghi'))
})

test('isValidRoomId - rejects id with plus', (t) => {
    t.ok(!isValidRoomId('abc+defghi'))
})

test('isValidRoomId - rejects id with non-ASCII', (t) => {
    t.ok(!isValidRoomId('abcDefghiá'))
})

// Reject: wrong length
test('isValidRoomId - rejects id shorter than 10', (t) => {
    t.ok(!isValidRoomId('short'))
})

test('isValidRoomId - rejects empty string', (t) => {
    t.ok(!isValidRoomId(''))
})

test('isValidRoomId - rejects id longer than 10', (t) => {
    t.ok(!isValidRoomId('waytoolongid'))
})

// Reject: reserved words case-insensitively
test('isValidRoomId - rejects lowercase reserved word api', (t) => {
    t.ok(!isValidRoomId('api'))
})

test('isValidRoomId - rejects uppercase reserved word API', (t) => {
    t.ok(!isValidRoomId('API'))
})

test('isValidRoomId - rejects mixed-case reserved word Api', (t) => {
    t.ok(!isValidRoomId('Api'))
})

test('isValidRoomId - rejects lowercase reserved word assets', (t) => {
    t.ok(!isValidRoomId('assets'))
})

test('isValidRoomId - rejects uppercase reserved word ASSETS', (t) => {
    t.ok(!isValidRoomId('ASSETS'))
})

test('isValidRoomId - rejects lowercase reserved word docs', (t) => {
    t.ok(!isValidRoomId('docs'))
})

test('isValidRoomId - rejects uppercase reserved word DOCS', (t) => {
    t.ok(!isValidRoomId('DOCS'))
})

test('isValidRoomId - rejects lowercase reserved word index', (t) => {
    t.ok(!isValidRoomId('index'))
})

test('isValidRoomId - rejects uppercase reserved word INDEX', (t) => {
    t.ok(!isValidRoomId('INDEX'))
})

// The isValidRoomId cases above cannot prove the reserved rule works:
// every reserved word is shorter than ROOM_ID_LENGTH, so they are
// rejected on length and would still be rejected with the reserved check
// deleted. These call the rule directly, which is the only way to show it
// bites -- and it must, because it is what stops a room id shadowing a
// real path if ROOM_ID_LENGTH ever changes.
test('isReservedRoomId - every reserved word is reserved', (t) => {
    for (const word of RESERVED_ROOM_IDS) {
        t.ok(isReservedRoomId(word), word)
    }
})

test('isReservedRoomId - matches regardless of case', (t) => {
    t.ok(isReservedRoomId('API'))
    t.ok(isReservedRoomId('Api'))
    t.ok(isReservedRoomId('AsSeTs'))
    t.ok(isReservedRoomId('DOCS'))
    t.ok(isReservedRoomId('Index'))
})

test('isReservedRoomId - an ordinary id is not reserved', (t) => {
    t.ok(!isReservedRoomId('aB3xK9pQ2m'))
    t.ok(!isReservedRoomId('apix'))
    t.ok(!isReservedRoomId(''))
})

// Reject: non-strings
test('isValidRoomId - rejects null', (t) => {
    t.ok(!isValidRoomId(null))
})

test('isValidRoomId - rejects undefined', (t) => {
    t.ok(!isValidRoomId(undefined))
})

test('isValidRoomId - rejects number', (t) => {
    t.ok(!isValidRoomId(1234567890))
})

test('isValidRoomId - rejects object', (t) => {
    t.ok(!isValidRoomId({ id: 'test' }))
})

test('isValidRoomId - rejects array', (t) => {
    t.ok(!isValidRoomId(['test']))
})

// countApplicationsAtOrBelow tests
//
// This is what a joiner's "N messages before you joined" placeholder is
// built from, so the two things worth pinning are which kinds count and
// where the boundary sits.

const mixedLog:LogEntry[] = [
    { seq: 1, sender: 'a', kind: 'commit', payload: 'p1' },
    { seq: 2, sender: 'a', kind: 'application', payload: 'p2' },
    { seq: 3, sender: 'a', kind: 'proposal', payload: 'p3' },
    { seq: 4, sender: 'a', kind: 'application', payload: 'p4' },
    { seq: 5, sender: 'a', kind: 'application', payload: 'p5' }
]

test('countApplicationsAtOrBelow - ignores commits and proposals', (t) => {
    // seq 1-4 holds one commit, one proposal and two applications.
    t.equal(countApplicationsAtOrBelow(mixedLog, 4), 2)
})

test('countApplicationsAtOrBelow - ignores entries above the cursor', (t) => {
    // seq 5 is an application and must not be counted at cursor 4.
    t.equal(countApplicationsAtOrBelow(mixedLog, 4), 2)
    t.equal(countApplicationsAtOrBelow(mixedLog, 5), 3)
})

// The boundary case. An off-by-one here is the difference between a
// joiner being told 11 messages and 12, and nothing else in the system
// would notice.
test('countApplicationsAtOrBelow - counts an entry at the cursor', (t) => {
    const atBoundary:LogEntry[] = [
        { seq: 7, sender: 'a', kind: 'application', payload: 'p' }
    ]
    t.equal(countApplicationsAtOrBelow(atBoundary, 7), 1)
    t.equal(countApplicationsAtOrBelow(atBoundary, 6), 0)
})

test('countApplicationsAtOrBelow - returns 0 for an empty log', (t) => {
    t.equal(countApplicationsAtOrBelow([], 10), 0)
})

test('countApplicationsAtOrBelow - returns 0 for a cursor of 0', (t) => {
    // seq starts at 1, so nothing is ever at or below 0.
    t.equal(countApplicationsAtOrBelow(mixedLog, 0), 0)
})

// A log holding nothing but protocol traffic must count 0, not "some".
// Without this, a filter that ignored `kind` entirely would still pass
// every case above that happens to have an application in range.
test('countApplicationsAtOrBelow - counts 0 in a log of no applications',
    (t) => {
        const protocolOnly:LogEntry[] = [
            { seq: 1, sender: 'a', kind: 'commit', payload: 'p1' },
            { seq: 2, sender: 'a', kind: 'proposal', payload: 'p2' }
        ]
        t.equal(countApplicationsAtOrBelow(protocolOnly, 2), 0)
    })

// mayWriteLog tests. This is the rule settling carry-forward finding 2b:
// the log is writable by the room's members, not by anyone who managed to
// open a socket and say hello.
test('mayWriteLog - an admitted identity may write', (t) => {
    t.ok(mayWriteLog('B', false, ['B'], []))
})

test('mayWriteLog - a stranger may not write', (t) => {
    t.ok(!mayWriteLog('X', false, ['B'], []))
})

test('mayWriteLog - an empty ledger admits nobody but the creator', (t) => {
    t.ok(!mayWriteLog('B', false, [], []))
    t.ok(mayWriteLog('A', true, [], []))
})

// The creator is never in the ledger -- they do not approve themselves --
// so a rule that only consulted `admitted` would lock the one identity
// that has to be able to commit out of its own room.
test('mayWriteLog - the creator may write while absent from the ledger',
    (t) => {
        t.ok(mayWriteLog('A', true, ['B'], ['C']))
    })

// Removal wins over admission, matching classifyStanding and the roster's
// `known` set. A removed member keeps its `admitted` row, so a rule that
// checked admission first would leave them writing forever.
test('mayWriteLog - a removed identity may not write', (t) => {
    t.ok(!mayWriteLog('B', false, ['B'], ['B']))
})

// Re-approval clears the removed row, so standing follows the ledger
// rather than being one-way.
test('mayWriteLog - a re-approved identity may write again', (t) => {
    t.ok(mayWriteLog('B', false, ['B'], []))
})

// isCreator comes from the socket attachment, which is set only after the
// token comparison at hello. Deciding on it alone here is the whole point:
// the room already did the work of proving it.
test('mayWriteLog - a removed identity holding the creator flag may write',
    (t) => {
        t.ok(mayWriteLog('A', true, [], ['A']))
    })

// classifyJoinRequest tests
//
// The three limits exist for one reason -- a stranger needs no standing
// at all to reach this handler -- but they fail differently, so each has
// its own reason string rather than a shared "refused".

test('classifyJoinRequest - an ordinary first request is allowed', (t) => {
    t.equal(classifyJoinRequest({
        keyPackageLength: 400,
        pendingCount: 0,
        alreadyPending: false,
        lastRequestAt: null,
        now: 1000
    }), 'ok')
})

test('classifyJoinRequest - a key package at the ceiling is allowed', (t) => {
    t.equal(classifyJoinRequest({
        keyPackageLength: MAX_KEY_PACKAGE_LENGTH,
        pendingCount: 0,
        alreadyPending: false,
        lastRequestAt: null,
        now: 1000
    }), 'ok')
})

test('classifyJoinRequest - one character over the ceiling is refused',
    (t) => {
        t.equal(classifyJoinRequest({
            keyPackageLength: MAX_KEY_PACKAGE_LENGTH + 1,
            pendingCount: 0,
            alreadyPending: false,
            lastRequestAt: null,
            now: 1000
        }), 'key-package-too-large')
    })

// Size is named ahead of the other two because it is the one refusal
// that waiting will never resolve.
test('classifyJoinRequest - size outranks the other limits', (t) => {
    t.equal(classifyJoinRequest({
        keyPackageLength: MAX_KEY_PACKAGE_LENGTH + 1,
        pendingCount: MAX_PENDING_REQUESTS,
        alreadyPending: false,
        lastRequestAt: 1000,
        now: 1000
    }), 'key-package-too-large')
})

test('classifyJoinRequest - a second request within the interval is refused',
    (t) => {
        t.equal(classifyJoinRequest({
            keyPackageLength: 400,
            pendingCount: 0,
            alreadyPending: false,
            lastRequestAt: 1000,
            now: 1000 + JOIN_REQUEST_INTERVAL_MS - 1
        }), 'rate-limited')
    })

test('classifyJoinRequest - a request at the interval is allowed', (t) => {
    t.equal(classifyJoinRequest({
        keyPackageLength: 400,
        pendingCount: 0,
        alreadyPending: false,
        lastRequestAt: 1000,
        now: 1000 + JOIN_REQUEST_INTERVAL_MS
    }), 'ok')
})

// Clocks are not guaranteed monotonic across a hibernation, and a
// timestamp from the future would otherwise lock a socket out until it
// caught up. Treated as no prior request rather than as an infinite wait.
test('classifyJoinRequest - a last-request time in the future is ignored',
    (t) => {
        t.equal(classifyJoinRequest({
            keyPackageLength: 400,
            pendingCount: 0,
            alreadyPending: false,
            lastRequestAt: 9000,
            now: 1000
        }), 'ok')
    })

test('classifyJoinRequest - the request that fills the queue is allowed',
    (t) => {
        t.equal(classifyJoinRequest({
            keyPackageLength: 400,
            pendingCount: MAX_PENDING_REQUESTS - 1,
            alreadyPending: false,
            lastRequestAt: null,
            now: 1000
        }), 'ok')
    })

test('classifyJoinRequest - a new identity past the cap is refused', (t) => {
    t.equal(classifyJoinRequest({
        keyPackageLength: 400,
        pendingCount: MAX_PENDING_REQUESTS,
        alreadyPending: false,
        lastRequestAt: null,
        now: 1000
    }), 'too-many-pending')
})

// The cap counts distinct rows, and a repeat request replaces its own
// row rather than adding one. Refusing it would strand a requester whose
// key package changed behind a queue they are already in.
test('classifyJoinRequest - an identity already queued may still update',
    (t) => {
        t.equal(classifyJoinRequest({
            keyPackageLength: 400,
            pendingCount: MAX_PENDING_REQUESTS,
            alreadyPending: true,
            lastRequestAt: null,
            now: 1000
        }), 'ok')
    })

// The flood this closes: distinct random identities, each a new row. The
// queue stops growing at the cap and every later request writes nothing.
test('classifyJoinRequest - a flood of fresh identities stops at the cap',
    (t) => {
        const queued = new Set<string>()
        let refused = 0
        let now = 0

        for (let i = 0; i < MAX_PENDING_REQUESTS + 20; i++) {
            now += JOIN_REQUEST_INTERVAL_MS
            const identity = `flood-${i}`
            const verdict = classifyJoinRequest({
                keyPackageLength: 400,
                pendingCount: queued.size,
                alreadyPending: queued.has(identity),
                lastRequestAt: null,
                now
            })
            if (verdict === 'ok') {
                queued.add(identity)
            } else {
                t.equal(verdict, 'too-many-pending')
                refused++
            }
        }

        t.equal(queued.size, MAX_PENDING_REQUESTS)
        t.equal(refused, 20)
    })

// securityHeaders tests

/** The CSP as a map of directive name to its source list. */
function directives (csp:string):Record<string, string[]> {
    const out:Record<string, string[]> = {}
    for (const part of csp.split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/)
        if (name) out[name] = sources
    }
    return out
}

test('securityHeaders - names the three headers', (t) => {
    const headers = securityHeaders('https://demo.example')
    t.ok(headers['Content-Security-Policy'], 'has a CSP')
    t.equal(headers['X-Frame-Options'], 'DENY')
    t.equal(headers['X-Content-Type-Options'], 'nosniff')
})

test('securityHeaders - default-src is none, own scripts and styles',
    (t) => {
        const d = directives(
            securityHeaders('https://demo.example')['Content-Security-Policy']
        )
        t.deepEqual(d['default-src'], ["'none'"])
        t.deepEqual(d['script-src'], ["'self'"])
        t.deepEqual(d['style-src'], ["'self'"])
        t.deepEqual(d['frame-ancestors'], ["'none'"])
    })

test('securityHeaders - connect-src carries the socket origin', (t) => {
    const secure = directives(
        securityHeaders('https://demo.example')['Content-Security-Policy']
    )
    t.deepEqual(secure['connect-src'], ["'self'", 'wss://demo.example'])

    const plain = directives(
        securityHeaders('http://localhost:8787')['Content-Security-Policy']
    )
    t.deepEqual(plain['connect-src'], ["'self'", 'ws://localhost:8787'])
})

// The point of the policy is that nothing off-origin is reachable, so a
// wildcard or an inline escape hatch anywhere in it defeats it.
test('securityHeaders - no wildcard and no inline escape hatch', (t) => {
    const csp = securityHeaders('https://demo.example')['Content-Security-Policy']
    t.equal(csp.includes('*'), false, 'no wildcard source')
    t.equal(csp.includes('unsafe-inline'), false, 'no unsafe-inline')
    t.equal(csp.includes('unsafe-eval'), false, 'no unsafe-eval')
    t.equal(csp.includes('http://demo.example'), false, 'no bare http source')
})

test('securityHeaders - a non-http origin falls back to the secure socket',
    (t) => {
        const d = directives(
            securityHeaders('file:///tmp/x')['Content-Security-Policy']
        )
        t.deepEqual(d['connect-src'], ["'self'"])
    })
