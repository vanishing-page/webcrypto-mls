import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, decodeVarLenType, encodeVarLenData, encodeVarLenType } from './codec/variable-length.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { Hash } from './crypto/hash.js'
import type { PrivateKey } from './crypto/hpke.js'
import { encryptWithLabel } from './crypto/hpke.js'
import { deriveSecret } from './crypto/kdf.js'
import type { SignatureSecretKey } from './crypto/signature.js'
import type { GroupContext } from './group-context.js'
import { encodeGroupContext } from './group-context.js'
import type {
    LeafNodeCommit,
    LeafNodeTBSCommit
} from './leaf-node.js'
import {
    decodeLeafNodeCommit,
    encodeLeafNode,
    signLeafNodeCommit,
} from './leaf-node.js'
import { calculateParentHash } from './parent-hash.js'
import type {
    Node,
    RatchetTree
} from './ratchet-tree.js'
import {
    filteredDirectPath,
    filteredDirectPathAndCopathResolution,
    getHpkePublicKey
} from './ratchet-tree.js'
import { treeHashRoot } from './tree-hash.js'
import type { LeafIndex, NodeIndex } from './treemath.js'
import { isAncestor, leafToNodeIndex } from './treemath.js'
import { updateArray } from './util/array.js'
import { constantTimeEqual } from './util/constant-time-compare.js'
import type { HPKECiphertext } from './hpke-ciphertext.js'
import { decodeHpkeCiphertext, encodeHpkeCiphertext } from './hpke-ciphertext.js'
import { InternalError, ValidationError } from './mls-error.js'

export interface UpdatePathNode {
    hpkePublicKey:Uint8Array
    encryptedPathSecret:HPKECiphertext[]
}

export const encodeUpdatePathNode:Encoder<UpdatePathNode> = contramapEncoders(
    [encodeVarLenData, encodeVarLenType(encodeHpkeCiphertext)],
    (node) => [node.hpkePublicKey, node.encryptedPathSecret] as const,
)

export const decodeUpdatePathNode:Decoder<UpdatePathNode> = mapDecoders(
    [decodeVarLenData, decodeVarLenType(decodeHpkeCiphertext)],
    (hpkePublicKey, encryptedPathSecret) => ({ hpkePublicKey, encryptedPathSecret }),
)

export interface UpdatePath {
    leafNode:LeafNodeCommit
    nodes:UpdatePathNode[]
}

export const encodeUpdatePath:Encoder<UpdatePath> = contramapEncoders(
    [encodeLeafNode, encodeVarLenType(encodeUpdatePathNode)],
    (path) => [path.leafNode, path.nodes] as const,
)

export const decodeUpdatePath:Decoder<UpdatePath> = mapDecoders(
    [decodeLeafNodeCommit, decodeVarLenType(decodeUpdatePathNode)],
    (leafNode, nodes) => ({ leafNode, nodes }),
)

export interface PathSecret {
    nodeIndex:number
    secret:Uint8Array
    sendTo:number[]
}

/**
 * Zeroizes every PathSecret's secret in a PathSecret[] in place. Call only
 * once every consumer of these secrets (deriving the commit secret,
 * deriving private keys) has already run.
 */
export function zeroPathSecretsArray (pathSecrets:PathSecret[]):void {
    for (const p of pathSecrets) p.secret.fill(0)
}

export function filterNewLeaves (resolution:NodeIndex[], excludeNodes:NodeIndex[]):NodeIndex[] {
    const set = new Set(excludeNodes)
    return resolution.filter((i) => !set.has(i))
}

