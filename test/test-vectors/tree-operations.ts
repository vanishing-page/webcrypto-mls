import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import {
    addLeafNode,
    decodeRatchetTree,
    encodeRatchetTree,
    removeLeafNode,
    updateLeafNode,
} from '../../src/ratchet-tree.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/tree-operations.json'
import type { Proposal } from '../../src/proposal.js'
import { decodeProposal } from '../../src/proposal.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import { toLeafIndex } from '../../src/treemath.js'

// How can there be a proposal with leaf_node_source = key_package in the test vectors?
// https://github.com/mlswg/mls-implementations/issues/195
const filteredJson = json.filter((_n, idx) => idx !== 2)

for (const [index, x] of filteredJson.entries()) {
    test(`tree-operations test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
            await treeOperationsTest(t, x, impl)
        } catch (error:any) {
        // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError' || error?.name === 'CryptoError' || error?.name === 'DeriveKeyPairError' || error?.message?.includes('SubtleCrypto') || error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping: ${error.message}`)
                return
            }
            throw error
        }
    })
}

type TreeOperationData = {
    proposal:string
    proposal_sender:number
    tree_after:string
    tree_before:string
    tree_hash_after:string
    tree_hash_before:string
}

async function treeOperationsTest (t:any, data:TreeOperationData, impl:CiphersuiteImpl) {
    const tree = decodeRatchetTree(hexToBytes(data.tree_before), 0)

    if (tree === undefined) throw new Error('could not decode tree')

    const hash = await treeHashRoot(tree[0], impl.hash)
    t.deepEqual(hash, hexToBytes(data.tree_hash_before), 'tree hash before should match expected')

    const proposal = decodeProposal(hexToBytes(data.proposal), 0)
    if (proposal === undefined) throw new Error('could not decode proposal')

    const treeAfter = applyProposal(proposal[0], tree[0], data)

    if (treeAfter === undefined) throw new Error('Could not apply proposal: ' + proposal[0].proposalType)

    t.deepEqual(encodeRatchetTree(treeAfter), hexToBytes(data.tree_after), 'tree after should match expected')

    const hashAfter = await treeHashRoot(treeAfter!, impl.hash)
    t.deepEqual(hashAfter, hexToBytes(data.tree_hash_after), 'tree hash after should match expected')
}

function applyProposal (proposal:Proposal, tree:RatchetTree, data:TreeOperationData) {
    switch (proposal.proposalType) {
        case 'add':
            return addLeafNode(tree, proposal.add.keyPackage.leafNode)[0]
        case 'update':
            return updateLeafNode(tree, proposal.update.leafNode, toLeafIndex(data.proposal_sender))
        case 'remove':
            return removeLeafNode(tree, toLeafIndex(proposal.remove.removed))
        case 'psk':
        case 'reinit':
        case 'external_init':
        case 'group_context_extensions':
    }
}
