import { test } from '@substrate-system/tapzero'
import {
    removalCommitter,
    removalStatus
} from '../../example/device-removal.js'
import { describeClient } from '../../example/user.js'

test('removalCommitter - prefers the same person, in DEVICES order', (t) => {
    t.equal(
        removalCommitter(
            ['Bob/phone', 'Alice/desktop', 'Alice/laptop', 'Alice/phone'],
            'Alice/phone'
        ),
        'Alice/laptop',
        'the laptop commits before the desktop, whatever the input order'
    )

    t.equal(
        removalCommitter(
            ['Alice/phone', 'Alice/desktop', 'Bob/phone'],
            'Alice/laptop'
        ),
        'Alice/phone',
        'the phone is first in DEVICES order'
    )
})

test('removalCommitter - falls back to another person', (t) => {
    t.equal(
        removalCommitter(
            ['Alice/phone', 'Bob/laptop', 'Carl/desktop'],
            'Alice/phone'
        ),
        'Bob/laptop',
        'Alice has no other leaf, so the first other client commits'
    )
})

test('removalCommitter - null when the target is the only client', (t) => {
    t.equal(
        removalCommitter(['Alice/phone'], 'Alice/phone'),
        null,
        'nobody is left to commit the removal'
    )

    t.equal(
        removalCommitter([], 'Alice/phone'),
        null,
        'an empty group has no committer'
    )
})

test('removalCommitter - the target never commits its own removal', (t) => {
    const ids = ['Alice/phone', 'Alice/laptop', 'Alice/desktop']

    for (const target of ids) {
        const committer = removalCommitter(ids, target)
        t.ok(committer, 'some other device commits')
        t.equal(
            committer === target,
            false,
            'MLS forbids committing your own removal'
        )
    }
})

test('removalCommitter - a name that is not a client id still works', (t) => {
    t.equal(
        removalCommitter(['Alice', 'Bob'], 'Alice'),
        'Bob',
        'an unparseable id has no user to prefer'
    )
})

test('removalStatus names both the committer and the removed device', (t) => {
    const line = removalStatus('Alice/laptop', 'Alice/phone', 3n, 4n)

    t.ok(line, 'should produce a status line')
    t.ok(
        line!.startsWith(describeClient('Alice/laptop')),
        'the committing device is named first'
    )
    t.ok(
        line!.includes(describeClient('Alice/phone')),
        'the removed device is named too'
    )
    t.ok(
        line!.includes('4'),
        'should report the epoch the removal landed on'
    )
})

test('removalStatus stays quiet when the epoch did not advance', (t) => {
    t.equal(
        removalStatus('Alice/laptop', 'Alice/phone', 3n, 3n),
        null,
        'an unchanged epoch means no commit happened'
    )
    t.equal(
        removalStatus('Alice/laptop', 'Alice/phone', 4n, 3n),
        null,
        'an epoch going backwards is not a removal either'
    )
    t.equal(
        removalStatus('Alice/laptop', 'Alice/phone', null, 3n),
        null,
        'a committer with no state committed nothing'
    )
    t.equal(
        removalStatus('Alice/laptop', 'Alice/phone', 3n, null),
        null,
        'a committer that lost its own state did not remove anyone'
    )
})
