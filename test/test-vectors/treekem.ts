import { test } from '@substrate-system/tapzero'
import type {
    CiphersuiteId,
    CiphersuiteImpl
} from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromId,
    getCiphersuiteNameFromId,
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import { decodeRatchetTree, getHpkePublicKey } from '../../src/ratchet-tree.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/treekem.json'
import type { UpdatePath } from '../../src/update-path.js'
import { applyUpdatePath, createUpdatePath, decodeUpdatePath } from '../../src/update-path.js'
import type { GroupContext } from '../../src/group-context.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import { deriveSecret } from '../../src/crypto/kdf.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { applyUpdatePathSecret } from '../../src/create-commit.js'
import type { PathSecrets } from '../../src/path-secrets.js'
import { getCommitSecret } from '../../src/path-secrets.js'
import type { PrivateKeyPath } from '../../src/private-key-path.js'
import { toPrivateKeyPath } from '../../src/private-key-path.js'
import { hpkeKeysMatch } from '../crypto/key-match.js'

// Type definitions used before defined - moved to top
interface PathSecretState {
    node:number
    path_secret:string
}

interface LeafPrivateState {
    encryption_priv:string
    signature_priv:string
    index:number
    path_secrets:PathSecretState[]
}

interface UpdatePathState {
    sender:number
    commit_secret:string
    path_secrets:(string | null)[]
    tree_hash_after:string
    update_path:string
}

interface TreeKEMState {
    cipher_suite:number
    confirmed_transcript_hash:string
    epoch:number
    group_id:string
    leaves_private:LeafPrivateState[]
    ratchet_tree:string
    update_paths:UpdatePathState[]
}

