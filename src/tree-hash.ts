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
import type { NodeIndex } from './treemath.js'
import { rootFromNodeWidth, isLeaf, nodeToLeafIndex, left, right } from './treemath.js'

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

export async function treeHashRoot (tree:RatchetTree, h:Hash):Promise<Uint8Array> {
    return treeHash(tree, rootFromNodeWidth(tree.length), h)
}

export async function treeHash (tree:RatchetTree, subtreeIndex:NodeIndex, h:Hash):Promise<Uint8Array> {
    if (isLeaf(subtreeIndex)) {
        const leafNode = tree[subtreeIndex]
        if (leafNode?.nodeType === 'parent') throw new InternalError('Somehow found parent node in leaf position')
        const input = encodeLeafNodeHashInput({
            nodeType: 'leaf',
            leafIndex: nodeToLeafIndex(subtreeIndex),
            leafNode: leafNode?.leaf,
        })
        return await h.digest(input)
    } else {
        const parentNode = tree[subtreeIndex]
        if (parentNode?.nodeType === 'leaf') throw new InternalError('Somehow found leaf node in parent position')
        const leftHash = await treeHash(tree, left(subtreeIndex), h)
        const rightHash = await treeHash(tree, right(subtreeIndex), h)
        const input = {
            nodeType: 'parent',
            parentNode: parentNode?.parent,
            leftHash,
            rightHash,
        } as const

        return await h.digest(encodeParentNodeHashInput(input))
    }
}
