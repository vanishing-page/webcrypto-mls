import { test } from '@substrate-system/tapzero'
import {
    selectMessageView,
    messageRowKey,
    type PersonMessageView
} from '../../example/message-view.js'
import { DEVICES, clientId } from '../../example/devices.js'
import type { DemoMessage, DemoMessageQueue } from '../../example/demo-state.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

// The users map for a group where every named client holds a leaf, plus
// any `created` ids that exist on paper only. `state` and `keyPackage`
// are read for truthiness alone, so stubs are enough.
function usersWith (inGroup:string[], created:string[] = []) {
    const users = new Map<string, DemoUser>()

    for (const id of [...inGroup, ...created]) {
        users.set(id, {
            name: id,
            keyPackage: {} as DemoUser['keyPackage'],
            state: inGroup.includes(id) ?
                ({} as DemoUser['state']) :
                undefined
        })
    }

    return users
}

function messageFrom (from:string):DemoMessage {
    return {
        from,
        text: 'hello',
        ciphertext: new Uint8Array([1, 2, 3]),
        epoch: 3n,
        timestamp: 0
    }
}

// One queue entry per client id given, all for message 0.
function queuesFor (ids:string[]):Record<string, DemoMessageQueue> {
    const queues:Record<string, DemoMessageQueue> = {}
    for (const id of ids) {
        queues[id] = [{
            messageIndex: 0,
            ciphertext: new Uint8Array([1, 2, 3]),
            epoch: 3n
        }]
    }
    return queues
}

function deviceOf (
    person:string,
    view:PersonMessageView[],
    deviceId:string
) {
    const row = view.find(entry => entry.person === person)
    return row?.devices.find(d => d.device.id === deviceId)
}

test('the sending device is already decrypted, its siblings are not', (t) => {
    const sender = clientId('Alice', 'laptop')
    const view = selectMessageView({
        users: usersWith([
            clientId('Alice', 'phone'),
            sender,
            clientId('Alice', 'desktop')
        ]),
        queues: queuesFor([
            clientId('Alice', 'phone'),
            clientId('Alice', 'desktop')
        ]),
        decrypted: {},
        message: messageFrom(sender),
        messageIndex: 0
    })

    const alice = view.find(entry => entry.person === 'Alice')
    t.ok(alice, 'Alice has a row')
    t.equal(alice!.devices.length, DEVICES.length, 'one entry per device')
    t.equal(alice!.holdsMessage, true, 'the message reached her devices')

    const laptop = deviceOf('Alice', view, 'laptop')
    t.equal(laptop!.isSender, true, 'the laptop composed the plaintext')
    t.equal(
        laptop!.decrypted,
        true,
        'the sending device never has to decrypt its own message'
    )

    const phone = deviceOf('Alice', view, 'phone')
    t.equal(phone!.isSender, false, 'the phone did not send it')
    t.equal(
        phone!.decrypted,
        false,
        'the sender\'s other devices decrypt like anyone else'
    )
    t.equal(phone!.queued, true, 'the phone holds the ciphertext')
})

test('another person\'s devices report their own decrypt state', (t) => {
    const view = selectMessageView({
        users: usersWith([
            clientId('Alice', 'phone'),
            clientId('Bob', 'phone'),
            clientId('Bob', 'laptop')
        ]),
        queues: queuesFor([clientId('Bob', 'phone')]),
        decrypted: { [clientId('Bob', 'laptop')]: { 0: 'hello' } },
        message: messageFrom(clientId('Alice', 'phone')),
        messageIndex: 0
    })

    t.deepEqual(
        view.map(entry => entry.person),
        ['Alice', 'Bob'],
        'one row per person, in EXAMPLE_USERS order'
    )

    const bob = view.find(entry => entry.person === 'Bob')
    t.equal(bob!.holdsMessage, true, 'one decrypted device is enough')

    const laptop = deviceOf('Bob', view, 'laptop')
    t.equal(laptop!.decrypted, true, 'the laptop has read it')
    t.equal(laptop!.text, 'hello', 'the plaintext comes back with the row')
    t.equal(laptop!.isSender, false, 'Bob sent nothing')

    const phone = deviceOf('Bob', view, 'phone')
    t.equal(phone!.decrypted, false, 'the phone has not read it yet')
    t.equal(phone!.text, null, 'no plaintext until it decrypts')
    t.equal(phone!.queued, true, 'but it is holding the ciphertext')
})

test('a device outside the group is reported as such', (t) => {
    const view = selectMessageView({
        users: usersWith(
            [clientId('Alice', 'phone'), clientId('Bob', 'phone')],
            [clientId('Bob', 'laptop')]
        ),
        queues: queuesFor([clientId('Bob', 'phone')]),
        decrypted: {},
        message: messageFrom(clientId('Alice', 'phone')),
        messageIndex: 0
    })

    const laptop = deviceOf('Bob', view, 'laptop')
    t.equal(laptop!.inGroup, false, 'a created device that never joined')
    t.equal(laptop!.queued, false, 'so nothing was ever queued for it')
    t.equal(laptop!.decrypted, false, 'and it can never read the message')

    const desktop = deviceOf('Bob', view, 'desktop')
    t.equal(
        desktop!.inGroup,
        false,
        'a device that does not exist at all is listed too'
    )

    const phone = deviceOf('Bob', view, 'phone')
    t.equal(phone!.inGroup, true, 'the phone holds a leaf')
})

test('a user that the message never reached', (t) => {
    const view = selectMessageView({
        users: usersWith(
            [clientId('Alice', 'phone')],
            [clientId('Bob', 'phone')]
        ),
        queues: {},
        decrypted: {},
        message: messageFrom(clientId('Alice', 'phone')),
        messageIndex: 0
    })

    const bob = view.find(entry => entry.person === 'Bob')
    t.equal(
        bob!.holdsMessage,
        false,
        'Bob was not in the group when it was sent'
    )

    const alice = view.find(entry => entry.person === 'Alice')
    t.equal(alice!.holdsMessage, true, 'the sender always holds it')
})

test('the row key is stable per person per message', (t) => {
    t.equal(
        messageRowKey(2, 'Alice'),
        messageRowKey(2, 'Alice'),
        'the same person and message give the same key'
    )
    t.notEqual(
        messageRowKey(2, 'Alice'),
        messageRowKey(3, 'Alice'),
        'a different message gives a different key'
    )
    t.notEqual(
        messageRowKey(2, 'Alice'),
        messageRowKey(2, 'Bob'),
        'a different person gives a different key'
    )
})
