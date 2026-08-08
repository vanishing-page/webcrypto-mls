import type { RatchetTree } from '../src/ratchet-tree.js'
import { leafToNodeIndex, toLeafIndex } from '../src/treemath.js'
import type { DemoUser } from '../example-shared/demo-user.js'
import type { DeviceRow } from './user.js'
import { directPathNodeIndices } from './tree-view.js'

/**
 * Which tree nodes belong to one person, once their devices are folded
 * back together. A person holds a leaf per in-group device, so their
 * "path" is the union of each of those leaves' direct paths -- shared
 * ancestors (always at least the root) appear once.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node. Returns an empty set when none of the person's devices is in the
 * group, which is also what an empty tree gives.
 */
export function userPathNodeIndices (
    tree:RatchetTree,
    rows:DeviceRow[],
    users:Map<string, DemoUser>
):Set<number> {
    const result = new Set<number>()

    for (const row of rows) {
        const path = users.get(row.clientId)?.state?.privatePath
        if (!path) continue

        for (const nodeIndex of directPathNodeIndices(
            tree,
            toLeafIndex(path.leafIndex)
        )) {
            result.add(nodeIndex)
        }
    }

    return result
}

/**
 * Just the leaves a person holds -- one node index per in-group device,
 * with no ancestors. This is the subset of `userPathNodeIndices` that is
 * the person themselves rather than the keys their update touches, so the
 * view can outline every one of their devices while their shared path
 * stays in the lighter on-path styling.
 *
 * Pure, like `userPathNodeIndices`. Leaves outside the tree are skipped,
 * so a stale leaf index highlights nothing rather than a wrong node.
 */
export function userLeafNodeIndices (
    tree:RatchetTree,
    rows:DeviceRow[],
    users:Map<string, DemoUser>
):Set<number> {
    const result = new Set<number>()

    for (const row of rows) {
        const path = users.get(row.clientId)?.state?.privatePath
        if (!path) continue

        const nodeIndex = leafToNodeIndex(toLeafIndex(path.leafIndex))
        if (nodeIndex < 0 || nodeIndex >= tree.length) continue

        result.add(nodeIndex)
    }

    return result
}
