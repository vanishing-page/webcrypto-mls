import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl, ClientState } from '../../src/index.js'
import type {
    PersistedSession,
    SessionInput,
    SessionStore
} from '../../example-shared/persistence-storage.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import {
    createSession,
    sessionInputFrom,
    storedRoomIsWanted,
    type Session
} from '../../example-realistic-demo/client/session.js'
import {
    initCiphersuite,
    createUser,
    createOwnGroup
} from '../../example-realistic-demo/client/mls-actions.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

let cs:CiphersuiteImpl
let alice:DemoUser
let aliceGroup:ClientState

test('the session fixtures build', async (t) => {
    cs = await initCiphersuite()
    alice = await createUser('alice', cs)
    aliceGroup = await createOwnGroup(alice, cs)
    t.ok(alice.keyPackage, 'should make a user with a key package')
})

interface FakeStore extends SessionStore {
    saved:SessionInput[]
    clears:number
    deletes:number
    record:PersistedSession|null
}

/**
 * A store that records what it was asked to do. The real one is
 * indexedDB, which the node suite has no business opening -- the
 * decisions being asserted here are all about *when* something is
 * written, not about how it is stored.
 */
function fakeStore (record:PersistedSession|null = null):FakeStore {
    const store:FakeStore = {
        saved: [],
        clears: 0,
        deletes: 0,
        record,
        saveSession (session:SessionInput):Promise<void> {
            store.saved.push(session)
            return Promise.resolve()
        },
        loadSession ():Promise<PersistedSession|null> {
            return Promise.resolve(store.record)
        },
        clearSession ():Promise<void> {
            store.clears = store.clears + 1
            return Promise.resolve()
        },
        deleteDatabase ():Promise<void> {
            store.deletes = store.deletes + 1
            return Promise.resolve()
        }
    }

    return store
}

function harness (record:PersistedSession|null = null):{
    state:RealisticState
    store:FakeStore
    session:Session
} {
    const state = createRealisticState()
    const store = fakeStore(record)
    return { state, store, session: createSession({ state, store }) }
}

test('sessionInputFrom - nothing to write before there is a user', (t) => {
    const state = createRealisticState()
    t.equal(sessionInputFrom(state), null, 'should be null')

    // A name alone is not enough: a record with no key package restores
    // into a client that cannot do anything, and `isRestorableSession`
    // rejects it anyway.
    state.user.value = { name: 'alice' }
    t.equal(
        sessionInputFrom(state),
        null,
        'and still null without a key package'
    )
})

// realistic-demo.AC7.2 -- whatever state exists is what gets written

test('sessionInputFrom - writes whatever state there is', (t) => {
    const state = createRealisticState()
    state.user.value = alice
    state.roomId.value = 'aB3xK9pQ2m'
    state.cursor.value = 12
    state.creatorToken.value = 'token-abc'
    state.group.value = aliceGroup

    const input = sessionInputFrom(state)

    t.equal(input?.name, 'alice', 'the display name')
    t.equal(input?.keyPackage, alice.keyPackage, 'the key package')
    t.equal(input?.privateKeys, alice.privateKeys, 'the private keys')
    t.equal(input?.roomId, 'aB3xK9pQ2m', 'the room id')
    t.equal(input?.cursor, 12, 'the place in the log')
    t.equal(input?.creatorToken, 'token-abc', 'the creator token')
    t.equal(input?.state, aliceGroup, 'and the group state')
})

// realistic-demo.AC7.5 -- a waiting joiner has keys but no group

test('sessionInputFrom - a waiting joiner is written without a group', (t) => {
    const state = createRealisticState()
    state.user.value = alice
    state.roomId.value = 'aB3xK9pQ2m'

    const input = sessionInputFrom(state)

    t.ok(input, 'there is still something to write')
    t.equal(
        input?.state,
        undefined,
        'with no group state, which is what returns them to waiting'
    )
    t.equal(input?.creatorToken, null, 'and no creator token')
})

// realistic-demo.AC7.1 / AC7.2 -- the control works before a user exists

test('setPersist - on with no user writes nothing yet', async (t) => {
    const h = harness()

    await h.session.setPersist(true)

    t.equal(h.state.persist.value, true, 'the preference is remembered')
    t.equal(h.store.saved.length, 0, 'but there is nothing to write')
})

