import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, encodeVarLenData } from './codec/variable-length.js'
import type { Hash } from './crypto/hash.js'
import { InternalError } from './mls-error.js'
import type { Node, RatchetTree } from './ratchet-tree.js'
import { findFirstNonBlankAncestor, removeLeaves, resolution } from './ratchet-tree.js'
import { treeHash } from './tree-hash.js'
import type {
    LeafIndex,
    NodeIndex
} from './treemath.js'
import {
    isLeaf,
    leafRange,
    leafToNodeIndex,
    leafWidth,
    left,
    right,
    root,
    toLeafIndex,
    toNodeIndex,
} from './treemath.js'

import { constantTimeEqual } from './util/constant-time-compare.js'

export interface ParentHashInput {
    encryptionKey:Uint8Array
    parentHash:Uint8Array
    originalSiblingTreeHash:Uint8Array
}

export const encodeParentHashInput:Encoder<ParentHashInput> = contramapEncoders(
    [encodeVarLenData, encodeVarLenData, encodeVarLenData],
    (i) => [i.encryptionKey, i.parentHash, i.originalSiblingTreeHash] as const,
)

export const decodeParentHashInput:Decoder<ParentHashInput> = mapDecoders(
    [decodeVarLenData, decodeVarLenData, decodeVarLenData],
    (encryptionKey, parentHash, originalSiblingTreeHash) => ({
        encryptionKey,
        parentHash,
        originalSiblingTreeHash,
    }),
)

function sameNodeIndexSet (a:NodeIndex[], b:NodeIndex[]):boolean {
    if (a.length !== b.length) return false
    const setA = new Set(a)
    return b.every((n) => setA.has(n))
}

/**
 * RFC 9420 SS7.9.2: the parent hash of D is valid with respect to P only if,
 * in addition to the hash-chain match, D is in the resolution of C (the
 * child of P on D's side), and the intersection of P's unmerged_leaves with
 * the subtree under C equals the resolution of C with D removed. This rules
 * out a tree where P claims a node as unmerged that was never actually part
 * of D's original UpdatePath resolution -- a way to smuggle in an
 * attacker-known key without being assigned a leaf under it.
 */
function satisfiesResolutionCriterion (
    tree:RatchetTree,
    d:NodeIndex,
    p:NodeIndex,
    c:NodeIndex,
):boolean {
    const parentNode = tree[p]
    if (parentNode === undefined || parentNode.nodeType !== 'parent') return false

    const resolutionOfC = resolution(tree, c)
    if (!resolutionOfC.includes(d)) return false

    const [lo, hi] = leafRange(c)
    const unmergedUnderC = parentNode.parent.unmergedLeaves
        .filter((leafIndex) => leafIndex >= lo && leafIndex <= hi)
        .map((leafIndex) => leafToNodeIndex(toLeafIndex(leafIndex)))

    const resolutionOfCWithoutD = resolutionOfC.filter((n) => n !== d)

    return sameNodeIndexSet(unmergedUnderC, resolutionOfCWithoutD)
}

function validateParentHashCoverage (parentIndices:number[], coverage:Record<number, number>):boolean {
    for (const index of parentIndices) {
        if ((coverage[index] ?? 0) !== 1) {
            return false
        }
    }
    return true
}

export async function verifyParentHashes (tree:RatchetTree, h:Hash):Promise<boolean> {
    const parentNodes = tree.reduce((acc, cur, index) => {
        if (cur !== undefined && cur.nodeType === 'parent') {
            return [...acc, index]
        } else return acc
    }, [] as number[])

    if (parentNodes.length === 0) return true

    const coverage = await parentHashCoverage(tree, h)

    return validateParentHashCoverage(parentNodes, coverage)
}

/**
 * Traverse tree from bottom up, verifying that all non-blank parent nodes are covered by exactly one chain
 */
function parentHashCoverage (tree:RatchetTree, h:Hash):Promise<Record<number, number>> {
    const leaves = tree.filter((_v, i) => isLeaf(toNodeIndex(i)))
    return leaves.reduce(
        async (acc, leafNode, leafIndex) => {
            if (leafNode === undefined) return acc

            let currentIndex = leafToNodeIndex(toLeafIndex(leafIndex))
            let updated = { ...(await acc) }

            const rootIndex = root(leafWidth(tree.length))

            while (currentIndex !== rootIndex) {
                const currentNode = tree[currentIndex]

                // defense in depth: currentIndex should always be either the
                // leaf we started from or a parentHashNodeIndex produced
                // below (always non-blank, or the root), so this should be
                // unreachable -- but if it ever is, advance to the nearest
                // non-blank ancestor via findFirstNonBlankAncestor instead of
                // looping in place on a blank node forever.
                if (currentNode === undefined) {
                    currentIndex = findFirstNonBlankAncestor(tree, currentIndex)
                    continue
                }

                // parentHashNodeIndex is the node index where the nearest non blank ancestor was
                const [parentHash, parentHashNodeIndex] = await calculateParentHash(tree, currentIndex, h)

                if (parentHashNodeIndex === undefined) {
                    throw new InternalError('Reached root before completing parent hash coeverage')
                }

                const expectedParentHash = getParentHash(currentNode)

                const cIndex = currentIndex < parentHashNodeIndex
                    ? left(parentHashNodeIndex)
                    : right(parentHashNodeIndex)

                if (
                    expectedParentHash !== undefined &&
                    constantTimeEqual(parentHash, expectedParentHash) &&
                    satisfiesResolutionCriterion(tree, currentIndex, parentHashNodeIndex, cIndex)
                ) {
                    const newCount = (updated[parentHashNodeIndex] ?? 0) + 1
                    updated = { ...updated, [parentHashNodeIndex]: newCount }
                } else {
                    // skip to next leaf
                    break
                }

                currentIndex = parentHashNodeIndex
            }

            return updated
        },
        Promise.resolve({} as Record<number, number>),
    )
}

function getParentHash (node:Node):Uint8Array | undefined {
    if (node.nodeType === 'parent') return node.parent.parentHash
    else if (node.leaf.leafNodeSource === 'commit') return node.leaf.parentHash
}

/**
 * Calculcates parent hash for a given node or leaf and returns the node index of the parent or undefined if the given node is the root node.
 */
export async function calculateParentHash (
    tree:RatchetTree,
    nodeIndex:NodeIndex,
    h:Hash,
):Promise<[Uint8Array, NodeIndex | undefined]> {
    const rootIndex = root(leafWidth(tree.length))
    if (nodeIndex === rootIndex) {
        return [new Uint8Array(), undefined]
    }

    const parentNodeIndex = findFirstNonBlankAncestor(tree, nodeIndex)

    const parentNode = tree[parentNodeIndex]

    if (parentNodeIndex === rootIndex && parentNode === undefined) {
        return [new Uint8Array(), parentNodeIndex]
    }

    const siblingIndex = nodeIndex < parentNodeIndex ? right(parentNodeIndex) : left(parentNodeIndex)

    if (parentNode === undefined || parentNode.nodeType === 'leaf') { throw new InternalError('Expected non-blank parent Node') }

    const removedUnmerged = removeLeaves(tree, parentNode.parent.unmergedLeaves as LeafIndex[])

    const originalSiblingTreeHash = await treeHash(removedUnmerged, siblingIndex, h)

    const input = {
        encryptionKey: parentNode.parent.hpkePublicKey,
        parentHash: parentNode.parent.parentHash,
        originalSiblingTreeHash,
    }

    return [await h.digest(encodeParentHashInput(input)), parentNodeIndex]
}
