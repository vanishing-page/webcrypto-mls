import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl, ClientState } from '../../src/index.js'
import type { LogEntry } from '../../example-realistic-demo/protocol.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import { createApplyEntry } from
    '../../example-realistic-demo/client/apply-entry.js'
import { createGroupLock, type GroupLock } from
    '../../example-realistic-demo/client/group-lock.js'
import { deferred, longEnoughToHaveFinished } from './async-helpers.js'
import {
    initCiphersuite,
    createUser,
    createOwnGroup,
    identityOf,
    commitAdd,
    commitRemove,
    encryptMessage,
    joinFromWelcome
} from '../../example-realistic-demo/client/mls-actions.js'
import { membersFromTree, leafIndexOf } from
    '../../example-realistic-demo/client/membership.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

let cs:CiphersuiteImpl

test('the ciphersuite initialises', async (t) => {
    cs = await initCiphersuite()
    t.ok(cs, 'should return a ciphersuite')
})

interface Harness {
    state:RealisticState
    apply (entry:LogEntry):Promise<void>
    closes:number

    /**
     * The same lock the page shares between here, `chat.ts` and
     * `approvals.ts`. Exposed so a test can hold it and watch what this
     * module does while it is held.
     */
    lock:GroupLock
}

/**
 * A client already in a group, which is the only state in which an
 * entry means anything. `closes` counts what the delivery client was
 * asked to do, so the socket does not have to exist.
 */
function harness (user:DemoUser, group:ClientState):Harness {
    const state = createRealisticState()

    state.ciphersuite.value = cs
    state.user.value = user
    state.group.value = group

    const h:Harness = {
        state,
        closes: 0,
        lock: createGroupLock(),
        apply: async () => {}
    }

    h.apply = createApplyEntry({
        state,
        lock: h.lock,
        identity: () => identityOf(user.keyPackage!),
        close: () => { h.closes = h.closes + 1 }
    })

    return h
}

function entry (
    sender:string,
    kind:LogEntry['kind'],
    payload:string,
    seq = 1
):LogEntry {
    return { seq, sender, kind, payload }
}

/**
 * Alice's group with Bob in it. Alice's own state has the Add already
 * applied, and Bob's comes from the Welcome, so neither has processed
 * anything through `applyEntry` yet.
 */
async function pair () {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const added = await commitAdd(
        await createOwnGroup(alice, cs),
        bob.keyPackage!,
        cs
    )

    return { alice, bob, added }
}

// Applying an entry is a read of `state.group`, an await, and a write
// back. So is a send in `chat.ts`, and so is a commit in `approvals.ts`.
// Interleaved, one of the two writes is thrown away: either the commit
// this client just applied, leaving it at an epoch nobody else is at, or
// the generation a send just spent, which then encrypts a second
// plaintext under the same key and nonce. Sharing one lock is what makes
// the interleaving impossible.
test('applyEntry - an entry waits for whatever else is holding the group',
    async t => {
        const { alice, bob, added } = await pair()
        const carol = await createUser('carol', cs)
        const h = harness(bob, await joinFromWelcome(added.welcome, bob, cs))

        const next = await commitAdd(added.newState, carol.keyPackage!, cs)
        const before = h.state.group.value

        // Something else read the group and has not written back yet --
        // a send being encrypted, in the page's case.
        const holding = deferred()
        const held = h.lock.run(async () => { await holding.promise })

        const applying = h.apply(
            entry(identityOf(alice.keyPackage!), 'commit', next.commit)
        )

        await longEnoughToHaveFinished()

        t.equal(
            h.state.group.value,
            before,
            'the group is untouched while it is held'
        )
        t.deepEqual(
            h.state.entries.value,
            [],
            'and the entry is not recorded either, so nothing half-happens'
        )

        holding.resolve()
        await Promise.all([held, applying])

        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '2',
            'and once it is released the entry is applied in full'
        )
    })

// realistic-demo.AC5.1 -- a processed commit moves the member list