export async function createUpdatePath (
    originalTree:RatchetTree,
    senderLeafIndex:LeafIndex,
    groupContext:GroupContext,
    signaturePrivateKey:SignatureSecretKey,
    cs:CiphersuiteImpl,
    excludeNodes:NodeIndex[] = [],
):Promise<[RatchetTree, UpdatePath, PathSecret[], PrivateKey]> {
    const originalLeafNode = originalTree[leafToNodeIndex(senderLeafIndex)]
    if (originalLeafNode === undefined || originalLeafNode.nodeType === 'parent') { throw new InternalError('Expected non-blank leaf node') }

    const pathSecret = cs.rng.randomBytes(cs.kdf.size)

    const leafNodeSecret = await deriveSecret(pathSecret, 'node', cs.kdf)
    const leafKeypair = await cs.hpke.deriveKeyPair(leafNodeSecret)
    leafNodeSecret.fill(0)

    // exclude leaves added by this commit from each copath resolution: new
    // members receive their path secret via the Welcome, not via the
    // UpdatePath, and receivers already exclude these nodes when locating
    // their ciphertext (see applyUpdatePathSecret), so the sender's
    // encrypted_path_secret vector must match that same filtered length/order
    const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, originalTree).map(
        ({ nodeIndex, resolution }) => ({ nodeIndex, resolution: filterNewLeaves(resolution, excludeNodes) }),
    )

    const [ps, updatedTree]:[PathSecret[], RatchetTree] = await applyInitialTreeUpdate(
        fdp,
        pathSecret,
        senderLeafIndex,
        originalTree,
        cs,
    )

    const treeWithHashes = await insertParentHashes(fdp, updatedTree, cs)

    const leafParentHash = await calculateParentHash(treeWithHashes, leafToNodeIndex(senderLeafIndex), cs.hash)

    const updatedLeafNodeTbs:LeafNodeTBSCommit = {
        leafNodeSource: 'commit',
        hpkePublicKey: await cs.hpke.exportPublicKey(leafKeypair.publicKey),
        extensions: originalLeafNode.leaf.extensions,
        capabilities: originalLeafNode.leaf.capabilities,
        credential: originalLeafNode.leaf.credential,
        signaturePublicKey: originalLeafNode.leaf.signaturePublicKey,
        parentHash: leafParentHash[0],
        info: { leafNodeSource: 'commit', groupId: groupContext.groupId, leafIndex: senderLeafIndex },
    }

    const updatedLeafNode = await signLeafNodeCommit(updatedLeafNodeTbs, signaturePrivateKey, cs.signature)

    const finalTree = updateArray(treeWithHashes, leafToNodeIndex(senderLeafIndex), {
        nodeType: 'leaf',
        leaf: updatedLeafNode,
    })

    const updatedTreeHash = await treeHashRoot(finalTree, cs.hash)

    const updatedGroupContext:GroupContext = {
        ...groupContext,
        treeHash: updatedTreeHash,
        epoch: groupContext.epoch + 1n,
    }

    // we have to remove the leaf secret since we don't send it to anyone
    const pathSecretsToDistribute = ps.slice(0, ps.length - 1).reverse()

    // we have to pass the old tree here since the receiver won't have the updated public keys yet
    const updatePathNodes:UpdatePathNode[] = await Promise.all(
        pathSecretsToDistribute.map(encryptSecretsForPath(originalTree, finalTree, updatedGroupContext, cs)),
    )

    const updatePath:UpdatePath = { leafNode: updatedLeafNode, nodes: updatePathNodes }

    // when the sender's leaf is also the tree root (e.g. they are the sole
    // remaining member after a Remove), the filtered direct path is empty
    // and there is no parent node to distribute a secret to. The freshly
    // generated secret still has to seed the commit secret so it is not a
    // predictable constant that a removed member could reconstruct.
    const pathSecrets = pathSecretsToDistribute.length > 0 ? pathSecretsToDistribute : [ps[0]!]

    return [finalTree, updatePath, pathSecrets, leafKeypair.privateKey] as const
}

function encryptSecretsForPath (
    originalTree:RatchetTree,
    updatedTree:RatchetTree,
    updatedGroupContext:GroupContext,
    cs:CiphersuiteImpl,
):(pathSecret:PathSecret) => Promise<UpdatePathNode> {
    return async (pathSecret) => {
        const key = getHpkePublicKey(updatedTree[pathSecret.nodeIndex]!)

        const res:UpdatePathNode = {
            hpkePublicKey: key,
            encryptedPathSecret: await Promise.all(
                pathSecret.sendTo.map(async (nodeIndex) => {
                    const { ct, enc } = await encryptWithLabel(
                        await cs.hpke.importPublicKey(getHpkePublicKey(originalTree[nodeIndex]!)),
                        'UpdatePathNode',
                        encodeGroupContext(updatedGroupContext),
                        pathSecret.secret,
                        cs.hpke,
                    )
                    return { ciphertext: ct, kemOutput: enc }
                }),
            ),
        }
        return res
    }
}

async function insertParentHashes (
    fdp:{ resolution:NodeIndex[]; nodeIndex:NodeIndex }[],
    updatedTree:RatchetTree,
    cs:CiphersuiteImpl,
) {
    return await fdp
        .slice()
        .reverse()
        .reduce(async (treePromise, { nodeIndex }) => {
            const tree = await treePromise
            const parentHash = await calculateParentHash(tree, nodeIndex, cs.hash)
            const currentNode = tree[nodeIndex]
            if (currentNode === undefined || currentNode.nodeType === 'leaf') { throw new InternalError('Expected non-blank parent node') }
            const updatedNode:Node = { nodeType: 'parent', parent: { ...currentNode.parent, parentHash: parentHash[0] } }

            return updateArray(tree, nodeIndex, updatedNode)
        }, Promise.resolve(updatedTree))
}

/**
 * Inserts new public keys from a single secret in the update path and returns the resulting tree along with the secrets along the path
 * Note that the path secrets are returned root to leaf
 */
