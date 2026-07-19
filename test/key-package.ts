import { test } from '@substrate-system/tapzero'
import { getCiphersuiteFromName } from '../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../src/key-package.js'
import { UsageError } from '../src/mls-error.js'
import { defaultLifetime } from '../src/lifetime.js'
import { defaultCapabilities } from '../src/default-capabilities.js'

// Test helper to create a credential
function makeCredential (name:string) {
    return {
        credentialType: 'basic' as const,
        identity: new TextEncoder().encode(name),
    }
}

test(
    'bring-your-own Ed25519 signatureKeyPair: AC2.1 - privateKey stored as-is',
    async (t) => {
        const csImpl = await getCipherSuite(getCiphersuiteFromName(
            'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
        ))

        // Create a non-extractable Ed25519 CryptoKeyPair
        const pair = await globalThis.crypto.subtle.generateKey(
            { name: 'Ed25519' },
            false,
            ['sign', 'verify'],
        ) as CryptoKeyPair

        const credential = makeCredential('test-user')
        const { privatePackage } = await generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime,
            [],
            csImpl,
            { signatureKeyPair: pair },
        )

        // AC2.1: signaturePrivateKey should be identical to pair.privateKey
        t.equal(
            privatePackage.signaturePrivateKey,
            pair.privateKey,
            'privateKey should be identical reference'
        )

        // Also verify it's non-extractable
        t.equal(
            (pair.privateKey as CryptoKey).extractable,
            false,
            'private key should be non-extractable'
        )
    }
)

test(
    'bring-your-own Ed25519 signatureKeyPair: AC2.2 - ' +
        'leafNode.signaturePublicKey matches raw export',
    async (t) => {
        const csImpl = await getCipherSuite(getCiphersuiteFromName(
            'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
        ))

        // Create a non-extractable Ed25519 CryptoKeyPair
        const pair = await globalThis.crypto.subtle.generateKey(
            { name: 'Ed25519' },
            false,
            ['sign', 'verify'],
        ) as CryptoKeyPair

        const credential = makeCredential('test-user-2')
        const { publicPackage } = await generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime,
            [],
            csImpl,
            { signatureKeyPair: pair },
        )

        // AC2.2: leafNode.signaturePublicKey should equal raw export
        const expectedPublicKey = new Uint8Array(
            await globalThis.crypto.subtle.exportKey('raw', pair.publicKey)
        )

        t.deepEqual(
            publicPackage.leafNode.signaturePublicKey,
            expectedPublicKey,
            'leafNode.signaturePublicKey should deep-equal raw export'
        )
    }
)

test(
    'bring-your-own signatureKeyPair: AC2.3 - ' +
        'non-Ed25519 ciphersuite throws UsageError',
    async (t) => {
        const csImpl = await getCipherSuite(getCiphersuiteFromName(
            'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
        ))

        // Create an Ed25519 CryptoKeyPair
        const pair = await globalThis.crypto.subtle.generateKey(
            { name: 'Ed25519' },
            false,
            ['sign', 'verify'],
        ) as CryptoKeyPair

        const credential = makeCredential('test-user-3')

        let errorThrown = false
        let thrownError:unknown = null
        try {
            await generateKeyPackage(
                credential,
                defaultCapabilities(),
                defaultLifetime,
                [],
                csImpl,
                { signatureKeyPair: pair },
            )
        } catch (err) {
            errorThrown = true
            thrownError = err
        }

        t.ok(
            errorThrown,
            'should throw when using Ed25519 pair with P256 ciphersuite'
        )

        t.ok(
            thrownError instanceof UsageError,
            'thrown error should be an instance of UsageError'
        )

        t.ok(
            thrownError instanceof UsageError &&
                thrownError.message.includes(
                    'signatureKeyPair is only supported for Ed25519'
                ),
            'error message should mention Ed25519 requirement'
        )
    }
)
