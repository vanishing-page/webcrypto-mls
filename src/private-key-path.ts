import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import { deriveSecret } from './crypto/kdf.js'
import type { PathSecrets } from './path-secrets.js'
import type { RatchetTree } from './ratchet-tree.js'
import { leafToNodeIndex, toLeafIndex } from './treemath.js'

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

export async function toPrivateKeyPath (
    pathSecrets:PathSecrets,
    leafIndex:number,
    cs:CiphersuiteImpl,
):Promise<PrivateKeyPath> {
    const asArray:[number, Uint8Array][] = await Promise.all(
        Object.entries(pathSecrets).map(async ([nodeIndex, pathSecret]) => {
            const nodeSecret = await deriveSecret(pathSecret, 'node', cs.kdf)
            const { privateKey } = await cs.hpke.deriveKeyPair(nodeSecret)
            nodeSecret.fill(0)

            return [Number(nodeIndex), await cs.hpke.exportPrivateKey(privateKey)] as const
        }),
    )

    const privateKeys:Record<number, Uint8Array> = Object.fromEntries(asArray)

    return { leafIndex, privateKeys }
}