test('setPersist - on with a user writes the session', async (t) => {
    const h = harness()
    h.state.user.value = alice
    h.state.roomId.value = 'aB3xK9pQ2m'

    await h.session.setPersist(true)

    t.equal(h.store.saved.length, 1, 'one record is written')
    t.equal(h.store.saved[0]?.name, 'alice', 'and it is this client\'s')
})

// realistic-demo.AC7.3 -- turning it off deletes what was stored

test('setPersist - off clears the stored session', async (t) => {
    const h = harness()
    h.state.user.value = alice
    await h.session.setPersist(true)

    await h.session.setPersist(false)

    t.equal(h.state.persist.value, false, 'the preference is off')
    t.equal(h.store.clears, 1, 'and the record is deleted')

    // The polarity that matters: a `save` after the toggle went off must
    // write nothing, or the next cursor advance puts it straight back.
    await h.session.save()
    t.equal(
        h.store.saved.length,
        1,
        'and nothing is written again while it is off'
    )
})

// realistic-demo.AC7.6 -- Reset takes one database and says nothing to
// the server

test('reset - deletes this demo\'s database and turns persistence off',
    async (t) => {
        const h = harness()
        h.state.user.value = alice
        await h.session.setPersist(true)

        await h.session.reset()

        t.equal(h.store.deletes, 1, 'the database is deleted')
        t.equal(
            h.state.persist.value,
            false,
            'and persistence is off, so nothing writes it back'
        )
        t.equal(h.store.clears, 0, 'no separate clear is needed')
    })

// realistic-demo.AC7.4 -- reloading restores the group at its epoch

test('restore - a record with group state comes back as a member', (t) => {
    const h = harness()

    h.session.restore({
        name: 'alice',
        keyPackage: alice.keyPackage!,
        privateKeys: alice.privateKeys!,
        roomId: 'aB3xK9pQ2m',
        cursor: 9,
        creatorToken: 'token-abc',
        state: aliceGroup
    })

    t.equal(h.state.persist.value, true, 'persistence is on again')
    t.equal(h.state.user.value?.name, 'alice', 'the user is back')
    t.equal(h.state.roomId.value, 'aB3xK9pQ2m', 'in the room it left')
    t.equal(h.state.cursor.value, 9, 'resuming from the stored cursor')
    t.equal(h.state.creatorToken.value, 'token-abc', 'with its token')
    t.equal(
        String(h.state.group.value?.groupContext.epoch),
        String(aliceGroup.groupContext.epoch),
        'and the group at the epoch it was persisted at'
    )
    t.equal(h.state.view.value, 'room', 'so the page is the room')
})

// A removal is written to storage like anything else: the effect saves
// on every change to `state.group`, and the state a removal commit
// returns is one whose `groupActiveState` says `removedFromGroup`. The
// signal that page reads -- `state.removed` -- is not in the record, so
// restoring the group alone brings the client back as a member of a
// group it is not in: the full room, the member list from the tree it
// held at the removal, and a composer. Worse, the first replayed entry
// past the removal is one it holds no key for, which throws in
// `processEntry` and reads as a fatal commit. `partitionRestorableRecords`
// in the member store already treats a non-active record this way.
test('restore - a record from after a removal comes back removed', (t) => {
    const h = harness()

    h.session.restore({
        name: 'alice',
        keyPackage: alice.keyPackage!,
        privateKeys: alice.privateKeys!,
        roomId: 'aB3xK9pQ2m',
        cursor: 9,
        creatorToken: null,
        state: { ...aliceGroup, groupActiveState: { kind: 'removedFromGroup' } }
    })

    t.equal(
        h.state.removed.value,
        true,
        'the page says what it said before the reload'
    )

    // The other polarity, so neither a hardcoded `true` nor a hardcoded
    // `false` survives: an ordinary member's record must not come back
    // looking removed.
    const still = harness()

    still.session.restore({
        name: 'alice',
        keyPackage: alice.keyPackage!,
        privateKeys: alice.privateKeys!,
        roomId: 'aB3xK9pQ2m',
        cursor: 9,
        creatorToken: null,
        state: aliceGroup
    })

    t.equal(
        still.state.removed.value,
        false,
        'and an active record comes back as the member it is'
    )
})

test('restore - a record with no group comes back to waiting', (t) => {
    const h = harness()

    h.session.restore({
        name: 'alice',
        keyPackage: alice.keyPackage!,
        privateKeys: alice.privateKeys!,
        roomId: 'aB3xK9pQ2m',
        cursor: 0,
        creatorToken: null
    })

    t.equal(h.state.group.value, null, 'there is no group')
    t.equal(
        h.state.user.value?.keyPackage,
        alice.keyPackage,
        'but the key package is back, so the request can be re-published'
    )
    t.equal(h.state.view.value, 'waiting', 'and the page is the waiting view')
})

