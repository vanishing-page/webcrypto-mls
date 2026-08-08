import { test } from '@substrate-system/tapzero'
import {
    memberKey,
    partitionPersistedNames,
    partitionRestorableRecords,
    restoredUsersFromRecords,
    isRestorableSession,
    restoredSessionUser,
    sessionRecord,
    type PersistedMember,
    type SessionInput
} from '../../example-shared/persistence-storage.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

test('memberKey builds a groupId:name key', (t) => {
    t.equal(memberKey('abc123', 'Alice'), 'abc123:Alice',
        'joins groupId and name with a colon')
})

test('restoredUsersFromRecords builds a users map and derives groupId',
    (t) => {
        const fakeState = {
            groupContext: { groupId: new Uint8Array([1, 2, 3]) }
        } as any

        const records:PersistedMember[] = [
            { name: 'Alice', state: fakeState },
            { name: 'Bob', state: fakeState }
        ]

        const { users, groupId } = restoredUsersFromRecords(records)

        t.equal(users.size, 2, 'both members restored')
        t.equal(users.get('Alice')?.state?.groupContext, fakeState.groupContext,
            'restored user carries the persisted groupContext')
        t.ok(users.get('Alice')?.state?.clientConfig,
            'restored state has a freshly-derived clientConfig')
        t.equal(users.get('Bob')?.state?.groupContext, fakeState.groupContext,
            'restored user carries the persisted groupContext')
        t.ok(groupId, 'groupId derived from a persisted state')
        t.equal(groupId, fakeState.groupContext.groupId,
            'groupId matches the persisted state\'s groupContext.groupId')
    }
)

test('restoredUsersFromRecords returns an empty result for no records',
    (t) => {
        const { users, groupId } = restoredUsersFromRecords([])
        t.equal(users.size, 0, 'no members restored')
        t.equal(groupId, null, 'no groupId to restore')
    }
)

test('partitionPersistedNames separates live members from stale records',
    (t) => {
        const users = new Map<string, DemoUser>([
            ['Alice', { name: 'Alice', state: {} as any }],
            // Removed from the group -- `removeUserFromGroup` clears the
            // state of a member it removes.
            ['Bob', { name: 'Bob' }]
        ])

        const { save, remove } = partitionPersistedNames(
            new Set(['Alice', 'Bob']),
            users
        )

        t.deepEqual(save, ['Alice'], 'a member still in the group is re-saved')
        t.deepEqual(remove, ['Bob'],
            'a member no longer in the group has their record deleted')
    }
)

test('partitionPersistedNames removes a name with no user at all', (t) => {
    const { save, remove } = partitionPersistedNames(
        new Set(['Bob']),
        new Map<string, DemoUser>()
    )

    t.deepEqual(save, [], 'nothing to re-save')
    t.deepEqual(remove, ['Bob'], 'the orphaned record is deleted')
})

function leaf (name:string):any {
    return {
        nodeType: 'leaf',
        leaf: {
            credential: {
                credentialType: 'basic',
                identity: new TextEncoder().encode(name)
            }
        }
    }
}

// Leaves at even node indices with parent slots left undefined, the
// same shape as a real RatchetTree. `null` marks a blank (removed)
// leaf.
function tree (names:(string | null)[]):any[] {
    const nodes:any[] = []
    for (const [i, name] of names.entries()) {
        if (i > 0) nodes.push(undefined)
        nodes.push(name === null ? undefined : leaf(name))
    }
    return nodes
}

function record (opts:{
    name:string;
    epoch:bigint;
    leafIndex:number;
    treeNames:(string | null)[];
    groupId?:Uint8Array;
    active?:boolean;
}):PersistedMember {
    return {
        name: opts.name,
        state: {
            groupContext: {
                epoch: opts.epoch,
                groupId: opts.groupId ?? new Uint8Array([1, 2, 3])
            },
            privatePath: { leafIndex: opts.leafIndex },
            ratchetTree: tree(opts.treeNames),
            groupActiveState: {
                kind: opts.active === false ?
                    'removedFromGroup' :
                    'active'
            }
        } as any
    }
}

test('partitionRestorableRecords keeps consistent records', (t) => {
    const names = ['Alice', 'Carl']
    const alice = record({
        name: 'Alice', epoch: 7n, leafIndex: 0, treeNames: names
    })
    const carl = record({
        name: 'Carl', epoch: 7n, leafIndex: 1, treeNames: names
    })

    const { restorable, stale } =
        partitionRestorableRecords([alice, carl])

    t.deepEqual(restorable.map((r) => r.name), ['Alice', 'Carl'],
        'both current members are restorable')
    t.deepEqual(stale, [], 'nothing is stale')
})

