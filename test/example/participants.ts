import { test } from '@substrate-system/tapzero'
import { selectParticipants } from '../../example/participants.js'
import type { User } from '../../example/state.js'

function inGroup (name:string):User {
    return { name, state: {} } as unknown as User
}

function notInGroup (name:string):User {
    return { name } as unknown as User
}

test('selectParticipants - only in-group users', (t) => {
    const users = new Map<string, User>([
        ['Alice', inGroup('Alice')],
        ['Bob', notInGroup('Bob')],
        ['Carl', inGroup('Carl')],
    ])

    const result = selectParticipants(users)

    t.equal(result.length, 2, 'excludes users with no state')
    t.equal(result.includes('Bob'), false, 'Bob is not in the group')
})

test('selectParticipants - preserves Map insertion order', (t) => {
    const users = new Map<string, User>([
        ['Carl', inGroup('Carl')],
        ['Alice', inGroup('Alice')],
        ['Bob', inGroup('Bob')],
    ])

    const result = selectParticipants(users)

    t.deepEqual(
        result,
        ['Carl', 'Alice', 'Bob'],
        'order matches Map insertion order'
    )
})

test('selectParticipants - empty map', (t) => {
    const result = selectParticipants(new Map())

    t.deepEqual(result, [], 'returns an empty array')
})