test('applyEntry - somebody else\'s commit advances the group', async t => {
    const { alice, bob, added } = await pair()
    const carol = await createUser('carol', cs)
    const h = harness(bob, await joinFromWelcome(added.welcome, bob, cs))

    const next = await commitAdd(added.newState, carol.keyPackage!, cs)

    await h.apply(entry(identityOf(alice.keyPackage!), 'commit', next.commit))

    t.equal(
        String(h.state.group.value!.groupContext.epoch),
        '2',
        'the group is at the epoch the committer reached'
    )
    t.deepEqual(
        membersFromTree(h.state.group.value!.ratchetTree)
            .map(member => member.name),
        ['alice', 'bob', 'carol'],
        'and the member list follows the tree'
    )
    t.equal(h.state.removed.value, false, 'nobody was removed')
    t.equal(h.closes, 0, 'and the socket is left open')
})

test('applyEntry - this client\'s own entry is never processed', async t => {
    const { alice, bob, added } = await pair()
    const carol = await createUser('carol', cs)
    const h = harness(alice, added.newState)

    // Alice's own Add commit, which is what the room replays back to her
    // after a reconnect. Processing it would throw: the state it applies
    // to is already past it.
    const next = await commitAdd(added.newState, carol.keyPackage!, cs)
    const before = h.state.group.value

    await h.apply(
        entry(identityOf(alice.keyPackage!), 'commit', next.commit)
    )

    t.equal(
        h.state.group.value,
        before,
        'her own commit leaves her state exactly where it was'
    )

    // The same entry from the sender it actually came from does apply,
    // so this is the identity check and not a dead code path.
    const bobsGroup = await createOwnGroup(bob, cs)
    const h2 = harness(bob, bobsGroup)
    await h2.apply(
        entry(identityOf(bob.keyPackage!), 'commit', next.commit)
    )
    t.equal(
        h2.state.group.value,
        bobsGroup,
        'and the check is on the sender, not on the payload'
    )
})

// realistic-demo.AC5.5 -- being removed is a normal outcome

test('applyEntry - being removed is reported, not thrown', async (t) => {
    const { alice, bob, added } = await pair()
    const h = harness(bob, await joinFromWelcome(added.welcome, bob, cs))

    const leafIndex = leafIndexOf(
        added.newState.ratchetTree,
        identityOf(bob.keyPackage!)
    )
    const { commit } = await commitRemove(added.newState, leafIndex!, cs)

    // No rejection: the queue treats a throw as a failed commit and
    // stops, and this commit did not fail.
    await h.apply(entry(identityOf(alice.keyPackage!), 'commit', commit))

    t.equal(h.state.removed.value, true, 'the client knows it is out')
    t.equal(
        h.state.group.value!.groupActiveState.kind,
        'removedFromGroup',
        'and holds the state that says so'
    )
    t.ok(
        h.state.status.value.toLowerCase().includes('removed'),
        'and says so in plain language'
    )
    t.equal(h.closes, 1, 'the socket is closed rather than reconnecting')
})

// A removal does not empty the queue that carried it. The creator can
// commit again straight afterwards -- admit the next person, remove
// somebody else -- and those entries are already pushed. Handing one to
// a group that has been removed throws, and a throw out of `applyEntry`
// is what the queue reads as a failed commit: it stops and replaces the
// removed page's explanation with an instruction to reload and
// resynchronise, over a removal that worked exactly as it should.
test('applyEntry - a commit after this client was removed is ignored',
    async (t) => {
        const { alice, bob, added } = await pair()
        const carol = await createUser('carol', cs)
        const h = harness(bob, await joinFromWelcome(added.welcome, bob, cs))

        const leafIndex = leafIndexOf(
            added.newState.ratchetTree,
            identityOf(bob.keyPackage!)
        )
        const gone = await commitRemove(added.newState, leafIndex!, cs)
        await h.apply(
            entry(identityOf(alice.keyPackage!), 'commit', gone.commit)
        )

        t.equal(h.state.removed.value, true, 'the client is out')

        const said = h.state.status.value
        const group = h.state.group.value

        // Alice carries on without Bob. Bob holds no key for this.
        const next = await commitAdd(gone.newState, carol.keyPackage!, cs)

        await h.apply(
            entry(identityOf(alice.keyPackage!), 'commit', next.commit, 2)
        )

        t.equal(
            h.state.status.value,
            said,
            'the removal is still what the page says happened'
        )
        t.equal(
            h.state.group.value,
            group,
            'and the state it was removed at is left alone'
        )
    })

