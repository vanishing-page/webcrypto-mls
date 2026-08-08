import { test } from '@substrate-system/tapzero'
import { DEVICES, clientId } from '../../example/devices.js'
import {
    selectUser,
    selectDevice,
    userExists,
    userStartPlan,
    userCommitter,
    userAddPlan,
    userRemovePlan,
    membershipSummary,
    membershipText,
    describeClient
} from '../../example/user.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

// A users map entry is only ever read for `keyPackage` and `state` by the
// user selector, so the fixtures fill in just those two fields.
function usersMap (
    entries:[string, Partial<DemoUser>][]
):Map<string, DemoUser> {
    return new Map(
        entries.map(([name, user]) => [name, { name, ...user } as DemoUser])
    )
}

test('selectUser - three rows for a person with no devices', (t) => {
    const rows = selectUser('Alice', usersMap([]))

    t.equal(rows.length, 3, 'a person always has three device rows')
    t.deepEqual(
        rows.map(row => row.device.id),
        DEVICES.map(device => device.id),
        'the rows are in DEVICES order'
    )
    t.deepEqual(
        rows.map(row => row.clientId),
        ['Alice/phone', 'Alice/laptop', 'Alice/desktop'],
        'each row carries its client id'
    )
    t.ok(
        rows.every(row => !row.created && !row.inGroup),
        'nothing is created and nothing is in the group'
    )
})

test('selectDevice - one row, with the person read off the id', (t) => {
    const users = usersMap([
        [clientId('Alice', 'laptop'), {
            keyPackage: {} as any,
            state: {} as any
        }]
    ])

    const row = selectDevice(clientId('Alice', 'laptop'), users)

    t.ok(row, 'a client id resolves to a row')
    t.equal(row!.clientId, 'Alice/laptop', 'it is that device')
    t.equal(row!.device.id, 'laptop', 'carrying that device')
    t.ok(row!.created && row!.inGroup, 'with both flags from the map')
})

test('selectDevice - a device nobody has created', (t) => {
    const row = selectDevice(clientId('Alice', 'phone'), usersMap([]))

    t.ok(row, 'the row still exists')
    t.ok(
        !row!.created && !row!.inGroup,
        'reporting that nothing has been created'
    )
})

test('selectDevice - not a client id', (t) => {
    t.equal(
        selectDevice('Alice', usersMap([])),
        null,
        'a bare person name names no device'
    )
})

test('selectDevice - an unknown device', (t) => {
    t.equal(
        selectDevice('Alice/toaster', usersMap([])),
        null,
        'a device outside DEVICES names no row'
    )
})

test('selectUser - a created device is not yet in the group', (t) => {
    const rows = selectUser('Alice', usersMap([
        [clientId('Alice', 'phone'), { keyPackage: {} as any }],
        [clientId('Alice', 'laptop'), { keyPackage: {} as any }],
        [clientId('Alice', 'desktop'), { keyPackage: {} as any }]
    ]))

    t.ok(rows.every(row => row.created), 'all three are created')
    t.ok(rows.every(row => !row.inGroup), 'none is in the group')
})

test('selectUser - an in-group device reports both flags', (t) => {
    const rows = selectUser('Alice', usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Alice', 'laptop'), { keyPackage: {} as any }]
    ]))

    t.deepEqual(
        rows.map(row => row.created),
        [true, true, false],
        'only the created devices report created'
    )
    t.deepEqual(
        rows.map(row => row.inGroup),
        [true, false, false],
        'only the device with a ClientState is in the group'
    )
})

test('selectUser - one person does not see another', (t) => {
    const users = usersMap([
        [clientId('Bob', 'phone'), { keyPackage: {} as any }]
    ])

    t.ok(
        selectUser('Alice', users).every(row => !row.created),
        "Bob's phone is not one of Alice's devices"
    )
    t.equal(
        selectUser('Bob', users).filter(row => row.created).length,
        1,
        'Bob has one created device'
    )
})

test('userExists - true only when all three devices exist', (t) => {
    t.equal(
        userExists(selectUser('Alice', usersMap([]))),
        false,
        'no devices means the user does not exist'
    )

    t.equal(
        userExists(selectUser('Alice', usersMap([
            [clientId('Alice', 'phone'), { keyPackage: {} as any }]
        ]))),
        false,
        'a partially created user does not exist'
    )

    t.equal(
        userExists(selectUser('Alice', usersMap([
            [clientId('Alice', 'phone'), { keyPackage: {} as any }],
            [clientId('Alice', 'laptop'), { keyPackage: {} as any }],
            [clientId('Alice', 'desktop'), { keyPackage: {} as any }]
        ]))),
        true,
        'all three created means the user exists'
    )
})

test('userStartPlan - the phone creates, the others join', (t) => {
    const plan = userStartPlan(selectUser('Alice', usersMap([
        [clientId('Alice', 'phone'), { keyPackage: {} as any }],
        [clientId('Alice', 'laptop'), { keyPackage: {} as any }],
        [clientId('Alice', 'desktop'), { keyPackage: {} as any }]
    ])))

    t.ok(plan, 'a fully created user can start a group')
    t.equal(
        plan?.creator,
        'Alice/phone',
        'the first device in DEVICES order creates the group'
    )
    t.deepEqual(
        plan?.joiners,
        ['Alice/laptop', 'Alice/desktop'],
        'the remaining devices join, in DEVICES order'
    )
})

