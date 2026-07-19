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
import type { GroupContext } from '../../src/group-context.js'
import { encodeGroupContext } from '../../src/group-context.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/key-schedule.json'

import { initializeEpoch, mlsExporter } from '../../src/key-schedule.js'

// Type definitions used before defined - moved to top
type Exporter = {
    context:string
    label:string
    length:number
    secret:string
}

type Epoch = {
    commit_secret:string
    confirmation_key:string
    confirmed_transcript_hash:string
    encryption_secret:string
    epoch_authenticator:string
    exporter:Exporter
    exporter_secret:string
    external_pub:string
    external_secret:string
    group_context:string
    init_secret:string
    joiner_secret:string
    membership_key:string
    psk_secret:string
    resumption_psk:string
    sender_data_secret:string
    tree_hash:string
    welcome_secret:string
}

for (const [index, x] of json.entries()) {
    test(`key-schedule test vectors ${index}`, async (t) => {
        try {
            const cipherSuite = x.cipher_suite as CiphersuiteId
            const impl = await getCipherSuite(getCiphersuiteFromId(cipherSuite))
            await testKeySchedule(t, x.group_id, x.initial_init_secret, x.epochs, cipherSuite, impl)
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

async function testKeySchedule (
    t:any,
    groupId:string,
    initialInitSecret:string,
    epochs:Epoch[],
    cipherSuite:CiphersuiteId,
    impl:CiphersuiteImpl,
) {
    await epochs.reduce(
        async (prevInitSecret, epoch, index) => {
            const initSecret = await prevInitSecret

            const gc:GroupContext = {
                version: 'mls10',
                cipherSuite: getCiphersuiteNameFromId(cipherSuite),
                groupId: hexToBytes(groupId),
                epoch: BigInt(index),
                treeHash: hexToBytes(epoch.tree_hash),
                confirmedTranscriptHash: hexToBytes(epoch.confirmed_transcript_hash),
                extensions: [],
            }

            // Verify that group context matches the provided group_context value
            t.deepEqual(encodeGroupContext(gc), hexToBytes(epoch.group_context), 'group context should match expected')

            const { keySchedule, joinerSecret, welcomeSecret } = await initializeEpoch(
                initSecret,
                hexToBytes(epoch.commit_secret),
                gc,
                hexToBytes(epoch.psk_secret),
                impl.kdf,
            )

            t.deepEqual(joinerSecret, hexToBytes(epoch.joiner_secret), 'joiner secret should match expected')
            t.deepEqual(welcomeSecret, hexToBytes(epoch.welcome_secret), 'welcome secret should match expected')
            t.deepEqual(keySchedule.initSecret, hexToBytes(epoch.init_secret), 'init secret should match expected')
            t.deepEqual(keySchedule.senderDataSecret, hexToBytes(epoch.sender_data_secret), 'sender data secret should match expected')
            t.deepEqual(keySchedule.encryptionSecret, hexToBytes(epoch.encryption_secret), 'encryption secret should match expected')
            t.deepEqual(keySchedule.exporterSecret, hexToBytes(epoch.exporter_secret), 'exporter secret should match expected')
            t.deepEqual(keySchedule.externalSecret, hexToBytes(epoch.external_secret), 'external secret should match expected')
            t.deepEqual(keySchedule.confirmationKey, hexToBytes(epoch.confirmation_key), 'confirmation key should match expected')
            t.deepEqual(keySchedule.membershipKey, hexToBytes(epoch.membership_key), 'membership key should match expected')
            t.deepEqual(keySchedule.resumptionPsk, hexToBytes(epoch.resumption_psk), 'resumption psk should match expected')
            t.deepEqual(keySchedule.epochAuthenticator, hexToBytes(epoch.epoch_authenticator), 'epoch authenticator should match expected')

            // Verify the external_pub is the public key output from KEM.DeriveKeyPair(external_secret)
            const { publicKey } = await impl.hpke.deriveKeyPair(hexToBytes(epoch.external_secret))
            t.deepEqual(await impl.hpke.exportPublicKey(publicKey), hexToBytes(epoch.external_pub), 'external public key should match expected')

            // Verify the exporter.secret is the value output from MLS-Exporter(exporter.label, exporter.context, exporter.length)
            const exporter = await mlsExporter(
                keySchedule.exporterSecret,
                epoch.exporter.label,
                hexToBytes(epoch.exporter.context),
                epoch.exporter.length,
                impl,
            )
            t.deepEqual(exporter, hexToBytes(epoch.exporter.secret), 'exporter secret should match expected')

            return keySchedule.initSecret
        },
        Promise.resolve(hexToBytes(initialInitSecret)),
    )
}
