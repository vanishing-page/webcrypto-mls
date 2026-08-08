import { test } from '@substrate-system/tapzero'
import {
    buildTimeline,
    type TimelineInput,
    type TimelineItem,
    type TimelinePlaceholder,
    type TimelineText,
} from '../../example-realistic-demo/client/timeline.js'
import { countApplicationsAtOrBelow } from
    '../../example-realistic-demo/room-logic.js'
import type { LogEntry, EntryKind } from
    '../../example-realistic-demo/protocol.js'

const ALICE = 'alice-key'
const BOB = 'bob-key'

const NAMES:Record<string, string> = {
    [ALICE]: 'Alice',
    [BOB]: 'Bob'
}

function entry (
    seq:number,
    sender = ALICE,
    kind:EntryKind = 'application'
):LogEntry {
    return { seq, sender, kind, payload: `payload-${seq}` }
}

function input (over:Partial<TimelineInput> = {}):TimelineInput {
    return {
        entries: [],
        decrypted: {},
        names: NAMES,
        joinCursor: 0,
        priorCount: 0,
        ...over
    }
}

/**
 * A missing item reads as an empty object rather than throwing, so a
 * fold that returns too few items fails the assertion that names the
 * behaviour instead of aborting the whole file.
 */
interface AnyItem {
    kind?:TimelineItem['kind']
    seq?:number
    from?:string
    text?:string
    count?:number
    reason?:TimelinePlaceholder['reason']
}

function at (items:TimelineItem[], i:number):AnyItem {
    return (items[i] ?? {}) as AnyItem
}

function texts (items:TimelineItem[]):TimelineText[] {
    return items.filter((item):item is TimelineText => {
        return item.kind === 'text'
    })
}

function placeholders (items:TimelineItem[]):TimelinePlaceholder[] {
    return items.filter((item):item is TimelinePlaceholder => {
        return item.kind === 'placeholder'
    })
}

function mark (items:TimelineItem[], i:number):AnyItem {
    return (placeholders(items)[i] ?? {}) as AnyItem
}

// realistic-demo.AC6.3 -- one leading placeholder, counted

test('buildTimeline - pre-join entries are one counted placeholder', t => {
    const items = buildTimeline(input({
        entries: [entry(6), entry(7)],
        decrypted: { 6: 'hello', 7: 'there' },
        joinCursor: 5,
        priorCount: 12
    }))

    t.equal(at(items, 0).kind, 'placeholder', 'the first item is a mark')
    t.equal(at(items, 0).count, 12, 'it counts twelve')
    t.equal(at(items, 0).reason, 'before-join', 'and says why')
    t.equal(
        placeholders(items).length,
        1,
        'twelve prior messages make one item, not twelve'
    )
    t.equal(texts(items).length, 2, 'both post-join messages are shown')
})

test('buildTimeline - no entry at or below the cursor makes an item', t => {
    const items = buildTimeline(input({
        entries: [entry(1), entry(2), entry(3), entry(4), entry(5), entry(6)],
        decrypted: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f' },
        joinCursor: 5,
        priorCount: 5
    }))

    // Every one of seqs 1..5 is decryptable in this fixture, so a fold
    // that forgot the cursor would render five extra rows of text.
    t.equal(texts(items).length, 1, 'only the entry above the cursor shows')
    t.equal(texts(items)[0]?.seq, 6, 'and it is seq 6')
    t.equal(placeholders(items).length, 1, 'one placeholder for the rest')
    t.equal(items.length, 2, 'nothing else is rendered')
})

test('buildTimeline - the placeholder count is priorCount, not a ' +
    'local count', t => {
    // The client was never sent the pre-join entries at all, which is
    // the ordinary case: the room counted them, this client cannot.
    const items = buildTimeline(input({
        entries: [entry(9)],
        decrypted: { 9: 'hi' },
        joinCursor: 8,
        priorCount: 3
    }))

    t.equal(mark(items, 0).count, 3, 'the room\'s count is used')
})

