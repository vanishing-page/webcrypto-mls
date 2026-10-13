import { test } from '@substrate-system/tapzero'
import {
    MAX_PAYLOAD_LENGTH,
    type ClientMessage,
    type LogEntry
} from '../../example-realistic-demo/protocol.js'
import {
    createPendingCommits,
    outcomeOf,
    type PendingCommit
} from '../../example-realistic-demo/client/pending-commit.js'

const SELF = 'creator-key'
const PENDING:PendingCommit = { payload: 'commit-bytes', ref: 'c1' }

function entry (sender:string, payload:string):LogEntry {
    return { seq: 7, sender, kind: 'commit', payload }
}

// outcomeOf -- the matching rule on its own

test('pending-commit - its own echo settles it as accepted', (t) => {
    t.deepEqual(
        outcomeOf(PENDING, SELF, {
            type: 'entry',
            entry: entry(SELF, PENDING.payload)
        }),
        { status: 'accepted' }
    )
})

test('pending-commit - an own entry with another payload settles nothing',
    (t) => {
        t.equal(
            outcomeOf(PENDING, SELF, {
                type: 'entry',
                entry: entry(SELF, 'a-chat-message')
            }),
            null
        )
    })

test('pending-commit - the same payload from someone else settles nothing',
    (t) => {
        t.equal(
            outcomeOf(PENDING, SELF, {
                type: 'entry',
                entry: entry('somebody-else', PENDING.payload)
            }),
            null
        )
    })

test('pending-commit - no identity yet means no echo is ours', (t) => {
    t.equal(
        outcomeOf(PENDING, null, {
            type: 'entry',
            entry: entry(SELF, PENDING.payload)
        }),
        null
    )
})

test('pending-commit - an error with its ref settles it as refused',
    (t) => {
        t.deepEqual(
            outcomeOf(PENDING, SELF, {
                type: 'error',
                reason: 'log-full',
                ref: PENDING.ref
            }),
            { status: 'refused', reason: 'log-full' }
        )
    })

test('pending-commit - an error with another ref or none settles nothing',
    (t) => {
        t.equal(
            outcomeOf(PENDING, SELF, {
                type: 'error',
                reason: 'rate-limited',
                ref: 'c2'
            }),
            null,
            'another write was refused, not this one'
        )
        t.equal(
            outcomeOf(PENDING, SELF, { type: 'error', reason: 'not-member' }),
            null,
            'an untagged refusal is about something else'
        )
    })

// createPendingCommits -- the one pending commit, and its promise

function tracker (open = true) {
    const sent:ClientMessage[] = []
    const commits = createPendingCommits({
        identity: () => SELF,
        send (msg) {
            if (!open) return false
            sent.push(msg)
            return true
        }
    })
    return { sent, commits }
}

test('pending-commit - submit sends the commit with a ref', (t) => {
    const { sent, commits } = tracker()
    commits.submit('abc')

    t.equal(sent.length, 1, 'one frame')
    const [frame] = sent
    t.ok(
        frame.type === 'mls' &&
        frame.kind === 'commit' &&
        frame.payload === 'abc' &&
        typeof frame.ref === 'string' &&
        frame.ref.length > 0,
        'an mls commit carrying the payload and a ref'
    )
})

test('pending-commit - the echo resolves the submission', async (t) => {
    const { commits } = tracker()
    const outcome = commits.submit('abc')

    commits.observe({ type: 'entry', entry: entry('other', 'abc') })
    commits.observe({ type: 'entry', entry: entry(SELF, 'abc') })

    t.deepEqual(await outcome, { status: 'accepted' })
})

test('pending-commit - a refusal with its ref resolves the submission',
    async (t) => {
        const { sent, commits } = tracker()
        const outcome = commits.submit('abc')
        const [frame] = sent
        const ref = frame.type === 'mls' ? frame.ref : undefined

        commits.observe({ type: 'error', reason: 'rate-limited' })
        commits.observe({ type: 'error', reason: 'log-full', ref })

        t.deepEqual(await outcome, { status: 'refused', reason: 'log-full' })
    })

