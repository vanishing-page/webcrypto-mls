import { encodeUint32, decodeUint32 } from './codec/number.js'
import { encodeOptional, decodeOptional } from './codec/optional.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders, flatMapDecoder } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { encodeVarLenData, decodeVarLenData } from './codec/variable-length.js'
import type { Hash } from './crypto/hash.js'
import type { LeafNode } from './leaf-node.js'
import { encodeLeafNode, decodeLeafNode } from './leaf-node.js'
import { InternalError } from './mls-error.js'
import { encodeNodeType, decodeNodeType } from './node-type.js'
import type { ParentNode } from './parent-node.js'
import { encodeParentNode, decodeParentNode } from './parent-node.js'
import type { RatchetTree } from './ratchet-tree.js'
import type { LeafIndex, NodeIndex } from './treemath.js'
import {
    directPath,
    isLeaf,
    leafToNodeIndex,
    leafWidth,
    left,
    nodeToLeafIndex,
    right,
    rootFromNodeWidth,
} from './treemath.js'

// Type definitions used before defined - moved to top
type LeafNodeHashInput = {
    nodeType:'leaf'
    leafIndex:number
    leafNode:LeafNode | undefined
}
type ParentNodeHashInput = {
    nodeType:'parent'
    parentNode:ParentNode | undefined
    leftHash:Uint8Array
    rightHash:Uint8Array
}
export type TreeHashInput = LeafNodeHashInput | ParentNodeHashInput

export const encodeLeafNodeHashInput:Encoder<LeafNodeHashInput> = contramapEncoders(
    [encodeNodeType, encodeUint32, encodeOptional(encodeLeafNode)],
    (input) => [input.nodeType, input.leafIndex, input.leafNode] as const,
)

export const decodeLeafNodeHashInput:Decoder<LeafNodeHashInput> = mapDecoders(
    [decodeUint32, decodeOptional(decodeLeafNode)],
    (leafIndex, leafNode) => ({
        nodeType: 'leaf',
        leafIndex,
        leafNode,
    }),
)

export const encodeParentNodeHashInput:Encoder<ParentNodeHashInput> = contramapEncoders(
    [encodeNodeType, encodeOptional(encodeParentNode), encodeVarLenData, encodeVarLenData],
    (input) => [input.nodeType, input.parentNode, input.leftHash, input.rightHash] as const,
)

export const decodeParentNodeHashInput:Decoder<ParentNodeHashInput> = mapDecoders(
    [decodeOptional(decodeParentNode), decodeVarLenData, decodeVarLenData],
    (parentNode, leftHash, rightHash) => ({
        nodeType: 'parent',
        parentNode,
        leftHash,
        rightHash,
    }),
)

export const encodeTreeHashInput:Encoder<TreeHashInput> = (input) => {
    switch (input.nodeType) {
        case 'leaf':
            return encodeLeafNodeHashInput(input)
        case 'parent':
            return encodeParentNodeHashInput(input)
    }
}
export const decodeTreeHashInput:Decoder<TreeHashInput> = flatMapDecoder(
    decodeNodeType,
    (nodeType):Decoder<TreeHashInput> => {
        switch (nodeType) {
            case 'leaf':
                return decodeLeafNodeHashInput
            case 'parent':
                return decodeParentNodeHashInput
        }
    },
)

/**
 * Subtree hashes of every ratchet tree this package has hashed, indexed
 * by node index, with the hash function that computed them. Module
 * private: never exported, never put on `ClientState`, never serialized,
 * so a restored state starts cold. Keyed weakly by the tree array, so a
 * tree's hashes live exactly as long as the tree does.
 *
 * Valid only because no node of a tree array is written after a cached
 * hash covers it (the node's own hash or any ancestor's). A breach does
 * not throw: it produces or accepts a wrong tree hash, and the group
 * forks. AGENTS.md names the write sites.
 */
const treeHashes = new WeakMap<
    RatchetTree,
    { h:Hash, hashes:(Uint8Array | undefined)[] }
>()

function hashesOf (tree:RatchetTree, h:Hash):(Uint8Array | undefined)[] {
    const entry = treeHashes.get(tree)
    // a different hash function computes different hashes of the same
    // tree, so it starts over rather than read the other's
    if (entry !== undefined && entry.h === h) return entry.hashes
    const hashes:(Uint8Array | undefined)[] = []
    treeHashes.set(tree, { h, hashes })
    return hashes
}

/**
 * Seed `newTree`'s cache from `oldTree`'s, for a tree derived from the
 * old one by changing only `changedLeaves` and nodes on their direct
 * paths. Every node on those paths, each leaf included, is dropped; the
 * rest hash exactly as they did. Does nothing when the old tree has no
 * cache or the widths differ, since a different width moves the root
 * and every parent above the old one. Call it before `newTree` is
 * returned or hashed, so nothing is cached for it yet.
 */
export function carryTreeHashes (
    oldTree:RatchetTree,
    newTree:RatchetTree,
    changedLeaves:LeafIndex[],
):void {
    const entry = treeHashes.get(oldTree)
    if (entry === undefined || oldTree.length !== newTree.length) return
    const hashes = entry.hashes.slice()
    const width = leafWidth(newTree.length)
    for (const leaf of changedLeaves) {
        const leafNode = leafToNodeIndex(leaf)
        hashes[leafNode] = undefined
        for (const nodeIndex of directPath(leafNode, width)) {
            hashes[nodeIndex] = undefined
        }
    }
    treeHashes.set(newTree, { h: entry.h, hashes })
}

export async function treeHashRoot (
    tree:RatchetTree,
    h:Hash,
):Promise<Uint8Array> {
    return treeHash(tree, rootFromNodeWidth(tree.length), h)
}

export async function treeHash (
    tree:RatchetTree,
    subtreeIndex:NodeIndex,
    h:Hash,
):Promise<Uint8Array> {
    return subtreeHash(tree, subtreeIndex, h, hashesOf(tree, h))
}

async function subtreeHash (
    tree:RatchetTree,
    subtreeIndex:NodeIndex,
    h:Hash,
    cache:(Uint8Array | undefined)[],
):Promise<Uint8Array> {
    const cached = cache[subtreeIndex]
    if (cached !== undefined) return cached

    let hash:Uint8Array
    if (isLeaf(subtreeIndex)) {
        const leafNode = tree[subtreeIndex]
        if (leafNode?.nodeType === 'parent') throw new InternalError('Somehow found parent node in leaf position')
        const input = encodeLeafNodeHashInput({
            nodeType: 'leaf',
            leafIndex: nodeToLeafIndex(subtreeIndex),
            leafNode: leafNode?.leaf,
        })
        hash = await h.digest(input)
    } else {
        const parentNode = tree[subtreeIndex]
        if (parentNode?.nodeType === 'leaf') throw new InternalError('Somehow found leaf node in parent position')
        const leftHash = await subtreeHash(tree, left(subtreeIndex), h, cache)
        const rightHash = await subtreeHash(
            tree, right(subtreeIndex), h, cache)
        const input = {
            nodeType: 'parent',
            parentNode: parentNode?.parent,
            leftHash,
            rightHash,
        } as const

        hash = await h.digest(encodeParentNodeHashInput(input))
    }

    cache[subtreeIndex] = hash
    return hash
}
