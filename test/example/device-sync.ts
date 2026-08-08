import { test } from '@substrate-system/tapzero'
import { bytesToBase64url } from '../../src/index.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import {
    syncPersistedDevices,
    type DeviceSyncStore
} from '../../example/device-sync.js'

const GROUP_ID = new Uint8Array([7, 7, 7])

interface Recorded {
    saved:Array<{ groupIdB64:string; name:string; marker:string }>
    deleted:Array<{ groupIdB64:string; name:string }>
}

function recordingStore ():DeviceSyncStore & { calls:Recorded } {
    const calls:Recorded = { saved: [], deleted: [] }

    return {
        calls,
        async saveMember (groupIdB64, name, state) {
            calls.saved.push({
                groupIdB64,
                name,
                marker: (state as any).marker
            })
        },
        async deleteMember (groupIdB64, name) {
            calls.deleted.push({ groupIdB64, name })
        }
    }
}

// A device holding a leaf. `marker` stands in for whatever the state
// says about the current epoch: re-saving is only useful if the state
// handed to the store is the one the client holds right now.
function inGroup (name:string, marker:string):DemoUser {
    return { name, state: { marker } as any }
}

// A device that exists but holds no leaf -- created but never added, or
// removed from the group.
function outOfGroup (name:string):DemoUser {
    return { name }
}

test('syncing re-saves every persisted device with its current state',
    async (t) => {
        const store = recordingStore()

        const next = await syncPersistedDevices(store, {
            groupId: GROUP_ID,
            users: new Map([
                ['Alice/phone', inGroup('Alice/phone', 'epoch-3')],
                ['Alice/laptop', inGroup('Alice/laptop', 'epoch-3')],
                ['Bob/phone', inGroup('Bob/phone', 'epoch-3')]
            ]),
            persistedIds: new Set(['Alice/phone', 'Bob/phone'])
        })

        t.equal(store.calls.saved.length, 2, 'only persisted devices re-save')
        t.deepEqual(
            store.calls.saved.map(call => call.name).sort(),
            ['Alice/phone', 'Bob/phone'],
            'each already-persisted device is written'
        )
        t.deepEqual(
            store.calls.saved.map(call => call.marker),
            ['epoch-3', 'epoch-3'],
            'the state written is the one the client holds now'
        )
        t.deepEqual(
            store.calls.saved.map(call => call.groupIdB64),
            [bytesToBase64url(GROUP_ID), bytesToBase64url(GROUP_ID)],
            'records are keyed by the current group id'
        )
        t.equal(store.calls.deleted.length, 0, 'nothing is dropped')
        t.deepEqual(
            [...next].sort(),
            ['Alice/phone', 'Bob/phone'],
            'the persisted set is unchanged'
        )
    }
)

test('syncing drops the record of a device no longer in the group',
    async (t) => {
        const store = recordingStore()

        const next = await syncPersistedDevices(store, {
            groupId: GROUP_ID,
            users: new Map([
                ['Alice/phone', inGroup('Alice/phone', 'epoch-4')],
                ['Alice/laptop', outOfGroup('Alice/laptop')]
            ]),
            persistedIds: new Set(['Alice/phone', 'Alice/laptop'])
        })

        t.deepEqual(
            store.calls.saved.map(call => call.name),
            ['Alice/phone'],
            'the device still holding a leaf is re-saved'
        )
        t.deepEqual(
            store.calls.deleted,
            [{
                groupIdB64: bytesToBase64url(GROUP_ID),
                name: 'Alice/laptop'
            }],
            'the removed device\'s record is deleted'
        )
        t.deepEqual(
            [...next],
            ['Alice/phone'],
            'and it is no longer reported as persisted'
        )
    }
)

test('syncing keeps the same persisted set when nothing was dropped',
    async (t) => {
        const store = recordingStore()
        const persistedIds = new Set(['Alice/phone'])

        const next = await syncPersistedDevices(store, {
            groupId: GROUP_ID,
            users: new Map([
                ['Alice/phone', inGroup('Alice/phone', 'epoch-1')]
            ]),
            persistedIds
        })

        t.equal(
            next,
            persistedIds,
            'the set is returned untouched, so nothing re-renders'
        )
    }
)

test('syncing before there is a group does nothing', async (t) => {
    const store = recordingStore()

    const next = await syncPersistedDevices(store, {
        groupId: null,
        users: new Map([['Alice/phone', outOfGroup('Alice/phone')]]),
        persistedIds: new Set(['Alice/phone'])
    })

    t.equal(store.calls.saved.length, 0, 'nothing is written')
    t.equal(store.calls.deleted.length, 0, 'nothing is deleted')
    t.equal(next.size, 1, 'and the persisted set is left alone')
})

test('syncing with nothing persisted touches storage not at all',
    async (t) => {
        const store = recordingStore()

        await syncPersistedDevices(store, {
            groupId: GROUP_ID,
            users: new Map([
                ['Alice/phone', inGroup('Alice/phone', 'epoch-2')]
            ]),
            persistedIds: new Set()
        })

        t.equal(store.calls.saved.length, 0, 'an unpersisted device is not')
        t.equal(store.calls.deleted.length, 0, 'saved behind the user\'s back')
    }
)