test('pending-commit - each submission gets its own ref', async (t) => {
    const { sent, commits } = tracker()
    const first = commits.submit('one')
    commits.observe({ type: 'entry', entry: entry(SELF, 'one') })
    await first
    commits.submit('two')

    const refs = sent.map(msg => msg.type === 'mls' ? msg.ref : null)
    t.notEqual(refs[0], refs[1], 'a stale refusal cannot settle the next')
})

test('pending-commit - a closed socket is refused without waiting',
    async (t) => {
        const { sent, commits } = tracker(false)

        t.deepEqual(
            await commits.submit('abc'),
            { status: 'refused', reason: 'closed' }
        )
        t.equal(sent.length, 0, 'nothing went out')
    })

test('pending-commit - a second submission while one is pending throws',
    async (t) => {
        const { commits } = tracker()
        commits.submit('one')

        try {
            await commits.submit('two')
            t.fail('should have thrown')
        } catch (_err) {
            t.ok(true, 'only one commit is ever pending')
        }
    })

// A dropped socket -- the replay after reconnect is the authority

test('pending-commit - a replay with no own echo settles it as lost',
    async (t) => {
        const { commits } = tracker()
        const outcome = commits.submit('abc')

        commits.observe({ type: 'reconnected' })
        t.ok(commits.awaitsReplay(), 'it waits for the replay')
        commits.observe({ type: 'entry', entry: entry('other', 'xyz') })
        commits.observe({ type: 'replay-end' })

        t.deepEqual(await outcome, { status: 'refused', reason: 'lost' })
        t.ok(!commits.awaitsReplay(), 'and waits for nothing after')
    })

test('pending-commit - an echo on an earlier page settles it as accepted',
    async (t) => {
        const { commits } = tracker()
        const outcome = commits.submit('abc')

        commits.observe({ type: 'reconnected' })
        // The first page carries the echo; the last one does not.
        commits.observe({ type: 'entry', entry: entry(SELF, 'abc') })
        commits.observe({ type: 'entry', entry: entry('other', 'xyz') })
        commits.observe({ type: 'replay-end' })

        t.deepEqual(await outcome, { status: 'accepted' })
    })

test('pending-commit - the end of a replay on a live socket settles nothing',
    async (t) => {
        const { commits } = tracker()
        const outcome = commits.submit('abc')

        // A paged replay still running when the commit went out ends
        // without it: the room answered that page before the write.
        commits.observe({ type: 'replay-end' })
        t.ok(!commits.awaitsReplay(), 'no drop, so no replay to wait on')
        commits.observe({ type: 'entry', entry: entry(SELF, 'abc') })

        t.deepEqual(await outcome, { status: 'accepted' })
    })

test('pending-commit - a reconnect with nothing pending waits for nothing',
    (t) => {
        const { commits } = tracker()
        commits.observe({ type: 'reconnected' })
        t.ok(!commits.awaitsReplay(), 'there is no commit to settle')
    })

// Answers that carry no `ref` but can still only be about the commit

test('pending-commit - a vanished room settles it as refused',
    async (t) => {
        const { commits } = tracker()
        const outcome = commits.submit('abc')

        commits.observe({ type: 'no-room' })

        t.deepEqual(await outcome, { status: 'refused', reason: 'no-room' })
        t.ok(!commits.awaitsReplay(), 'and waits for nothing after')
    })

test('pending-commit - a frame the room cannot parse is never sent',
    async (t) => {
        const { sent, commits } = tracker()

        // The room answers an oversized frame with a bare `bad-message`
        // -- it never parsed the frame, so it has no `ref` to echo.
        const outcome = await commits.submit(
            'a'.repeat(MAX_PAYLOAD_LENGTH + 1)
        )

        t.deepEqual(outcome, { status: 'refused', reason: 'bad-message' })
        t.equal(sent.length, 0, 'nothing went out')

        const next = commits.submit('abc')
        t.equal(sent.length, 1, 'and nothing is left pending')
        commits.observe({ type: 'entry', entry: entry(SELF, 'abc') })
        t.deepEqual(await next, { status: 'accepted' })
    })