test('partitionRestorableRecords returns empty results for no records',
    (t) => {
        const { restorable, stale } = partitionRestorableRecords([])
        t.deepEqual(restorable, [], 'nothing to restore')
        t.deepEqual(stale, [], 'nothing stale')
    }
)

test('partitionRestorableRecords drops a zombie whose leaf was reused',
    (t) => {
        // Mirrors the 2026-07-25 incident: Bob was removed at epoch 3
        // and Eloise reused his leaf, but a legacy record still says
        // Bob is active at epoch 2.
        const current = ['Alice', 'Carl', 'Eloise', 'Fran']
        const alice = record({
            name: 'Alice', epoch: 7n, leafIndex: 0, treeNames: current
        })
        const bob = record({
            name: 'Bob',
            epoch: 2n,
            leafIndex: 2,
            treeNames: ['Alice', 'Carl', 'Bob', null]
        })
        const carl = record({
            name: 'Carl', epoch: 7n, leafIndex: 1, treeNames: current
        })

        const { restorable, stale } =
            partitionRestorableRecords([alice, bob, carl])

        t.deepEqual(restorable.map((r) => r.name), ['Alice', 'Carl'],
            'current members are restorable')
        t.deepEqual(stale.map((r) => r.name), ['Bob'],
            'the zombie record is stale')
    }
)

test('partitionRestorableRecords keeps a lagging member whose leaf ' +
    'is intact', (t) => {
    const alice = record({
        name: 'Alice',
        epoch: 7n,
        leafIndex: 0,
        treeNames: ['Alice', 'Carl', 'Eloise', 'Fran']
    })
    // Carl lags at epoch 5 and his tree still contains a member that
    // has since been removed, but his own leaf still holds his
    // credential in the authoritative tree.
    const carl = record({
        name: 'Carl',
        epoch: 5n,
        leafIndex: 1,
        treeNames: ['Alice', 'Carl', 'Bob', null]
    })

    const { restorable, stale } =
        partitionRestorableRecords([alice, carl])

    t.deepEqual(restorable.map((r) => r.name), ['Alice', 'Carl'],
        'lag alone is not grounds for dropping a record')
    t.deepEqual(stale, [], 'nothing is stale')
})

test('partitionRestorableRecords drops removedFromGroup, foreign, ' +
    'and out-of-range records', (t) => {
    const names = ['Alice', 'Carl']
    // Alice has the highest epoch so she is the authority, even
    // though the foreign-group record below carries a higher epoch
    // in its own (different) group.
    const alice = record({
        name: 'Alice', epoch: 10n, leafIndex: 0, treeNames: names
    })
    const removed = record({
        name: 'Dana',
        epoch: 7n,
        leafIndex: 1,
        treeNames: names,
        active: false
    })
    const foreign = record({
        name: 'Evan',
        epoch: 9n,
        leafIndex: 0,
        treeNames: ['Evan'],
        groupId: new Uint8Array([9, 9, 9])
    })
    const outOfRange = record({
        name: 'Fern',
        epoch: 3n,
        leafIndex: 5,
        treeNames: ['Alice', 'Carl', 'x', 'x', 'x', 'Fern']
    })

    const { restorable, stale } = partitionRestorableRecords(
        [alice, removed, foreign, outOfRange]
    )

    t.deepEqual(restorable.map((r) => r.name), ['Alice'],
        'only the active, same-group, in-tree record is restorable')
    t.deepEqual(stale.map((r) => r.name).sort(),
        ['Dana', 'Evan', 'Fern'],
        'removed, foreign-group, and out-of-range records are stale')
})

// -------------------------------------------------------------------
// The session store's pure helpers. No database is opened here, as in
// the member-store tests above: what gets written and what counts as
// restorable are decisions, and decisions are testable.
// -------------------------------------------------------------------

const KEY_PACKAGE = {
    leafNode: { signaturePublicKey: new Uint8Array([7, 7]) }
} as any

const PRIVATE_KEYS = { initPrivateKey: new Uint8Array([8, 8]) } as any

function sessionState ():any {
    return {
        clientConfig: { authService: { validateCredential: () => true } },
        groupContext: { epoch: 3n, groupId: new Uint8Array([1, 2, 3]) },
        ratchetTree: [],
        privatePath: { leafIndex: 0 },
        groupActiveState: { kind: 'active' }
    }
}

function session (over:Partial<SessionInput> = {}):SessionInput {
    return {
        name: 'Alice',
        keyPackage: KEY_PACKAGE,
        privateKeys: PRIVATE_KEYS,
        roomId: 'room-1',
        cursor: 4,
        creatorToken: null,
        ...over
    }
}

