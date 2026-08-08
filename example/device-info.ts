import { DEVICES, parseClientId, type Device } from './devices.js'
import type { DemoUser } from '../example-shared/demo-user.js'
import { getHpkePublicKey } from '../src/ratchet-tree.js'
import { leafToNodeIndex, toLeafIndex } from '../src/treemath.js'
import { bytesToBase64url } from '../src/util/byte-array.js'

/**
 * One device's own MLS state, read off the client that device is. A
 * person is not a client, so everything here belongs to exactly one
 * `ClientState` -- the leaf it holds, the epoch it is on, and the public
 * key at its leaf.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node.
 */

export interface DeviceInfo {
    clientId:string;
    user:string;
    device:Device;

    // A key package (and signature keypair) exists for this device.
    created:boolean;

    // The device holds a leaf in the group, ie it has a ClientState.
    inGroup:boolean;

    // Everything below is null for a device with no group state: there
    // is no leaf to report, and inventing one would be a lie.
    leafIndex:number|null;
    nodeIndex:number|null;
    epoch:string|null;
    hpkePublicKeyBase64:string|null;
}

/**
 * Describe the client named by `id`. Returns null when the string is not
 * a client id at all -- an unknown device or a bare person name -- since
 * a person has no single MLS state to show. A device that exists only on
 * paper still gets a description, with its group fields null.
 */
export function selectDeviceInfo (
    id:string,
    users:Map<string, DemoUser>
):DeviceInfo|null {
    const parsed = parseClientId(id)
    if (!parsed) return null

    const device = DEVICES.find(d => d.id === parsed.deviceId)
    if (!device) return null

    const client = users.get(id)
    const state = client?.state

    const base = {
        clientId: id,
        user: parsed.user,
        device,
        created: !!client?.keyPackage,
        inGroup: !!state
    }

    if (!state) {
        return {
            ...base,
            leafIndex: null,
            nodeIndex: null,
            epoch: null,
            hpkePublicKeyBase64: null
        }
    }

    const leafIndex = state.privatePath.leafIndex
    const nodeIndex = leafToNodeIndex(toLeafIndex(leafIndex))

    // A leaf can be blank in this client's copy of the tree -- eg the
    // state predates its own add -- so the key is optional even here.
    const node = state.ratchetTree[nodeIndex]

    return {
        ...base,
        leafIndex,
        nodeIndex,
        epoch: state.groupContext.epoch.toString(),
        hpkePublicKeyBase64: node === undefined ?
            null :
            bytesToBase64url(getHpkePublicKey(node))
    }
}

export interface Selection {
    // The client id of the selected device, if any.
    device:string|null;

    // The pinned tree node, if any.
    nodeIndex:number|null;
}

/**
 * Drop the topmost selection: the device if one is selected, otherwise
 * the tree node. The two stack rather than replace each other -- a
 * selected device covers the tree diagram -- so clearing once puts the
 * tree back with its pinned node intact, and clearing again unpins it.
 */
export function clearTopSelection (selection:Selection):Selection {
    if (selection.device !== null) {
        return { device: null, nodeIndex: selection.nodeIndex }
    }

    return { device: null, nodeIndex: null }
}
