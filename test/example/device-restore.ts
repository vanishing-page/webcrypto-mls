import { test } from '@substrate-system/tapzero'
import { partitionDeviceRecords } from '../../example/device-restore.js'
import type {
    PersistedMember
} from '../../example-shared/persistence-storage.js'

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

// Leaves at even node indices with parent slots left undefined, the same
// shape as a real RatchetTree. `null` marks a blank (removed) leaf.
function tree (names:(string|null)[]):any[] {
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
    treeNames:(string|null)[];
}):PersistedMember {
    return {
        name: opts.name,
        state: {
            groupContext: {
                epoch: opts.epoch,
                groupId: new Uint8Array([1, 2, 3])
            },
            privatePath: { leafIndex: opts.leafIndex },
            ratchetTree: tree(opts.treeNames),
            groupActiveState: { kind: 'active' }
        } as any
    }
}

test('partitionDeviceRecords restores a user\'s client records', (t) => {
    const names = ['Alice/phone', 'Alice/laptop', 'Alice/desktop']
    const records = names.map((name, i) => record({
        name, epoch: 4n, leafIndex: i, treeNames: names
    }))

    const { restorable, stale } = partitionDeviceRecords(records)

    t.deepEqual(restorable.map((r) => r.name), names,
        'all three of a person\'s devices are restorable')
    t.deepEqual(stale, [], 'nothing is stale')
})

test('partitionDeviceRecords treats a non-client-id name as stale', (t) => {
    const names = ['Alice/phone', 'Alice/laptop']
    const alice = record({
        name: 'Alice/phone', epoch: 4n, leafIndex: 0, treeNames: names
    })
    const laptop = record({
        name: 'Alice/laptop', epoch: 4n, leafIndex: 1, treeNames: names
    })
    // Written by a page that keys records by person, not by client.
    const legacy = record({
        name: 'Alice', epoch: 4n, leafIndex: 0, treeNames: names
    })
    // A well formed name with a device this demo does not know about.
    const unknownDevice = record({
        name: 'Alice/tablet', epoch: 4n, leafIndex: 1, treeNames: names
    })

    const { restorable, stale } = partitionDeviceRecords([
        alice, legacy, laptop, unknownDevice
    ])

    t.deepEqual(restorable.map((r) => r.name), names,
        'only records named by a valid client id are restorable')
    t.deepEqual(stale.map((r) => r.name).sort(), ['Alice', 'Alice/tablet'],
        'both unparseable names are stale')
})

test('partitionDeviceRecords ignores an alien record when picking the ' +
    'authority', (t) => {
    const names = ['Alice/phone', 'Alice/laptop']
    const alice = record({
        name: 'Alice/phone', epoch: 4n, leafIndex: 0, treeNames: names
    })
    const laptop = record({
        name: 'Alice/laptop', epoch: 4n, leafIndex: 1, treeNames: names
    })
    // A far higher epoch and a tree holding nobody the real records know.
    // If it reached partitionRestorableRecords it would be treated as
    // authoritative and every genuine device would read as stale.
    const alien = record({
        name: 'not a client id',
        epoch: 99n,
        leafIndex: 0,
        treeNames: ['Zed', 'Zed']
    })

    const { restorable, stale } = partitionDeviceRecords([
        alice, alien, laptop
    ])

    t.deepEqual(restorable.map((r) => r.name), names,
        'the genuine devices survive an alien high-epoch record')
    t.deepEqual(stale.map((r) => r.name), ['not a client id'],
        'the alien record is stale')
})

test('partitionDeviceRecords still drops a device no longer in the tree',
    (t) => {
        const current = ['Alice/phone', 'Alice/laptop']
        const phone = record({
            name: 'Alice/phone', epoch: 6n, leafIndex: 0, treeNames: current
        })
        // Removed at epoch 3, its record never deleted.
        const desktop = record({
            name: 'Alice/desktop',
            epoch: 3n,
            leafIndex: 1,
            treeNames: ['Alice/phone', 'Alice/desktop']
        })

        const { restorable, stale } = partitionDeviceRecords([phone, desktop])

        t.deepEqual(restorable.map((r) => r.name), ['Alice/phone'],
            'the in-tree device is restorable')
        t.deepEqual(stale.map((r) => r.name), ['Alice/desktop'],
            'the removed device is stale, via partitionRestorableRecords')
    }
)

test('partitionDeviceRecords returns empty results for no records', (t) => {
    const { restorable, stale } = partitionDeviceRecords([])
    t.deepEqual(restorable, [], 'nothing to restore')
    t.deepEqual(stale, [], 'nothing stale')
})