test('applyEntry - a commit that will not process is a failure', async t => {
    const { alice, bob, added } = await pair()
    const h = harness(bob, await joinFromWelcome(added.welcome, bob, cs))

    try {
        await h.apply(
            entry(identityOf(alice.keyPackage!), 'commit', 'rubbish!!')
        )
        t.fail('should have rejected')
    } catch (_err) {
        t.ok(true, 'should reject, so the queue can stop')
    }

    t.equal(
        h.state.removed.value,
        false,
        'a payload that will not decode is not a removal'
    )
})

// realistic-demo.AC6.1 -- a message is decrypted and displayed

test('applyEntry - somebody else\'s message is read and recorded', async t => {
    const { alice, bob, added } = await pair()
    const bobGroup = await joinFromWelcome(added.welcome, bob, cs)
    const h = harness(bob, bobGroup)

    const said = await encryptMessage(added.newState, 'hello bob', cs)
    const inbound = entry(
        identityOf(alice.keyPackage!),
        'application',
        said.payload,
        4
    )

    await h.apply(inbound)

    t.deepEqual(
        h.state.entries.value,
        [inbound],
        'the entry is recorded, so the timeline can place it'
    )
    t.deepEqual(
        h.state.decrypted.value,
        { 4: 'hello bob' },
        'and the plaintext is filed against the seq the room gave it'
    )

    // Receiving ratchets the sender's chain forward. Holding the old
    // state would derive the same generation again for Alice's next
    // message.
    t.notEqual(
        h.state.group.value,
        bobGroup,
        'the group state moves with the message that was opened'
    )
    t.equal(
        h.state.removed.value,
        false,
        'and reading a message is not a removal'
    )
})

// realistic-demo.AC6.3 / AC6.4 -- an unreadable entry becomes a
// placeholder, which means it has to be recorded before it is attempted.
//
// A joiner's replay carries everything said before it arrived, encrypted
// at epochs it holds no keys for. The throw is what the entry queue
// reads as "count it and carry on" for an application entry -- see
// `onError` in delivery-client.ts -- and `buildTimeline` turns the
// recorded entry with no plaintext into the placeholder.
test('applyEntry - a message from before the join is kept, unread',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)

        // Alice alone, at epoch 0, saying something. Bob joins at epoch
        // 1 and so never holds a key for it.
        const aliceAlone = await createOwnGroup(alice, cs)
        const said = await encryptMessage(aliceAlone, 'before bob', cs)
        const added = await commitAdd(aliceAlone, bob.keyPackage!, cs)

        const bobGroup = await joinFromWelcome(added.welcome, bob, cs)
        const h = harness(bob, bobGroup)

        const inbound = entry(
            identityOf(alice.keyPackage!),
            'application',
            said.payload,
            2
        )

        try {
            await h.apply(inbound)
            t.fail('should have rejected, so the queue counts it')
        } catch (_err) {
            t.ok(true, 'a message it holds no key for does not decrypt')
        }

        t.deepEqual(
            h.state.entries.value,
            [inbound],
            'but the entry is already recorded, so it becomes a ' +
            'placeholder rather than vanishing'
        )
        t.deepEqual(
            h.state.decrypted.value,
            {},
            'with no plaintext against it'
        )
        t.equal(
            h.state.group.value,
            bobGroup,
            'and the group is left exactly where it was'
        )
        t.equal(
            h.state.removed.value,
            false,
            'an unreadable message is not a removal'
        )
    })

// realistic-demo.AC6.5 -- a client's own past entries on replay

