import { test } from '@substrate-system/tapzero'
import {
    DEVICES,
    clientId,
    parseClientId,
    userClientIds
} from '../../example/devices.js'
import { EXAMPLE_USERS } from '../../example/example-users.js'

test('DEVICES - three devices in a stable order', (t) => {
    t.equal(DEVICES.length, 3, 'there are three devices')
    t.deepEqual(
        DEVICES.map(d => d.id),
        ['phone', 'laptop', 'desktop'],
        'phone, laptop, desktop, in that order'
    )
    for (const device of DEVICES) {
        t.ok(device.label.length > 0, `${device.id} has a label`)
        t.ok(device.icon.length > 0, `${device.id} has an icon`)
    }
})

test('clientId - joins a user and a device id', (t) => {
    t.equal(clientId('Alice', 'phone'), 'Alice/phone',
        "Alice's phone is 'Alice/phone'")
    t.equal(clientId('Bob', 'desktop'), 'Bob/desktop',
        "Bob's desktop is 'Bob/desktop'")
})

test('parseClientId - round trips every user and device', (t) => {
    for (const user of EXAMPLE_USERS) {
        for (const device of DEVICES) {
            const parsed = parseClientId(clientId(user, device.id))
            t.deepEqual(
                parsed,
                { user, deviceId: device.id },
                `${user}/${device.id} round trips`
            )
        }
    }
})

test('parseClientId - rejects malformed ids', (t) => {
    t.equal(parseClientId('Alice'), null, 'missing separator is rejected')
    t.equal(parseClientId(''), null, 'empty string is rejected')
    t.equal(parseClientId('/phone'), null, 'empty user is rejected')
    t.equal(parseClientId('Alice/'), null, 'empty device id is rejected')
    t.equal(parseClientId('Alice/tablet'), null,
        'unknown device id is rejected')
    t.equal(parseClientId('Alice/Phone'), null,
        'device id is case sensitive')
    t.equal(parseClientId('Alice/phone/extra'), null,
        'an extra separator is rejected')
    t.equal(parseClientId('Alice phone'), null,
        'a space is not a separator')
})

test('userClientIds - one id per device, in DEVICES order', (t) => {
    t.deepEqual(
        userClientIds('Alice'),
        ['Alice/phone', 'Alice/laptop', 'Alice/desktop'],
        "Alice's three client ids"
    )
    for (const user of EXAMPLE_USERS) {
        const ids = userClientIds(user)
        t.equal(ids.length, DEVICES.length,
            `${user} has one id per device`)
        t.deepEqual(
            ids.map(id => parseClientId(id)?.user),
            ids.map(() => user),
            `every one of ${user}'s ids parses back to ${user}`
        )
    }
})
