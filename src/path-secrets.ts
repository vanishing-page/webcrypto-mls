import type { Kdf } from './crypto/kdf.js'
import { deriveSecret } from './crypto/kdf.js'
import { InternalError } from './mls-error.js'
import type { RatchetTree } from './ratchet-tree.js'
import { filteredDirectPathAndCopathResolution, findFirstNonBlankAncestor } from './ratchet-tree.js'
import type { LeafIndex, NodeIndex } from './treemath.js'
import { root, leafWidth } from './treemath.js'
import type { PathSecret } from './update-path.js'

/**
 * PathSecrets is a record with nodeIndex as keys and the path secret as values
 */

export type PathSecrets = Record<number, Uint8Array>

/**
 * Zeroizes every secret in a PathSecrets record in place. Call only once
 * every consumer of these secrets (deriving the commit secret, deriving
 * private keys) has already run -- the derived node/HPKE private keys are
 * what gets retained going forward, not these path secrets themselves.
 */
export function zeroPathSecrets (pathSecrets:PathSecrets):void {
    for (const secret of Object.values(pathSecrets)) secret.fill(0)
}

export function pathToPathSecrets (pathSecrets:PathSecret[]):PathSecrets {
    return pathSecrets.reduce(
        (acc, cur) => ({
            ...acc,
            [cur.nodeIndex]: cur.secret,
        }),
        {},
    )
}
export async function getCommitSecret (
    tree:RatchetTree,
    nodeIndex:NodeIndex,
    pathSecret:Uint8Array,
    kdf:Kdf,
):Promise<Uint8Array> {
    const rootIndex = root(leafWidth(tree.length))
    const path = await pathToRoot(tree, nodeIndex, pathSecret, kdf)
    const rootSecret = path[rootIndex]

    if (rootSecret === undefined) throw new InternalError('Could not find secret for root')
    return deriveSecret(rootSecret, 'path', kdf)
}

export async function pathToRoot (
    tree:RatchetTree,
    nodeIndex:NodeIndex,
    pathSecret:Uint8Array,
    kdf:Kdf,
):Promise<PathSecrets> {
    const rootIndex = root(leafWidth(tree.length))
    let currentIndex = nodeIndex
    const pathSecrets = { [nodeIndex]: pathSecret }
    while (currentIndex !== rootIndex) {
        const nextIndex = findFirstNonBlankAncestor(tree, currentIndex)
        const nextSecret = await deriveSecret(pathSecrets[currentIndex]!, 'path', kdf)

        pathSecrets[nextIndex] = nextSecret
        currentIndex = nextIndex
    }

    return pathSecrets
}

/**
 * Derives path secrets from a decrypted secret at nodeIndex up to the end
 * of the sender's filtered direct path, and returns the commit secret basis
 * (the secret at the last filtered direct path node).
 *
 * Unlike pathToRoot, which walks to the tree's geometric root via any
 * non-blank ancestor, this stops where the sender's UpdatePath stopped: the
 * sender only rotates keys for nodes whose copath resolution is non-empty
 * (filteredDirectPathAndCopathResolution), so an ancestor above that point
 * may be non-blank yet unrelated to this path (e.g. a stale key from an
 * earlier commit) and must not be folded into the derivation.
 */
export async function pathSecretsAlongFilteredPath (
    tree:RatchetTree,
    senderLeafIndex:LeafIndex,
    nodeIndex:NodeIndex,
    pathSecret:Uint8Array,
    kdf:Kdf,
):Promise<{ pathSecrets:PathSecrets; lastSecret:Uint8Array }> {
    const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, tree)
    const startIndex = fdp.findIndex((entry) => entry.nodeIndex === nodeIndex)
    if (startIndex === -1) throw new InternalError('Could not find node on filtered direct path')

    const pathSecrets:PathSecrets = { [nodeIndex]: pathSecret }
    let lastSecret = pathSecret
    for (let i = startIndex + 1; i < fdp.length; i++) {
        lastSecret = await deriveSecret(lastSecret, 'path', kdf)
        pathSecrets[fdp[i]!.nodeIndex] = lastSecret
    }

    return { pathSecrets, lastSecret }
}
