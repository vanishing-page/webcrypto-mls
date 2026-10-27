import type { ClientState } from './client-state.js'
import type { LeafNode } from './leaf-node.js'
import { InternalError, UsageError } from './mls-error.js'
import type { LeafIndex } from './treemath.js'
import {
    leafToNodeIndex,
    leafWidth,
    toLeafIndex,
} from './treemath.js'

/** A current member of the group: its leaf index and its leaf node. */
export interface GroupMember {
    leafIndex:LeafIndex;
    leafNode:LeafNode;
}

/**
 * Every member of the group, in leaf order. Blank leaves -- left by a
 * Remove, or not yet filled by an Add -- are skipped, so a leaf index in
 * the result is the one a Remove proposal targets.
 */
export function getGroupMembers (state:ClientState):GroupMember[] {
    const tree = state.ratchetTree
    const members:GroupMember[] = []
    for (let i = 0; i < leafWidth(tree.length); i++) {
        const leafIndex = toLeafIndex(i)
        const node = tree[leafToNodeIndex(leafIndex)]
        if (node === undefined) continue
        if (node.nodeType !== 'leaf') {
            throw new InternalError('Found parent node in leaf node position')
        }
        members.push({ leafIndex, leafNode: node.leaf })
    }
    return members
}

/**
 * The member's own leaf node. A state that has been removed from the
 * group has no leaf, so asking it for one is a `UsageError`.
 */
export function getOwnLeafNode (state:ClientState):LeafNode {
    const leafIndex = toLeafIndex(state.privatePath.leafIndex)
    const node = state.ratchetTree[leafToNodeIndex(leafIndex)]
    if (node === undefined) {
        throw new UsageError('This member has no leaf in the group')
    }
    if (node.nodeType !== 'leaf') {
        throw new InternalError('Found parent node in leaf node position')
    }
    return node.leaf
}