for (const [index, x] of json.entries()) {
    test(`treekem test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
            await treekemTest(t, x, impl)
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

async function treekemTest (t:any, data:TreeKEMState, impl:CiphersuiteImpl) {
    const tree = decodeRatchetTree(hexToBytes(data.ratchet_tree), 0)

    if (tree === undefined) throw new Error('could not decode tree')

    const th = await treeHashRoot(tree[0], impl.hash)

    const gc:GroupContext = {
        version: 'mls10',
        cipherSuite: getCiphersuiteNameFromId(data.cipher_suite as CiphersuiteId),
        groupId: hexToBytes(data.group_id),
        epoch: BigInt(data.epoch),
        treeHash: th,
        confirmedTranscriptHash: hexToBytes(data.confirmed_transcript_hash),
        extensions: [],
    }

    const privatePaths = await getPrivatePaths(data, impl)

    await testTreeKeys(t, data, tree, impl)

    for (const path of data.update_paths) {
        const updatePath = decodeUpdatePath(hexToBytes(path.update_path), 0)

        if (updatePath === undefined) throw new Error('could not decode updatepath')

        const updatedTree = await applyUpdatePath(tree[0], toLeafIndex(path.sender), updatePath[0], impl.hash)

        const th = await treeHashRoot(updatedTree, impl.hash)

        t.deepEqual(th, hexToBytes(path.tree_hash_after), `tree hash after update path ${path.sender} should match expected`)

        const updatedGroupContext = { ...gc, treeHash: th }

        const senderLeafState = data.leaves_private.find((lp) => lp.index === path.sender)
        if (senderLeafState === undefined) {
            throw new Error('Could not find leaf for sender')
        }
        const [t2, newUpdatePath, newSecrets] = await createUpdatePath(
            updatedTree,
            toLeafIndex(path.sender),
            updatedGroupContext,
            hexToBytes(senderLeafState.signature_priv),
            impl,
        )

        const rootSecret = newSecrets.slice().pop()!
        const newCommitSecret = await deriveSecret(rootSecret.secret, 'path', impl.kdf)
        const newGroupContext = { ...gc, treeHash: await treeHashRoot(t2, impl.hash), epoch: gc.epoch + 1n }

        for (const pp of privatePaths) {
            if (pp.leafIndex === path.sender) {
                t.equal(path.path_secrets[pp.leafIndex], null, `path secret for sender ${path.sender} should be null`)
            } else {
                await testCommitSecret(t, tree, pp, path, updatedGroupContext, updatePath[0], impl)

                await testNewUpdatePath(t, tree, pp, path, newGroupContext, newUpdatePath, impl, newCommitSecret)
            }
        }
    }
}

async function testNewUpdatePath (
    t:any,
    tree:[RatchetTree, number],
    pp:PrivateKeyPath,
    path:UpdatePathState,
    newGroupContext:GroupContext,
    newUpdatePath:UpdatePath,
    impl:CiphersuiteImpl,
    newCommitSecret:Uint8Array,
) {
    const secret = await applyUpdatePathSecret(
        tree[0],
        pp,
        toLeafIndex(path.sender),
        newGroupContext,
        newUpdatePath,
        [],
        impl,
    )

    const commitSecret = await getCommitSecret(tree[0], secret.nodeIndex, secret.pathSecret, impl.kdf)

    t.deepEqual(commitSecret, newCommitSecret, 'commit secret for new update path should match expected')
}

async function testCommitSecret (
    t:any,
    tree:[RatchetTree, number],
    pp:PrivateKeyPath,
    path:UpdatePathState,
    updatedGroupContext:GroupContext,
    updatePath:UpdatePath,
    impl:CiphersuiteImpl,
) {
    const privateP = await applyUpdatePathSecret(
        tree[0],
        pp,
        toLeafIndex(path.sender),
        updatedGroupContext,
        updatePath,
        [],
        impl,
    )

    t.deepEqual(privateP.pathSecret, hexToBytes(path.path_secrets[pp.leafIndex]!), `path secret for leaf ${pp.leafIndex} should match expected`)

    const commitSecret = await getCommitSecret(tree[0], privateP.nodeIndex, privateP.pathSecret, impl.kdf)

    t.deepEqual(commitSecret, hexToBytes(path.commit_secret), 'commit secret should match expected')
}

async function getPrivatePaths (data:TreeKEMState, impl:CiphersuiteImpl):Promise<PrivateKeyPath[]> {
    return await Promise.all(
        data.leaves_private.map(async (leaf) => {
            const nodeSecrets:PathSecrets = leaf.path_secrets.reduce(
                (acc, ps) => ({ ...acc, [ps.node]: hexToBytes(ps.path_secret) }),
                {},
            )

            const pks = await toPrivateKeyPath(nodeSecrets, leaf.index, impl)

            return {
                ...pks,
                privateKeys: {
                    ...pks.privateKeys,
                    [leafToNodeIndex(toLeafIndex(leaf.index))]: hexToBytes(leaf.encryption_priv),
                },
            }
        }),
    )
}

async function testTreeKeys (t:any, data:TreeKEMState, tree:[RatchetTree, number], impl:CiphersuiteImpl) {
    for (const leaf of data.leaves_private) {
        const nodeSecrets:PathSecrets = leaf.path_secrets.reduce(
            (acc, ps) => ({ ...acc, [ps.node]: hexToBytes(ps.path_secret) }),
            {},
        )

        const node = tree[0][leafToNodeIndex(toLeafIndex(leaf.index))]
        if (node === undefined || node.nodeType === 'parent') throw new Error('No leaf found at leaf index')

        t.equal(await hpkeKeysMatch(node.leaf.hpkePublicKey, hexToBytes(leaf.encryption_priv), impl.hpke), true, `hpke keys should match for leaf ${leaf.index}`)

        for (const [nodeIndex, pathSecret] of Object.entries(nodeSecrets)) {
            const s = await deriveSecret(pathSecret, 'node', impl.kdf)
            const { publicKey } = await impl.hpke.deriveKeyPair(s)

            const node = tree[0][Number(nodeIndex)]
            if (node === undefined) throw new Error('No node found at node index')

            t.deepEqual(getHpkePublicKey(node), await impl.hpke.exportPublicKey(publicKey), `public key at node ${nodeIndex} should match expected`)
        }
    }
}
