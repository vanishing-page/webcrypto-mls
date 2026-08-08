import { test } from '@substrate-system/tapzero'
import { clientId } from '../../example/devices.js'
import {
    selectDeviceInfo,
    clearTopSelection
} from '../../example/device-info.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import type { Node, RatchetTree } from '../../src/ratchet-tree.js'

function fakeLeaf (byte:number):Node {
    return {
        nodeType: 'leaf',
        leaf: { hpkePublicKey: new Uint8Array([byte, byte, byte]) }
    } as unknown as Node
}

function fakeParent ():Node {
    return {
        nodeType: 'parent',
        parent: { hpkePublicKey: new Uint8Array([0]) }
    } as unknown as Node
}

// A 2-leaf tree: leaves at nodes 0 and 2, root at node 1.
function twoLeafTree ():RatchetTree {
    return [fakeLeaf(1), fakeParent(), fakeLeaf(2)]
}

interface Fixture {
    created?:boolean;
    leafIndex?:number;
    epoch?:bigint;
}

function usersMap (entries:[string, Fixture][]):Map<string, DemoUser> {
    return new Map(entries.map(([name, fixture]) => [
        name,
        {
            name,
            keyPackage: fixture.created === false ? undefined : {},
            state: fixture.leafIndex === undefined ?
                undefined :
                {
                    privatePath: { leafIndex: fixture.leafIndex },
                    groupContext: { epoch: fixture.epoch ?? 0n },
                    ratchetTree: twoLeafTree()
                }
        } as unknown as DemoUser
    ]))
}

test('selectDeviceInfo - rejects a string that is not a client id', t => {
    t.equal(
        selectDeviceInfo('Alice', new Map()),
        null,
        'a bare person name is not a device'
    )
    t.equal(
        selectDeviceInfo('Alice/toaster', new Map()),
        null,
        'an unknown device id is not a device'
    )
})

test('selectDeviceInfo - a device that has not been created', t => {
    const id = clientId('Alice', 'laptop')
    const info = selectDeviceInfo(id, new Map())

    t.ok(info, 'should describe a device nobody has created yet')
    t.equal(info!.user, 'Alice', 'should name the owner')
    t.equal(info!.device.id, 'laptop', 'should carry the device')
    t.equal(info!.clientId, id, 'should carry the client id')
    t.equal(info!.created, false, 'should report no key package')
    t.equal(info!.inGroup, false, 'should report it is not in the group')
    t.equal(info!.leafIndex, null, 'should have no leaf index')
    t.equal(info!.nodeIndex, null, 'should have no node index')
    t.equal(info!.epoch, null, 'should have no epoch')
    t.equal(
        info!.hpkePublicKeyBase64,
        null,
        'should have no key material to show'
    )
})

test('selectDeviceInfo - a created device that has not joined', t => {
    const id = clientId('Bob', 'phone')
    const info = selectDeviceInfo(id, usersMap([[id, {}]]))

    t.equal(info!.created, true, 'should report the key package exists')
    t.equal(info!.inGroup, false, 'should report it holds no leaf')
    t.equal(info!.leafIndex, null, 'should have no leaf index')
})

test('selectDeviceInfo - an in-group device', t => {
    const id = clientId('Bob', 'desktop')
    const info = selectDeviceInfo(
        id,
        usersMap([[id, { leafIndex: 1, epoch: 3n }]])
    )

    t.equal(info!.inGroup, true, 'should report it holds a leaf')
    t.equal(info!.leafIndex, 1, 'should report its leaf index')
    t.equal(info!.nodeIndex, 2, 'should report the leaf node index')
    t.equal(info!.epoch, '3', 'should report the epoch it is on')
    t.equal(
        typeof info!.hpkePublicKeyBase64,
        'string',
        "should report the leaf's HPKE public key"
    )
})

test('selectDeviceInfo - an in-group device off the end of the tree', t => {
    const id = clientId('Bob', 'desktop')
    const info = selectDeviceInfo(
        id,
        usersMap([[id, { leafIndex: 9, epoch: 1n }]])
    )

    t.equal(info!.inGroup, true, 'should still report it as in the group')
    t.equal(
        info!.hpkePublicKeyBase64,
        null,
        'a blank tree position yields no key rather than throwing'
    )
})

test('clearTopSelection - clears the device first', t => {
    t.deepEqual(
        clearTopSelection({ device: 'Alice/phone', nodeIndex: 4 }),
        { device: null, nodeIndex: 4 },
        'the tree node stays selected under the device'
    )
})

test('clearTopSelection - clears the tree node when no device', t => {
    t.deepEqual(
        clearTopSelection({ device: null, nodeIndex: 4 }),
        { device: null, nodeIndex: null },
        'with no device selected the node is the topmost selection'
    )
})

test('clearTopSelection - nothing selected stays nothing', t => {
    t.deepEqual(
        clearTopSelection({ device: null, nodeIndex: null }),
        { device: null, nodeIndex: null },
        'clearing an empty selection is a no-op'
    )
})
