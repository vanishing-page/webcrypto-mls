import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl } from '../../src/index.js'
import type { ClientMessage } from
    '../../example-realistic-demo/protocol.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import { createChat, type Chat } from
    '../../example-realistic-demo/client/chat.js'
import { createGroupLock } from
    '../../example-realistic-demo/client/group-lock.js'
import { deferred, longEnoughToHaveFinished } from './async-helpers.js'
import {
    initCiphersuite,
    createUser,
    createOwnGroup,
    commitAdd,
    joinFromWelcome,
    processEntry
} from '../../example-realistic-demo/client/mls-actions.js'

let cs:CiphersuiteImpl

test('the ciphersuite initialises', async (t) => {
    cs = await initCiphersuite()
    t.ok(cs, 'should return a ciphersuite')
})

interface Harness {
    state:RealisticState
    chat:Chat
    sent:ClientMessage[]
}

/**
 * A client in a group with a socket that either accepts or refuses.
 * `accepts` is the whole of what the delivery client tells the caller --
 * `send` returns a boolean and nothing else.
 */
async function harness (accepts = true):Promise<Harness> {
    const alice = await createUser('alice', cs)
    const state = createRealisticState()

    state.ciphersuite.value = cs
    state.user.value = alice
    state.group.value = await createOwnGroup(alice, cs)

    const sent:ClientMessage[] = []

    return {
        state,
        sent,
        chat: createChat({
            state,
            lock: createGroupLock(),
            send (msg:ClientMessage):boolean {
                if (!accepts) return false
                sent.push(msg)
                return true
            }
        })
    }
}

// realistic-demo.AC6.1 -- a sent message is encrypted to the group

test('chat - a message is encrypted and sent as an application entry',
    async (t) => {
        const h = await harness()
        const before = h.state.group.value

        await h.chat.say('hello everyone')

        t.equal(h.sent.length, 1, 'one message goes to the room')
        t.deepEqual(
            h.sent[0]?.type === 'mls' ? h.sent[0].kind : null,
            'application',
            'declared as an application entry, not a commit'
        )
        t.ok(
            h.sent[0]?.type === 'mls' && h.sent[0].payload.length > 0,
            'carrying a payload'
        )
        t.notEqual(
            h.state.group.value,
            before,
            'and the sender\'s own ratchet has moved on'
        )
    })

test('chat - what was sent is what the group decrypts', async (t) => {
    // The payload is opaque to every assertion above, so this is the one
    // that says it is actually the message: a second member of the same
    // group opens it and gets the text back.
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const added = await commitAdd(
        await createOwnGroup(alice, cs),
        bob.keyPackage!,
        cs
    )

    const state = createRealisticState()
    state.ciphersuite.value = cs
    state.user.value = alice
    state.group.value = added.newState

    const sent:ClientMessage[] = []
    const chat = createChat({
        state,
        lock: createGroupLock(),
        send (msg) {
            sent.push(msg)
            return true
        }
    })

    await chat.say('hello bob')

    const payload = sent[0]?.type === 'mls' ? sent[0].payload : ''
    const bobGroup = await joinFromWelcome(added.welcome, bob, cs)
    const result = await processEntry(bobGroup, payload, cs)

    t.equal(
        result.kind,
        'applicationMessage',
        'the other member sees an application message'
    )
    t.equal(
        result.kind === 'applicationMessage' ?
            new TextDecoder().decode(result.message) :
            null,
        'hello bob',
        'and reads back exactly what was typed'
    )
})

// realistic-demo.AC6.5 -- the plaintext is recorded locally

test('chat - the plaintext is kept, because the echo cannot be read',
    async (t) => {
        const h = await harness()

        await h.chat.say('first')
        await h.chat.say('second')

        t.deepEqual(
            h.state.outbound.value.map(sent => sent.text),
            ['first', 'second'],
            'both plaintexts are kept until the room numbers them'
        )

        // Kept beside its own ciphertext, which is what `apply-entry.ts`
        // matches the echo on. Two sends never share a payload -- each
        // reads a fresh generation -- so a record holding the wrong one
        // would never be matched at all.
        t.deepEqual(
            h.state.outbound.value.map(sent => sent.payload),
            h.sent.map(msg => msg.type === 'mls' ? msg.payload : null),
            'each against the payload that actually went to the room'
        )
        t.equal(
            h.state.draft.value,
            '',
            'and the composer is cleared'
        )
    })

test('chat - a message is trimmed, and an empty one is not sent', async t => {
    const h = await harness()

    await h.chat.say('   spaced   ')
    t.deepEqual(
        h.state.outbound.value.map(sent => sent.text),
        ['spaced'],
        'the surrounding whitespace is not part of the message'
    )

    await h.chat.say('   ')
    await h.chat.say('')
    t.equal(
        h.sent.length,
        1,
        'and nothing at all is sent for an empty message'
    )
})

