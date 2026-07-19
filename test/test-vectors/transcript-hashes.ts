import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/transcript-hashes.json'
import { decodeAuthenticatedContent } from '../../src/authenticated-content.js'
import {
    createConfirmedHash,
    createInterimHash
} from '../../src/transcript-hash.js'

for (const [index, x] of json.entries()) {
    test(`transcript-hashes test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
            await testTranscriptHash(
                t,
                x.authenticated_content,
                x.confirmation_key,
                x.confirmed_transcript_hash_after,
                x.interim_transcript_hash_after,
                x.interim_transcript_hash_before,
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

async function testTranscriptHash (
    t:any,
    authenticatedContent:string,
    confirmationKey:string,
    confirmedHashAfter:string,
    interimHashAfter:string,
    interimHashBefore:string,
    impl:CiphersuiteImpl,
) {
    const auth = decodeAuthenticatedContent(hexToBytes(authenticatedContent), 0)
    if (auth === undefined || auth[0].content.contentType !== 'commit' || auth[0].auth.contentType !== 'commit') {
        throw new Error('Could not decode authenticated content')
    }

    const confirmationTag = auth[0].auth.confirmationTag

    const verified = await impl.hash.verifyMac(
        hexToBytes(confirmationKey),
        confirmationTag,
        hexToBytes(confirmedHashAfter),
    )
    t.equal(verified, true, 'confirmation tag should verify correctly')

    const input = { wireformat: auth[0].wireformat, content: auth[0].content, signature: auth[0].auth.signature }

    const computedConfirmedHash = await createConfirmedHash(hexToBytes(interimHashBefore), input, impl.hash)

    t.deepEqual(computedConfirmedHash, hexToBytes(confirmedHashAfter), 'computed confirmed hash should match expected')

    const computedInterimHash = await createInterimHash(hexToBytes(confirmedHashAfter), confirmationTag, impl.hash)
    t.deepEqual(computedInterimHash, hexToBytes(interimHashAfter), 'computed interim hash should match expected')
}