// The URL wins over the record, and the record is not touched for it.

test('storedRoomIsWanted - the room in the URL wins over the stored one',
    (t) => {
        const stored:PersistedSession = {
            name: 'alice',
            keyPackage: alice.keyPackage!,
            privateKeys: alice.privateKeys!,
            roomId: 'aB3xK9pQ2m',
            cursor: 4,
            creatorToken: null,
            state: aliceGroup
        }

        t.equal(
            storedRoomIsWanted(stored, { kind: 'setup' }),
            true,
            'the bare origin is nobody asking for a room in particular'
        )
        t.equal(
            storedRoomIsWanted(stored, { kind: 'room', roomId: 'aB3xK9pQ2m' }),
            true,
            'and a link to the stored room is the same room'
        )

        // The polarity that matters, and the one a restore that reads
        // `state.roomId` *after* writing the stored id over it can never
        // reach: a group belonging to one room must not be restored onto
        // a page addressed to another.
        t.equal(
            storedRoomIsWanted(stored, { kind: 'room', roomId: 'zZ9yY8xX7w' }),
            false,
            'but a link to a different room is a different ask'
        )

        // An id that cannot name a room is an ask too, and it was
        // indistinguishable from the bare origin while this rule took a
        // room id: both arrive as null. So a mistyped invitation showed
        // the gone view and was then replaced, by this page's own doing,
        // with the room the browser happened to have a session for --
        // rewriting the address bar on the way.
        t.equal(
            storedRoomIsWanted(stored, { kind: 'gone' }),
            false,
            'and an id that cannot be a room is not an ask for the stored one'
        )
    })

test('load - reports what the store holds', async (t) => {
    const empty = harness()
    t.equal(await empty.session.load(), null, 'null when there is none')

    const record:PersistedSession = {
        name: 'alice',
        keyPackage: alice.keyPackage!,
        privateKeys: alice.privateKeys!,
        roomId: 'aB3xK9pQ2m',
        cursor: 3,
        creatorToken: null
    }
    const full = harness(record)
    t.equal(
        await full.session.load(),
        record,
        'and the record when there is one'
    )
})

// "While on, re-save after each change that matters."

test('watch - re-saves when the group, cursor or token changes', async (t) => {
    const h = harness()
    h.state.user.value = alice
    h.state.persist.value = true

    const stop = h.session.watch()

    try {
        // The effect runs once on subscribe.
        await Promise.resolve()
        const initial = h.store.saved.length
        t.ok(initial >= 1, 'the current state is written straight away')

        h.state.cursor.value = 5
        await Promise.resolve()
        t.ok(
            h.store.saved.length > initial,
            'an advanced cursor is written'
        )

        const afterCursor = h.store.saved.length
        h.state.group.value = aliceGroup
        await Promise.resolve()
        t.ok(
            h.store.saved.length > afterCursor,
            'and a new group state is written'
        )

        const afterGroup = h.store.saved.length
        h.state.creatorToken.value = 'token-abc'
        await Promise.resolve()
        t.ok(
            h.store.saved.length > afterGroup,
            'and a creator token that has just arrived'
        )

        t.equal(
            h.store.saved[h.store.saved.length - 1]?.creatorToken,
            'token-abc',
            'the last record written holds the latest values'
        )
    } finally {
        stop()
    }
})

test('watch - writes nothing while persistence is off', async (t) => {
    const h = harness()
    h.state.user.value = alice

    const stop = h.session.watch()

    try {
        h.state.cursor.value = 5
        h.state.group.value = aliceGroup
        await Promise.resolve()

        t.equal(h.store.saved.length, 0, 'nothing is written')

        // The polarity that matters: the same watcher must start writing
        // the moment the toggle goes on, or the control would only work
        // on a page that reloaded.
        h.state.persist.value = true
        await Promise.resolve()
        t.ok(h.store.saved.length > 0, 'and it starts when the toggle does')
    } finally {
        stop()
    }
})

test('watch - stops writing once it is disposed', async (t) => {
    const h = harness()
    h.state.user.value = alice
    h.state.persist.value = true

    const stop = h.session.watch()
    await Promise.resolve()
    const written = h.store.saved.length

    stop()
    h.state.cursor.value = 99
    await Promise.resolve()

    t.equal(h.store.saved.length, written, 'no further writes')
})