test('userStartPlan - null when nothing is created', (t) => {
    t.equal(
        userStartPlan(selectUser('Alice', usersMap([]))),
        null,
        'a person with no devices cannot start a group'
    )
})

test('userStartPlan - only created devices are in the plan', (t) => {
    const plan = userStartPlan(selectUser('Alice', usersMap([
        [clientId('Alice', 'laptop'), { keyPackage: {} as any }]
    ])))

    t.equal(
        plan?.creator,
        'Alice/laptop',
        'the first created device creates the group'
    )
    t.deepEqual(plan?.joiners, [], 'there is nobody left to join')
})

test('userCommitter - the first in-group device commits', (t) => {
    const rows = selectUser('Alice', usersMap([
        [clientId('Alice', 'phone'), { keyPackage: {} as any }],
        [clientId('Alice', 'laptop'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Alice', 'desktop'), {
            keyPackage: {} as any,
            state: {} as any
        }]
    ]))

    t.equal(
        userCommitter(rows),
        'Alice/laptop',
        'the phone is not in the group, so the laptop commits'
    )
})

test('userCommitter - null when nobody is in the group', (t) => {
    t.equal(
        userCommitter(selectUser('Alice', usersMap([
            [clientId('Alice', 'phone'), { keyPackage: {} as any }]
        ]))),
        null,
        'a created but not joined user cannot commit'
    )
})

test('userAddPlan - one commit adds every absent device', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'phone'), { keyPackage: {} as any }],
        [clientId('Bob', 'laptop'), { keyPackage: {} as any }],
        [clientId('Bob', 'desktop'), { keyPackage: {} as any }]
    ])

    const plan = userAddPlan(
        selectUser('Alice', users),
        selectUser('Bob', users)
    )

    t.equal(plan?.committer, 'Alice/phone', "Alice's phone commits")
    t.deepEqual(
        plan?.targets,
        ['Bob/phone', 'Bob/laptop', 'Bob/desktop'],
        'all three of Bob\'s devices are added by one commit'
    )
})

test('userAddPlan - devices already in the group are skipped', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'laptop'), { keyPackage: {} as any }]
    ])

    const plan = userAddPlan(
        selectUser('Alice', users),
        selectUser('Bob', users)
    )

    t.deepEqual(
        plan?.targets,
        ['Bob/laptop'],
        'only the created device that is not in the group is added'
    )
})

test('userAddPlan - null when there is nothing to do', (t) => {
    const noCommitter = usersMap([
        [clientId('Bob', 'phone'), { keyPackage: {} as any }]
    ])

    t.equal(
        userAddPlan(
            selectUser('Alice', noCommitter),
            selectUser('Bob', noCommitter)
        ),
        null,
        'an adder with no in-group device cannot commit'
    )

    const nothingToAdd = usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }]
    ])

    t.equal(
        userAddPlan(
            selectUser('Alice', nothingToAdd),
            selectUser('Bob', nothingToAdd)
        ),
        null,
        'a person with no created device has nothing to add'
    )
})

test('userRemovePlan - one commit removes every in-group device', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'laptop'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'desktop'), { keyPackage: {} as any }]
    ])

    const plan = userRemovePlan(
        selectUser('Alice', users),
        selectUser('Bob', users)
    )

    t.equal(plan?.committer, 'Alice/phone', "Alice's phone commits")
    t.deepEqual(
        plan?.targets,
        ['Bob/phone', 'Bob/laptop'],
        'the device that never joined is not removed'
    )
})

test('userRemovePlan - a user cannot remove themselves', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Alice', 'laptop'), {
            keyPackage: {} as any,
            state: {} as any
        }]
    ])

    t.equal(
        userRemovePlan(
            selectUser('Alice', users),
            selectUser('Alice', users)
        ),
        null,
        'the committer cannot be removed by its own commit'
    )
})

test('membership - clients and people are counted separately', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Alice', 'laptop'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Alice', 'desktop'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'phone'), {
            keyPackage: {} as any,
            state: {} as any
        }],
        [clientId('Bob', 'laptop'), { keyPackage: {} as any }]
    ])

    t.deepEqual(
        membershipSummary(users),
        { clients: 4, people: 2 },
        'four leaves belonging to two people'
    )
})

test('membershipText - the user count sits beside the clients', (t) => {
    t.equal(
        membershipText({ clients: 21, people: 7 }),
        '21 (7 people x 3 devices)',
        'a full tree reads as people times devices'
    )
    t.equal(
        membershipText({ clients: 3, people: 1 }),
        '3 (1 person x 3 devices)',
        'one person is singular'
    )
    t.equal(
        membershipText({ clients: 4, people: 2 }),
        '4 (2 people)',
        'a ragged group drops the multiplication it does not satisfy'
    )
    t.equal(
        membershipText({ clients: 0, people: 0 }),
        '0',
        'an empty group is just a zero'
    )
})

test('describeClient - a client id reads as a person and a device', (t) => {
    t.equal(
        describeClient('Alice/phone'),
        "Alice's Phone 📱",
        'the name, the device label, and the device icon'
    )
    t.equal(
        describeClient('Glorg/desktop'),
        "Glorg's Desktop 🖥️",
        'every device carries its own icon'
    )
})

test('describeClient - an unparseable name is left alone', (t) => {
    t.equal(
        describeClient('Alice'),
        'Alice',
        'a plain member name has no device to describe'
    )
    t.equal(
        describeClient('Alice/watch'),
        'Alice/watch',
        'an unknown device id is not a client id'
    )
})
