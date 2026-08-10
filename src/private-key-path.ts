import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import { deriveSecret } from './crypto/kdf.js'
import { ValidationError } from './mls-error.js'
import type { PathSecrets } from './path-secrets.js'
import { pathSecretsAlongFilteredPath, zeroPathSecrets } from './path-secrets.js'
import type { RatchetTree } from './ratchet-tree.js'
import { getHpkePublicKey } from './ratchet-tree.js'
import type { LeafIndex, NodeIndex } from './treemath.js'
import { leafToNodeIndex, toLeafIndex } from './treemath.js'
import { constantTimeEqual } from './util/constant-time-compare.js'

export interface PrivateKeyPath {
    leafIndex:number
    privateKeys:Record<number, Uint8Array>
}
/**
 * Merges PrivateKeyPaths, BEWARE, if there is a conflict, this function will prioritize the second `b` parameter.
 * Any entry in `a` that is superseded by an entry in `b` at the same node index is zeroized before being
 * dropped, since the old private key is no longer reachable and must not linger in memory.
 */
export function mergePrivateKeyPaths (a:PrivateKeyPath, b:PrivateKeyPath):PrivateKeyPath {
    const privateKeys:Record<number, Uint8Array> = { ...a.privateKeys }

    for (const [key, newValue] of Object.entries(b.privateKeys)) {
        const nodeIndex = Number(key)
        const oldValue = privateKeys[nodeIndex]
        if (oldValue !== undefined && oldValue !== newValue) oldValue.fill(0)
        privateKeys[nodeIndex] = newValue
    }

    return { ...a, privateKeys }
}

/**
 * Derives the private keys a Welcome recipient can compute from the path
 * secret in its GroupSecrets (RFC 9420 SS12.4.3.1).
 *
 * `ancestorNodeIndex` is the lowest node the joiner shares with the
 * committer, which is always a node on the committer's *filtered* direct
 * path. The rest of the walk has to follow that same filtered path rather
 * than the geometric walk to the root: a node above the end of the
 * committer's filtered direct path was not rotated by this commit, so
 * folding it in either derives a key the tree does not advertise, or --
 * when the node is blank -- stores a key for a node index that is not in
 * the tree. This is the Welcome-side counterpart of `updatePrivateKeyPath`
 * in process-messages.ts, and the two must stay in step.
 */
export async function deriveWelcomePrivateKeyPath (
    tree:RatchetTree,
    committerLeafIndex:LeafIndex,
    ancestorNodeIndex:NodeIndex,
    pathSecret:Uint8Array,
    privateKeyPath:PrivateKeyPath,
    cs:CiphersuiteImpl,
):Promise<PrivateKeyPath> {
    const { pathSecrets } = await pathSecretsAlongFilteredPath(
        tree,
        committerLeafIndex,
        ancestorNodeIndex,
        pathSecret,
        cs.kdf,
    )

    // the tree here already carries the committer's advertised keys, so
    // this is where a path secret that does not derive to them is caught
    const fromPath = await toPrivateKeyPath(pathSecrets, privateKeyPath.leafIndex, cs, tree)
    zeroPathSecrets(pathSecrets)

    return pruneBlankedNodes(mergePrivateKeyPaths(fromPath, privateKeyPath), tree)
}

export function updateLeafKey (path:PrivateKeyPath, newKey:Uint8Array):PrivateKeyPath {
    return { ...path, privateKeys: { ...path.privateKeys, [leafToNodeIndex(toLeafIndex(path.leafIndex))]: newKey } }
}

/**
 * Drops and zeroizes any private key entries for node indices that are blank (undefined) in
 * `tree`, i.e. nodes a commit removed or otherwise blanked. Keeps stale HPKE private keys from
 * accumulating across epochs.
 */
export function pruneBlankedNodes (path:PrivateKeyPath, tree:RatchetTree):PrivateKeyPath {
    const privateKeys:Record<number, Uint8Array> = {}

    for (const [key, value] of Object.entries(path.privateKeys)) {
        const nodeIndex = Number(key)
        if (tree[nodeIndex] === undefined) {
            value.fill(0)
        } else {
            privateKeys[nodeIndex] = value
        }
    }

    return { ...path, privateKeys }
}

/**
 * Derives the HPKE key pair for every node in `pathSecrets`.
 *
 * Pass `verifyAgainstTree` whenever the path secrets came from someone
 * else -- an UpdatePath or a Welcome. RFC 9420 SS7.5 / SS12.4.3.1 require
 * the receiver to check that each derived public key equals the one the
 * sender advertised for that node. Without the check a malicious
 * committer can advertise keys it controls while sending a path secret
 * that derives to something else: the tree hash and the confirmation tag
 * still agree, so the epoch is accepted, and the victim is left holding a
 * private path that cannot decrypt any later commit. Nodes that are blank
 * in the tree are skipped; `pruneBlankedNodes` drops their keys anyway.
 */
export async function toPrivateKeyPath (
    pathSecrets:PathSecrets,
    leafIndex:number,
    cs:CiphersuiteImpl,
    verifyAgainstTree?:RatchetTree,
):Promise<PrivateKeyPath> {
    const asArray:[number, Uint8Array][] = await Promise.all(
        Object.entries(pathSecrets).map(async ([nodeIndex, pathSecret]) => {
            const nodeSecret = await deriveSecret(pathSecret, 'node', cs.kdf)
            const { privateKey, publicKey } = await cs.hpke.deriveKeyPair(nodeSecret)
            nodeSecret.fill(0)

            const node = verifyAgainstTree?.[Number(nodeIndex)]

            if (node !== undefined) {
                const derived = await cs.hpke.exportPublicKey(publicKey)

                if (!constantTimeEqual(derived, getHpkePublicKey(node))) {
                    throw new ValidationError(
                        'Derived public key does not match the public key ' +
                        'advertised in the ratchet tree',
                    )
                }
            }

            return [Number(nodeIndex), await cs.hpke.exportPrivateKey(privateKey)] as const
        }),
    )

    const privateKeys:Record<number, Uint8Array> = Object.fromEntries(asArray)

    return { leafIndex, privateKeys }
}
