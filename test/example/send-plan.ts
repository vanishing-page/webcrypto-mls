import { test } from '@substrate-system/tapzero'
import {
    canSend,
    sendOptions,
    resolvePendingSender
} from '../../example/send-plan.js'
import { selectUser } from '../../example/user.js'
import { DEVICES, clientId } from '../../example/devices.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

// A users map holding whichever of Alice's devices are named, with the
// listed ones in the group. `state` and `keyPackage` are only ever read
// for truthiness by selectUser, so a stub is enough here.
function usersWith (created:string[], inGroup:string[]) {
    const users = new Map<string, DemoUser>()

    for (const id of created) {
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

test('canSend needs one in-group device', (t) => {
    const none = selectUser('Alice', usersWith([], []))
    t.equal(canSend(none), false, 'a person with no devices cannot send')

    const created = selectUser(
        'Alice',
        usersWith([clientId('Alice', 'phone')], [])
    )
    t.equal(
        canSend(created),
        false,
        'a device that holds no leaf has no keys to encrypt with'
    )

    const joined = selectUser(
        'Alice',
        usersWith(
            [clientId('Alice', 'phone')],
            [clientId('Alice', 'phone')]
        )
    )
    t.equal(canSend(joined), true, 'one leaf is enough to send from')
})

test('sendOptions lists every device in DEVICES order', (t) => {
    const rows = selectUser(
        'Alice',
        usersWith(
            [clientId('Alice', 'phone'), clientId('Alice', 'laptop')],
            [clientId('Alice', 'laptop')]
        )
    )

    const options = sendOptions(rows)

    t.equal(options.length, DEVICES.length, 'one option per device')
    t.deepEqual(
        options.map(option => option.clientId),
        DEVICES.map(device => clientId('Alice', device.id)),
        'the options keep DEVICES order'
    )
    t.deepEqual(
        options.map(option => option.device.id),
        DEVICES.map(device => device.id),
        'each option carries its device, for the icon and label'
    )
})

test('sendOptions only enables in-group devices', (t) => {
    const rows = selectUser(
        'Alice',
        usersWith(
            [clientId('Alice', 'phone'), clientId('Alice', 'laptop')],
            [clientId('Alice', 'laptop')]
        )
    )

    const enabled = sendOptions(rows)
        .filter(option => option.enabled)
        .map(option => option.clientId)

    t.deepEqual(
        enabled,
        [clientId('Alice', 'laptop')],
        'a created but unjoined device cannot send, nor can a missing one'
    )
})

test('resolvePendingSender drops a stale person', (t) => {
    t.equal(
        resolvePendingSender('Alice', ['Alice', 'Bob']),
        'Alice',
        'a person who can still send stays pending'
    )
    t.equal(
        resolvePendingSender('Alice', ['Bob']),
        null,
        'losing their last leaf closes the device row'
    )
    t.equal(
        resolvePendingSender(null, ['Alice']),
        null,
        'nothing pending stays nothing pending'
    )
})
