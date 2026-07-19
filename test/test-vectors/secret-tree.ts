import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/secret-tree.json'
import { expandSenderDataKey, expandSenderDataNonce } from '../../src/sender.js'
import { createSecretTree, deriveKey, deriveNonce, ratchetUntil } from '../../src/secret-tree.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { defaultKeyRetentionConfig } from '../../src/key-retention-config.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`secret-tree test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
            await testSecretTree(
                t,
                x.sender_data.sender_data_secret,
                x.sender_data.ciphertext,
                x.sender_data.key,
                x.sender_data.nonce,
                x.encryption_secret,
                x.leaves,
                impl,
            )
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

type Leaf = {
    generation:number
    handshake_key:string
    handshake_nonce:string
    application_key:string
    application_nonce:string
}

async function testSecretTree (
    t:any,
    senderSecret:string,
    ciphertext:string,
    key:string,
    nonce:string,
    encryptionSecret:string,
    leaves:Leaf[][],
    impl:CiphersuiteImpl,
) {
    // key == sender_data_key(sender_data_secret, ciphertext)
    const derivedKey = await expandSenderDataKey(impl, hexToBytes(senderSecret), hexToBytes(ciphertext))
    t.deepEqual(derivedKey, hexToBytes(key), 'derived sender data key should match expected')

    // nonce == sender_data_nonce(sender_data_secret, ciphertext)
    const derivedNonce = await expandSenderDataNonce(impl, hexToBytes(senderSecret), hexToBytes(ciphertext))
    t.deepEqual(derivedNonce, hexToBytes(nonce), 'derived sender data nonce should match expected')

    const tree = await createSecretTree(leaves.length, hexToBytes(encryptionSecret), impl.kdf)
    for (const [index, leaf] of leaves.entries()) {
        const nodeIndex = leafToNodeIndex(toLeafIndex(index))
        const handshakeSecret = tree[nodeIndex]!.handshake
        for (const gen of leaf) {
            const ratcheted = await ratchetUntil(handshakeSecret, gen.generation, defaultKeyRetentionConfig, impl.kdf)
            t.equal(ratcheted.generation, gen.generation, `ratcheted generation should match for leaf ${index}`)

            // handshake_key = handshake_ratchet_key_[i]_[generation]
            const handshakeKey = await deriveKey(ratcheted.secret, ratcheted.generation, impl)
            t.deepEqual(handshakeKey, hexToBytes(gen.handshake_key), `handshake key should match for leaf ${index} generation ${gen.generation}`)

            // handshake_nonce = handshake_ratchet_nonce_[i]_[generation]
            const handshakeNonce = await deriveNonce(ratcheted.secret, ratcheted.generation, impl)
            t.deepEqual(handshakeNonce, hexToBytes(gen.handshake_nonce), `handshake nonce should match for leaf ${index} generation ${gen.generation}`)
        }

        const applicationSecret = tree[nodeIndex]!.application
        for (const gen of leaf) {
            const ratcheted = await ratchetUntil(applicationSecret, gen.generation, defaultKeyRetentionConfig, impl.kdf)
            t.equal(ratcheted.generation, gen.generation, `ratcheted generation should match for leaf ${index}`)

            // application_key = application_ratchet_key_[i]_[generation]
            const applicationKey = await deriveKey(ratcheted.secret, ratcheted.generation, impl)
            t.deepEqual(applicationKey, hexToBytes(gen.application_key), `application key should match for leaf ${index} generation ${gen.generation}`)

            // application_nonce = application_ratchet_nonce_[i]_[generation]
            const applicationNonce = await deriveNonce(ratcheted.secret, ratcheted.generation, impl)
            t.deepEqual(applicationNonce, hexToBytes(gen.application_nonce), `application nonce should match for leaf ${index} generation ${gen.generation}`)
        }
    }
}