test('buildTimeline - the count agrees with countApplicationsAtOrBelow', t => {
    // The pairing the room relies on: whatever the room counts is what
    // the placeholder says, exactly.
    const log = [
        entry(1),
        entry(2, ALICE, 'commit'),
        entry(3),
        entry(4, ALICE, 'proposal'),
        entry(5),
        entry(6)
    ]
    const cursor = 5
    const priorCount = countApplicationsAtOrBelow(log, cursor)

    t.equal(priorCount, 3, 'three application entries at or below seq 5')

    const items = buildTimeline(input({
        entries: log,
        decrypted: { 6: 'later' },
        joinCursor: cursor,
        priorCount
    }))

    t.equal(mark(items, 0).count, 3, 'the placeholder says three')
})

// realistic-demo.AC6.6 -- the epoch zero edge, and the empty boundary

test('buildTimeline - joining at the start gives no leading mark', t => {
    const items = buildTimeline(input({
        entries: [entry(1), entry(2)],
        decrypted: { 1: 'a', 2: 'b' },
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(placeholders(items).length, 0, 'nothing came before')
    t.equal(items.length, 2, 'just the two messages')
})

test('buildTimeline - joinCursor 0 wins over a nonzero priorCount', t => {
    // A priorCount that disagrees with a zero cursor is incoherent; the
    // cursor is the authority, and a "0 earlier messages" row would be
    // noise either way.
    const items = buildTimeline(input({
        entries: [entry(1)],
        decrypted: { 1: 'a' },
        joinCursor: 0,
        priorCount: 7
    }))

    t.equal(placeholders(items).length, 0, 'still no leading placeholder')
})

test('buildTimeline - a cursor above zero with nothing before it', t => {
    // Joining after commits only: entries preceded the join, but none
    // of them were messages, so there is nothing to say.
    const items = buildTimeline(input({
        entries: [entry(4)],
        decrypted: { 4: 'first words' },
        joinCursor: 3,
        priorCount: 0
    }))

    t.equal(placeholders(items).length, 0, 'no "0 earlier messages" row')
    t.equal(items.length, 1, 'only the message')
})

test('buildTimeline - the leading placeholder appears at priorCount 1', t => {
    const items = buildTimeline(input({
        entries: [entry(4)],
        decrypted: { 4: 'first words' },
        joinCursor: 3,
        priorCount: 1
    }))

    t.equal(placeholders(items).length, 1, 'one prior message is a row')
    t.equal(mark(items, 0).count, 1, 'and it counts one')
})

test('buildTimeline - empty entries and cursor 0 give an empty list', t => {
    t.equal(buildTimeline(input()).length, 0, 'nothing in, nothing out')
})

// realistic-demo.AC6.4 -- runs of undecryptable entries collapse

test('buildTimeline - three misses in a row are one counted mark', t => {
    const items = buildTimeline(input({
        entries: [entry(1), entry(2), entry(3)],
        decrypted: {},
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(items.length, 1, 'three misses, one row')
    t.equal(mark(items, 0).count, 3, 'counting all three')
    t.equal(
        mark(items, 0).reason,
        'undecryptable',
        'for the keys, not for the join'
    )
    t.equal(mark(items, 0).seq, 3, 'positioned at the highest seq')
})

test('buildTimeline - a readable message breaks the run', t => {
    const items = buildTimeline(input({
        entries: [entry(1), entry(2), entry(3), entry(4)],
        decrypted: { 2: 'readable', 3: 'also readable' },
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(items.length, 4, 'placeholder, text, text, placeholder')
    t.equal(at(items, 0).kind, 'placeholder', 'the first miss')
    t.equal(at(items, 0).count, 1, 'counting one')
    t.equal(at(items, 1).kind, 'text', 'then a message')
    t.equal(at(items, 2).kind, 'text', 'then another')
    t.equal(at(items, 3).kind, 'placeholder', 'then the second run')
    t.equal(at(items, 3).count, 1, 'the second run counts one, not two')
})

test('buildTimeline - two separate runs keep separate counts', t => {
    const items = buildTimeline(input({
        entries: [
            entry(1), entry(2),
            entry(3),
            entry(4), entry(5), entry(6)
        ],
        decrypted: { 3: 'in between' },
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(placeholders(items).length, 2, 'two runs')
    t.equal(mark(items, 0).count, 2, 'the first counts two')
    t.equal(mark(items, 1).count, 3, 'the second counts three')
    t.equal(mark(items, 0).seq, 2, 'each sits at the top of its own run')
    t.equal(mark(items, 1).seq, 6, 'and the second at seq 6')
})

test('buildTimeline - a leading mark does not absorb a later miss', t => {
    // The before-join item is a different kind of thing; an
    // undecryptable entry after the join must not be counted into it.
    const items = buildTimeline(input({
        entries: [entry(6)],
        decrypted: {},
        joinCursor: 5,
        priorCount: 4
    }))

    t.equal(placeholders(items).length, 2, 'two marks, two different reasons')
    t.equal(mark(items, 0).reason, 'before-join', 'the join one first')
    t.equal(mark(items, 0).count, 4, 'still counting four')
    t.equal(mark(items, 1).reason, 'undecryptable', 'then the miss')
    t.equal(mark(items, 1).count, 1, 'counting one')
})

// realistic-demo.AC6.5 -- a client's own past entries render as text

test('buildTimeline - an own entry with recorded plaintext is text', t => {
    const items = buildTimeline(input({
        entries: [entry(1, ALICE), entry(2, BOB)],
        // Alice's own message is here because she recorded it when she
        // sent it, not because she decrypted it on replay.
        decrypted: { 1: 'what I said' },
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(at(items, 0).kind, 'text', 'the own entry is a message')
    t.equal(at(items, 0).text, 'what I said', 'with its words')
    t.equal(at(items, 0).from, 'Alice', 'attributed by name')
    t.equal(at(items, 1).kind, 'placeholder', 'the other is still a miss')
})

test('buildTimeline - an unknown sender is named, not dropped', t => {
    const items = buildTimeline(input({
        entries: [entry(1, 'a-stranger')],
        decrypted: { 1: 'hello' },
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(items.length, 1, 'the message is still shown')
    t.equal(at(items, 0).from, 'unknown', 'with a stand-in name')
})

// Ordering, and entries that were never readable by anyone

test('buildTimeline - items come out in ascending seq', t => {
    const items = buildTimeline(input({
        entries: [entry(6), entry(7), entry(8), entry(9)],
        decrypted: { 6: 'a', 8: 'b' },
        joinCursor: 5,
        priorCount: 2
    }))

    t.deepEqual(
        items.map(item => item.seq),
        [5, 6, 7, 8, 9],
        'ascending, placeholder first'
    )
    t.equal(at(items, 0).kind, 'placeholder', 'the first item is the mark')
})

test('buildTimeline - commits and proposals produce no items', t => {
    const items = buildTimeline(input({
        entries: [
            entry(1, ALICE, 'commit'),
            entry(2, BOB, 'proposal'),
            entry(3, ALICE, 'commit')
        ],
        decrypted: {},
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(items.length, 0, 'nothing a person could have read')
})

test('buildTimeline - a commit does not break a run of misses', t => {
    const items = buildTimeline(input({
        entries: [entry(1), entry(2, ALICE, 'commit'), entry(3)],
        decrypted: {},
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(items.length, 1, 'one run, not two')
    t.equal(mark(items, 0).count, 2, 'counting the two messages only')
})

test('buildTimeline - a decryptable commit is still not a message', t => {
    // A stray plaintext recorded against a commit's seq must not turn
    // the commit into a chat row.
    const items = buildTimeline(input({
        entries: [entry(1, ALICE, 'commit')],
        decrypted: { 1: 'not a message' },
        joinCursor: 0,
        priorCount: 0
    }))

    t.equal(items.length, 0, 'the commit is still invisible')
})

test('buildTimeline - the input is not mutated', t => {
    const entries = [entry(1), entry(2)]
    const decrypted = { 1: 'a' }
    const before = JSON.stringify({ entries, decrypted })

    buildTimeline(input({ entries, decrypted }))

    t.equal(
        JSON.stringify({ entries, decrypted }),
        before,
        'the fold reads its input and writes none of it'
    )
})
