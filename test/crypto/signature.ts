import { test } from '@substrate-system/tapzero'
import { hexToBytes } from '@noble/ciphers/utils.js'
import vectors from '../../test_vectors/message-protection.json'
import {
    makeNobleSignatureImpl
} from '../../src/crypto/implementation/default/make-noble-signature-impl.js'
import {
    makeSignatureImpl
} from '../../src/crypto/implementation/default/make-signature-impl.js'
import {
    makeNobleSignatureImpl as makeNobleProviderSignatureImpl
} from '../../src/crypto/implementation/noble/make-noble-signature-impl.js'
import { UsageError, ValidationError } from '../../src/mls-error.js'

const p521Vector = vectors.find((vector) => vector.cipher_suite === 5)!

test('P-521 signatures accept a scalar without a leading zero', async (t) => {
    const signature = await makeNobleSignatureImpl('P521')
    const privateKey = hexToBytes(p521Vector.signature_priv)
    const publicKey = hexToBytes(p521Vector.signature_pub)
    const message = new TextEncoder().encode('test')

    t.equal(privateKey.length, 65, 'test vector should use a 65-byte scalar')

    const signed = await signature.sign(privateKey, message)
    const valid = await signature.verify(publicKey, message, signed)

    t.ok(valid, 'signature should verify')
})

test('WebCrypto Ed25519 keygen returns CryptoKey and Uint8Array',
    async (t) => {
        const s = await makeSignatureImpl('Ed25519')
        const { publicKey, signKey } = await s.keygen()

        t.equal(publicKey instanceof Uint8Array, true,
            'public key is Uint8Array')
        t.equal(publicKey.length, 32, 'public key is 32 bytes')
        t.equal(signKey instanceof Uint8Array, false,
            'private key is not Uint8Array')
    })

test('WebCrypto Ed25519 key is non-extractable', async (t) => {
    const s = await makeSignatureImpl('Ed25519')
    const { signKey } = await s.keygen()

    const key = signKey as CryptoKey
    t.equal(key.extractable, false, 'private key is non-extractable')
})

test('WebCrypto Ed25519 sign/verify round-trip', async (t) => {
    const s = await makeSignatureImpl('Ed25519')
    const { publicKey, signKey } = await s.keygen()
    const message = new TextEncoder().encode('test message')

    const sig = await s.sign(signKey, message)
    const valid = await s.verify(publicKey, message, sig)

    t.equal(valid, true, 'valid signature verifies')
})

test('WebCrypto Ed25519 tampered message fails verification',
    async (t) => {
        const s = await makeSignatureImpl('Ed25519')
        const { publicKey, signKey } = await s.keygen()
        const message = new TextEncoder().encode('test message')

        const sig = await s.sign(signKey, message)

        const tamperedMessage = new Uint8Array(message)
        tamperedMessage[0] ^= 0xFF
        const valid = await s.verify(publicKey, tamperedMessage, sig)

        t.equal(valid, false, 'tampered message fails verification')
    })

test('P256 still uses noble path (returns Uint8Array signKey)',
    async (t) => {
        const p = await makeSignatureImpl('P256')
        const { signKey } = await p.keygen()

        t.equal(signKey instanceof Uint8Array, true,
            'P256 returns Uint8Array signKey from noble path')
    })

test('WebCrypto Ed25519 importSignatureKey with seed',
    async (t) => {
        const { ed25519 } = await import('@noble/curves/ed25519.js')
        const s = await makeSignatureImpl('Ed25519')

        // Create a known seed
        const seed = new Uint8Array(32)
        seed.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
            17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32])

        // Derive public key from seed using noble
        const publicKey = ed25519.getPublicKey(seed)

        // Import the seed as a CryptoKey
        const signKey = await s.importSignatureKey(seed)

        // Verify it's a CryptoKey and is non-extractable
        t.ok(signKey instanceof CryptoKey,
            'importSignatureKey returns CryptoKey')
        t.equal((signKey as CryptoKey).extractable, false,
            'imported key is non-extractable')

        // Sign a message with the imported key
        const message = new TextEncoder().encode('test message for import')
        const sig = await s.sign(signKey, message)

        // Verify with public key
        const valid = await s.verify(publicKey, message, sig)
        t.equal(valid, true,
            'signature from imported key verifies with public key')
    })

test('WebCrypto Ed25519 importSignatureKey rejects a non-32-byte seed',
    async (t) => {
        const s = await makeSignatureImpl('Ed25519')

        try {
            await s.importSignatureKey(new Uint8Array(31))
            t.fail('should have thrown for a 31-byte seed')
        } catch (err) {
            t.ok(err instanceof ValidationError,
                'throws ValidationError for a short seed')
        }
    })

const pCurves = [
    { alg: 'P256', fieldLength: 32 },
    { alg: 'P384', fieldLength: 48 },
    { alg: 'P521', fieldLength: 66 },
] as const

const providers = [
    { name: 'default', make: makeSignatureImpl },
    { name: 'noble', make: makeNobleProviderSignatureImpl },
] as const

// A valid scalar whose first byte is zero: 0x00 followed by 0x01 bytes is
// well below the group order of every P-curve.
function fullLengthKeyWithLeadingZero (fieldLength:number):Uint8Array {
    const key = new Uint8Array(fieldLength).fill(1)
    key[0] = 0
    return key
}

async function nistCurve (alg:'P256'|'P384'|'P521') {
    const { p256, p384, p521 } = await import('@noble/curves/nist.js')
    return alg === 'P256' ? p256 : alg === 'P384' ? p384 : p521
}

for (const { alg, fieldLength } of pCurves) {
    for (const provider of providers) {
        test(`${alg} (${provider.name}) signs with a key trimmed of its ` +
            'leading zero', async (t) => {
            const s = await provider.make(alg)
            const full = fullLengthKeyWithLeadingZero(fieldLength)
            const publicKey = (await nistCurve(alg)).getPublicKey(full)
            const short = full.slice(1)
            const before = short.slice()
            const message = new TextEncoder().encode('short key')

            const signed = await s.sign(short, message)

            t.ok(await s.verify(publicKey, message, signed),
                'signature verifies under the full-length public key')
            t.deepEqual(short, before, "caller's key bytes are unchanged")
        })

        test(`${alg} (${provider.name}) refuses a key longer than the ` +
            'field length', async (t) => {
            const s = await provider.make(alg)
            const long = new Uint8Array(fieldLength + 1).fill(1)
            try {
                await s.sign(long, new TextEncoder().encode('long key'))
                t.fail('should have thrown for an over-long key')
            } catch (err) {
                t.ok(err instanceof UsageError,
                    'throws UsageError for an over-long key')
            }
        })

        test(`${alg} (${provider.name}) full-length keys sign and verify`,
            async (t) => {
                const s = await provider.make(alg)
                const { signKey, publicKey } = await s.keygen()
                const message = new TextEncoder().encode('full key')
                const signed = await s.sign(signKey, message)
                t.ok(await s.verify(publicKey, message, signed),
                    'signature verifies')
            })
    }
}