test('sessionRecord strips clientConfig and keeps the rest of state', (t) => {
    const state = sessionState()
    const record = sessionRecord(session({ state }))

    t.ok(record.state, 'the record still carries group state')
    t.equal(
        Object.hasOwn(record.state as object, 'clientConfig'),
        false,
        'clientConfig, which holds functions, is not persisted'
    )
    t.deepEqual(
        Object.keys(record.state as object).sort(),
        ['groupActiveState', 'groupContext', 'privatePath', 'ratchetTree'],
        'every other field of state survives'
    )
    t.equal(record.state?.groupContext, state.groupContext,
        'the persisted groupContext is the one it was given')
    t.equal(record.name, 'Alice', 'the user name is persisted')
    t.equal(record.roomId, 'room-1', 'the room id is persisted')
    t.equal(record.cursor, 4, 'the cursor is persisted')
    t.equal(record.keyPackage, KEY_PACKAGE, 'the key package is persisted')
    t.equal(record.privateKeys, PRIVATE_KEYS, 'the private keys are persisted')
})

test('sessionRecord leaves its input untouched', (t) => {
    const state = sessionState()
    const input = session({ state })
    sessionRecord(input)

    t.ok(input.state?.clientConfig,
        'the live state handed in still has its clientConfig')
})

test('sessionRecord handles a waiting joiner with no group state', (t) => {
    // The case `PersistedMember` cannot express: keys but no group yet.
    // `state` is passed explicitly as undefined, which is what a page
    // reading a possibly-null signal hands in, and is the shape a
    // spread would turn into a `state: undefined` key that structured
    // clone then stores.
    const record = sessionRecord(session({
        creatorToken: 'tok',
        state: undefined
    }))

    t.equal(Object.hasOwn(record, 'state'), false,
        'no state key is invented for a client that has no group')
    t.equal(record.creatorToken, 'tok', 'the creator token is persisted')
    t.equal(record.keyPackage, KEY_PACKAGE,
        'the key package the joiner is waiting on is persisted')
})

test('isRestorableSession accepts a record with group state', (t) => {
    t.equal(isRestorableSession(sessionRecord(session({
        state: sessionState()
    }))), true, 'a full record is restorable')
})

test('isRestorableSession accepts a waiting joiner with no state', (t) => {
    t.equal(isRestorableSession(sessionRecord(session())), true,
        'a joiner with keys and no group is restorable, which is what ' +
        'lets the waiting view come back on reload')
})

test('isRestorableSession accepts a cursor of zero', (t) => {
    t.equal(isRestorableSession(sessionRecord(session({ cursor: 0 }))), true,
        'zero is a real cursor -- a client that has seen nothing yet')
})

test('isRestorableSession rejects half-records and non-records', (t) => {
    const { keyPackage: _kp, ...noKeyPackage } = session()
    const { privateKeys: _pk, ...noPrivateKeys } = session()
    const { name: _name, ...noName } = session()

    t.equal(isRestorableSession(noKeyPackage), false,
        'without a key package there is nothing to rejoin with')
    t.equal(isRestorableSession(noPrivateKeys), false,
        'without private keys nothing can be decrypted')
    t.equal(isRestorableSession(noName), false, 'a record needs a name')
    t.equal(isRestorableSession(session({ cursor: NaN })), false,
        'NaN is not a position in the log')
    t.equal(isRestorableSession(session({ cursor: '4' as any })), false,
        'a cursor that is not a number is rejected, not coerced')
    t.equal(isRestorableSession(null), false, 'null is not a record')
    t.equal(isRestorableSession(undefined), false,
        'an absent record is not restorable')
    t.equal(isRestorableSession('session'), false, 'a string is not a record')
    t.equal(isRestorableSession([session()]), false,
        'an array of records is not a record')
})

test('restoredSessionUser rebuilds the client with a fresh clientConfig',
    (t) => {
        const state = sessionState()
        const user = restoredSessionUser(
            sessionRecord(session({ state }))
        )

        t.equal(user.name, 'Alice', 'the name comes back')
        t.equal(user.keyPackage, KEY_PACKAGE, 'the key package comes back')
        t.equal(user.privateKeys, PRIVATE_KEYS, 'the private keys come back')
        t.equal(user.state?.groupContext, state.groupContext,
            'the group comes back at the epoch it was persisted at')
        t.ok(user.state?.clientConfig,
            'clientConfig is re-derived rather than restored')
        t.ok(user.state?.clientConfig.authService,
            'the re-derived config carries the demo auth service')
    }
)

test('restoredSessionUser returns a user with no state for a joiner', (t) => {
    const user = restoredSessionUser(sessionRecord(session()))

    // Compared as a boolean rather than passed to `t.equal` directly:
    // on failure tapzero serializes the actual value into the
    // diagnostic, and a restored state holds a bigint epoch, which
    // throws and aborts the whole file instead of failing one test.
    t.equal(user.state === undefined, true,
        'a waiting joiner is restored without a group')
    t.equal(user.keyPackage, KEY_PACKAGE,
        'but keeps the key package its request was made with')
})