test('applyEntry - this client\'s own message comes from what it sent',
    async (t) => {
        const { alice, added } = await pair()
        const h = harness(alice, added.newState)

        // What `chat.ts` records at send time. The echoed entry carries
        // a payload this client cannot open, so this is the only copy of
        // the plaintext that exists on this page.
        h.state.outbound.value = [
            { payload: 'ciphertext-one', text: 'first' },
            { payload: 'ciphertext-two', text: 'second' }
        ]

        const mine = identityOf(alice.keyPackage!)
        const one = entry(mine, 'application', 'ciphertext-one', 7)
        const two = entry(mine, 'application', 'ciphertext-two', 9)

        // Neither payload decodes. That is the point: an own entry is
        // never handed to `processMessage`, because MLS cannot open a
        // message it produced.
        await h.apply(one)
        await h.apply(two)

        t.deepEqual(
            h.state.decrypted.value,
            { 7: 'first', 9: 'second' },
            'each recorded plaintext lands against its own echo'
        )
        t.deepEqual(
            h.state.entries.value,
            [one, two],
            'and both entries are in the history'
        )
        t.deepEqual(
            h.state.outbound.value,
            [],
            'each one consumed as it is matched'
        )
    })

// The echo is matched on the ciphertext, not on send order. A frame
// handed to an open socket that dies before it flushes is discarded and
// nothing tells the page, so the list can hold a send the room never
// logged. Matching positionally would file that message's text against
// the next echo's seq -- the wrong words under a real message, for the
// rest of the session, and the right ones stuck in flight for ever.
test('applyEntry - a send the room never logged does not misname the next',
    async (t) => {
        const { alice, added } = await pair()
        const h = harness(alice, added.newState)

        h.state.outbound.value = [
            { payload: 'never-arrived', text: 'lost on the way out' },
            { payload: 'did-arrive', text: 'this one landed' }
        ]

        await h.apply(
            entry(identityOf(alice.keyPackage!), 'application', 'did-arrive', 5)
        )

        t.deepEqual(
            h.state.decrypted.value,
            { 5: 'this one landed' },
            'the plaintext filed is the one whose ciphertext came back'
        )
        t.deepEqual(
            h.state.outbound.value.map(sent => sent.text),
            ['lost on the way out'],
            'and only the one that was answered is consumed'
        )
    })

test('applyEntry - an own message with nothing recorded is a placeholder',
    async (t) => {
        const { alice, added } = await pair()
        const h = harness(alice, added.newState)

        // A reload empties the outbound record; nothing persists the
        // plaintexts. The entry still has to be counted.
        const mine = entry(
            identityOf(alice.keyPackage!),
            'application',
            'not-a-message',
            3
        )

        await h.apply(mine)

        t.deepEqual(
            h.state.entries.value,
            [mine],
            'the entry is recorded'
        )
        t.deepEqual(
            h.state.decrypted.value,
            {},
            'with no plaintext, so it renders as a placeholder'
        )
    })

test('applyEntry - a removed client records no more messages', async (t) => {
    const { alice, bob, added } = await pair()
    const h = harness(bob, await joinFromWelcome(added.welcome, bob, cs))

    const leafIndex = leafIndexOf(
        added.newState.ratchetTree,
        identityOf(bob.keyPackage!)
    )
    const gone = await commitRemove(added.newState, leafIndex!, cs)
    await h.apply(entry(identityOf(alice.keyPackage!), 'commit', gone.commit))
    t.equal(h.state.removed.value, true, 'the client is out')

    const said = await encryptMessage(gone.newState, 'after bob', cs)

    // No rejection: a throw here is read as a failed commit, and the
    // page would replace its removal notice with an instruction to
    // reload.
    await h.apply(
        entry(identityOf(alice.keyPackage!), 'application', said.payload, 2)
    )

    t.deepEqual(
        h.state.entries.value,
        [],
        'nothing said after the removal enters this client\'s history'
    )
})

test('applyEntry - an entry arriving before the group is dropped', async t => {
    const { alice, bob, added } = await pair()
    const h = harness(bob, added.newState)
    h.state.group.value = null

    // No throw and no state: this is the Add commit that reaches a
    // joiner before its Welcome does, and the replay re-delivers it.
    await h.apply(
        entry(identityOf(alice.keyPackage!), 'commit', added.commit)
    )

    t.equal(h.state.group.value, null, 'there is still no group')
    t.equal(h.state.removed.value, false, 'and nobody was removed')
})
