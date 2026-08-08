import type { Credential, RatchetTree } from '../../src/index.js'
import { bytesToBase64url } from '../../src/index.js'
import { nodeToLeafIndex, toNodeIndex } from '../../src/treemath.js'

/**
 * The display name a credential carries, if it carries one.
 *
 * `Credential` is a union and `identity` exists only on the basic
 * variant, so the narrowing is required rather than defensive. Kept
 * here because the same question is asked of two different sources -- a
 * leaf already in the tree, and a key package attached to a request
 * from someone who is not in it yet.
 */
export function nameFromCredential (credential:Credential):string {
    return credential.credentialType === 'basic' ?
        new TextDecoder().decode(credential.identity) :
        '(non-basic credential)'
}

/**
 * A member as the page shows them. `identity` matches what the room
 * uses on the wire, so the roster's connected marks can be joined
 * against this list -- but the list itself comes from the tree, not
 * from the room.
 */
export interface Member {
    leafIndex:number
    identity:string
    name:string
}

/**
 * Every occupied leaf, in leaf order.
 *
 * Leaves live at even node indices, so a leaf index is half its node
 * index -- `nodeToLeafIndex` rather than an inline division, since that
 * arithmetic belongs to `src/treemath.ts`. A removed member's leaf is
 * blanked rather than deleted, which is why a gap in this list is
 * expected and why the array is not compacted: the leaf indices remain
 * meaningful for a later Remove.
 */
export function membersFromTree (tree:RatchetTree):Member[] {
    const members:Member[] = []

    for (let node = 0; node < tree.length; node = node + 2) {
        const entry = tree[node]
        if (!entry || entry.nodeType !== 'leaf') continue

        const leaf = entry.leaf

        members.push({
            leafIndex: nodeToLeafIndex(toNodeIndex(node)),
            identity: bytesToBase64url(leaf.signaturePublicKey),
            name: nameFromCredential(leaf.credential)
        })
    }

    return members
}

/**
 * The leaf index to name in a Remove proposal. Returns null when the
 * identity is not in the tree, which is what an already-removed member
 * looks like.
 */
export function leafIndexOf (
    tree:RatchetTree,
    identity:string
):number|null {
    const found = membersFromTree(tree)
        .find(member => member.identity === identity)
    return found ? found.leafIndex : null
}
