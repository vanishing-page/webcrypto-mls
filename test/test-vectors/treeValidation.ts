import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { decodeRatchetTree, resolution } from '../../src/ratchetTree.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/tree-validation.json'
import { treeHash } from '../../src/treeHash.js'
import { verifyLeafNodeSignature } from '../../src/leafNode.js'
import { nodeToLeafIndex, toNodeIndex } from '../../src/treemath.js'
import { verifyParentHashes } from '../../src/parentHash.js'

for (const [index, x] of json.entries()) {
    test(`tree-validation test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await treeOperationsTest(t, x, impl)
    })
}

type TreeValidationData = {
  tree: string
  group_id: string
  tree_hashes: string[]
  resolutions: number[][]
}

async function treeOperationsTest (t: any, data: TreeValidationData, impl: CiphersuiteImpl) {
    const tree = decodeRatchetTree(hexToBytes(data.tree), 0)

    if (tree === undefined) throw new Error('could not decode tree')

    for (const [i, h] of data.tree_hashes.entries()) {
        const hash = await treeHash(tree[0], toNodeIndex(i), impl.hash)
        t.deepEqual(hash, hexToBytes(h), `tree hash at index ${i} should match expected`)
    }

    for (const [i, r] of data.resolutions.entries()) {
        const reso = resolution(tree[0], toNodeIndex(i))
        t.deepEqual(reso, r, `resolution at index ${i} should match expected`)
    }

    t.equal(await verifyParentHashes(tree[0], impl.hash), true, 'parent hashes should verify correctly')

    for (const [i, n] of tree[0].entries()) {
        if (n !== undefined) {
            if (n.nodeType === 'leaf') {
                t.equal(
                    await verifyLeafNodeSignature(
                        n.leaf,
                        hexToBytes(data.group_id),
                        nodeToLeafIndex(toNodeIndex(i)),
                        impl.signature,
                    ),
                    true,
                    `leaf node signature at index ${i} should verify correctly`,
                )
            }
        }
    }
}