test('chat - a message the socket refused is reported, not dropped',
    async (t) => {
        const h = await harness(false)
        const before = h.state.group.value

        h.state.draft.value = 'into the void'
        await h.chat.say('into the void')

        t.equal(h.sent.length, 0, 'nothing reached the room')
        t.deepEqual(
            h.state.outbound.value,
            [],
            'so nothing is shown as though it had'
        )
        t.equal(
            h.state.draft.value,
            'into the void',
            'the message is left in the composer to try again'
        )
        t.ok(
            h.state.status.value.toLowerCase().includes('not connected'),
            'and the person is told why'
        )

        // The generation this message used is spent either way. Going
        // back to it would encrypt the next message under the same key
        // and nonce.
        t.notEqual(
            h.state.group.value,
            before,
            'the ratchet still moved, so no generation is ever reused'
        )
    })

// The lock is shared with `apply-entry.ts` and `approvals.ts`, and it has
// to be: all three read `state.group`, await, and write it back. A send
// that went ahead while a commit was being processed would encrypt from
// the state it read before that commit landed, and whichever of the two
// wrote last would throw the other away -- either an epoch this client
// never reaches again, or a spent generation coming back to life to
// encrypt a second plaintext under the same key and nonce.
//
// A chat-only chain does not cover this. It orders sends against each
// other and against nothing else.
test('chat - a send waits for whatever else is holding the group',
    async t => {
        const alice = await createUser('alice', cs)
        const state = createRealisticState()

        state.ciphersuite.value = cs
        state.user.value = alice
        state.group.value = await createOwnGroup(alice, cs)

        const lock = createGroupLock()
        const order:string[] = []
        const sent:ClientMessage[] = []

        const chat = createChat({
            state,
            lock,
            send (msg) {
                order.push('send')
                sent.push(msg)
                return true
            }
        })

        // What an incoming commit looks like from here: something else
        // read the group, is still working, and has not written back yet.
        const holding = deferred()
        const held = lock.run(async () => {
            await holding.promise
            order.push('other')
        })

        const saying = chat.say('while the group is busy')
        await longEnoughToHaveFinished()

        t.deepEqual(order, [], 'nothing is sent while the group is held')
        t.deepEqual(
            state.outbound.value,
            [],
            'and nothing is shown as though it had been'
        )

        holding.resolve()
        await Promise.all([held, saying])

        t.deepEqual(
            order,
            ['other', 'send'],
            'the send happens after the holder finished, not before'
        )
        t.equal(sent.length, 1, 'and it does still happen')
    })

test('chat - two sends never encrypt from the same group state', async t => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const added = await commitAdd(
        await createOwnGroup(alice, cs),
        bob.keyPackage!,
        cs
    )

    const state = createRealisticState()
    state.ciphersuite.value = cs
    state.user.value = alice
    state.group.value = added.newState

    const sent:ClientMessage[] = []
    const chat = createChat({
        state,
        lock: createGroupLock(),
        send (msg) {
            sent.push(msg)
            return true
        }
    })

    // Started together and not awaited in turn. Without the chain inside
    // `createChat` both calls read the same `state.group`, so both
    // encrypt at the same generation -- two plaintexts under one key and
    // nonce -- and the receiver can only ever open one of them.
    await Promise.all([chat.say('one'), chat.say('two')])

    t.equal(sent.length, 2, 'both messages are sent')

    // The assertion that matters: a real member of the group opens both,
    // in order, and reads back both plaintexts. A payload count or a
    // ciphertext comparison would pass against the unchained version.
    let bobGroup = await joinFromWelcome(added.welcome, bob, cs)
    const read:string[] = []

    for (const msg of sent) {
        const payload = msg.type === 'mls' ? msg.payload : ''
        const result = await processEntry(bobGroup, payload, cs)
        if (result.kind !== 'applicationMessage') continue
        bobGroup = result.newState
        read.push(new TextDecoder().decode(result.message))
    }

    t.deepEqual(
        read,
        ['one', 'two'],
        'and the other member reads both, in the order they were said'
    )
})

test('chat - saying something with no group is refused in words', async t => {
    const state = createRealisticState()
    state.ciphersuite.value = cs

    const sent:ClientMessage[] = []
    const chat = createChat({
        state,
        lock: createGroupLock(),
        send (msg) {
            sent.push(msg)
            return true
        }
    })

    await chat.say('hello?')

    t.equal(sent.length, 0, 'nothing is sent')
    t.notEqual(
        state.status.value,
        'Ready',
        'and the status says something happened'
    )
})