async function applyInitialTreeUpdate (
    fdp:{ resolution:number[]; nodeIndex:number }[],
    pathSecret:Uint8Array,
    senderLeafIndex:LeafIndex,
    tree:RatchetTree,
    cs:CiphersuiteImpl,
):Promise<[PathSecret[], RatchetTree]> {
    return await fdp.reduce(
        async (acc, { nodeIndex, resolution }) => {
            const [pathSecrets, tree] = await acc
            const lastPathSecret = pathSecrets[0]!
            const nextPathSecret = await deriveSecret(lastPathSecret.secret, 'path', cs.kdf)
            const nextNodeSecret = await deriveSecret(nextPathSecret, 'node', cs.kdf)
            const { publicKey } = await cs.hpke.deriveKeyPair(nextNodeSecret)
            nextNodeSecret.fill(0)

            const updatedTree = updateArray(tree, nodeIndex, {
                nodeType: 'parent',
                parent: {
                    hpkePublicKey: await cs.hpke.exportPublicKey(publicKey),
                    parentHash: new Uint8Array(),
                    unmergedLeaves: [],
                },
            })

            return [[{ nodeIndex, secret: nextPathSecret, sendTo: resolution }, ...pathSecrets], updatedTree]
        },
        Promise.resolve([[{ secret: pathSecret, nodeIndex: leafToNodeIndex(senderLeafIndex), sendTo: [] }], tree] as [
            PathSecret[],
            RatchetTree,
        ]),
    )
}

export async function applyUpdatePath (
    tree:RatchetTree,
    senderLeafIndex:LeafIndex,
    path:UpdatePath,
    h:Hash,
    isExternal:boolean = false,
):Promise<RatchetTree> {
    // if this is an external commit, the leaf node did not exist prior
    if (!isExternal) {
        const leafToUpdate = tree[leafToNodeIndex(senderLeafIndex)]

        if (leafToUpdate === undefined || leafToUpdate.nodeType === 'parent') { throw new InternalError('Leaf node not defined or is parent') }

        const leafNodePublicKeyNotNew = constantTimeEqual(leafToUpdate.leaf.hpkePublicKey, path.leafNode.hpkePublicKey)

        if (leafNodePublicKeyNotNew) { throw new ValidationError("Public key in the LeafNode is the same as the committer's current leaf node") }
    }

    // RFC 9420 SS7.6: the HPKEPublicKey values carried in an UpdatePath MUST
    // be distinct from every public key already present in the ratchet tree
    // -- leaf keys included, not just parent keys -- and distinct from each
    // other within the UpdatePath itself. Reusing a key lets whoever controls
    // it decrypt path secrets that were meant for a different node.
    const pathNodePublicKeysExistInTree = path.nodes.some((node) =>
        tree.some((treeNode) => {
            if (treeNode === undefined) return false
            const existingKey = treeNode.nodeType === 'parent' ?
                treeNode.parent.hpkePublicKey :
                treeNode.leaf.hpkePublicKey
            return constantTimeEqual(existingKey, node.hpkePublicKey)
        }),
    )

    if (pathNodePublicKeysExistInTree) { throw new ValidationError('Public keys in the UpdatePath may not appear in a node of the new ratchet tree') }

    const hasDuplicateKeyWithinPath = path.nodes.some((node, i) =>
        path.nodes.some((other, j) => i !== j && constantTimeEqual(node.hpkePublicKey, other.hpkePublicKey)),
    )

    if (hasDuplicateKeyWithinPath) { throw new ValidationError('Public keys in the UpdatePath must be distinct from each other') }

    const copy = tree.slice()

    copy[leafToNodeIndex(senderLeafIndex)] = { nodeType: 'leaf', leaf: path.leafNode }

    const reverseFilteredDirectPath = filteredDirectPath(senderLeafIndex, tree).reverse()

    // need to call .slice here so as not to mutate the original
    const reverseUpdatePath = path.nodes.slice().reverse()

    if (reverseUpdatePath.length !== reverseFilteredDirectPath.length) {
        throw new ValidationError('Invalid length of UpdatePath')
    }

    for (const [level, nodeIndex] of reverseFilteredDirectPath.entries()) {
        const parentHash = await calculateParentHash(copy, nodeIndex, h)

        copy[nodeIndex] = {
            nodeType: 'parent',
            parent: { hpkePublicKey: reverseUpdatePath[level]!.hpkePublicKey, unmergedLeaves: [], parentHash: parentHash[0] },
        }
    }

    const leafParentHash = await calculateParentHash(copy, leafToNodeIndex(senderLeafIndex), h)

    if (!constantTimeEqual(leafParentHash[0], path.leafNode.parentHash)) { throw new ValidationError('Parent hash did not match the UpdatePath') }

    return copy
}

export function firstCommonAncestor (tree:RatchetTree, leafIndex:LeafIndex, senderLeafIndex:LeafIndex):NodeIndex {
    const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, tree)

    for (const { nodeIndex } of fdp) {
        if (isAncestor(leafToNodeIndex(leafIndex), nodeIndex, tree.length)) {
            return nodeIndex
        }
    }

    throw new ValidationError('Could not find common ancestor')
}

export function firstMatchAncestor (
    tree:RatchetTree,
    leafIndex:LeafIndex,
    senderLeafIndex:LeafIndex,
    path:UpdatePath,
):{ nodeIndex:NodeIndex; resolution:NodeIndex[]; updateNode:UpdatePathNode | undefined } {
    const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, tree)

    for (const [n, { nodeIndex, resolution }] of fdp.entries()) {
        if (isAncestor(leafToNodeIndex(leafIndex), nodeIndex, tree.length)) {
            return { nodeIndex, resolution, updateNode: path.nodes[n] }
        }
    }

    throw new ValidationError('Could not find common ancestor')
}
