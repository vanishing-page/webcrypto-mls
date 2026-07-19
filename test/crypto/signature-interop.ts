import { test } from '@substrate-system/tapzero'
import { makeWebCryptoSignatureImpl } from '../../src/crypto/implementation/default/make-webcrypto-signature-impl.js'
import { makeNobleSignatureImpl } from '../../src/crypto/implementation/default/make-noble-signature-impl.js'

test('WebCrypto signature verifies with noble (AC3.1)', async (t) => {
    const wc = makeWebCryptoSignatureImpl()
    const noble = await makeNobleSignatureImpl('Ed25519')
    const message = new TextEncoder().encode('test message')

    const { publicKey, signKey } = await wc.keygen()
    const signature = await wc.sign(signKey, message)

    const valid = await noble.verify(publicKey, message, signature)
    t.equal(valid, true, 'noble should verify WebCrypto signature')
})

test('WebCrypto signature rejects tampered message (AC3.1 negative)',
    async (t) => {
        const wc = makeWebCryptoSignatureImpl()
        const noble = await makeNobleSignatureImpl('Ed25519')
        const message = new TextEncoder().encode('test message')

        const { publicKey, signKey } = await wc.keygen()
        const signature = await wc.sign(signKey, message)

        const tamperedMessage = new Uint8Array(message)
        tamperedMessage[0] ^= 0xFF

        const valid = await noble.verify(publicKey, tamperedMessage,
            signature)
        t.equal(valid, false,
            'noble should reject tampered message signed by WebCrypto')
    })

test('Noble signature verifies with WebCrypto (AC3.2)', async (t) => {
    const wc = makeWebCryptoSignatureImpl()
    const noble = await makeNobleSignatureImpl('Ed25519')
    const message = new TextEncoder().encode('test message')

    const { publicKey, signKey } = await noble.keygen()
    const signature = await noble.sign(signKey, message)

    const valid = await wc.verify(publicKey, message, signature)
    t.equal(valid, true, 'WebCrypto should verify noble signature')
})

test('Noble signature rejects tampered message (AC3.2 negative)',
    async (t) => {
        const wc = makeWebCryptoSignatureImpl()
        const noble = await makeNobleSignatureImpl('Ed25519')
        const message = new TextEncoder().encode('test message')

        const { publicKey, signKey } = await noble.keygen()
        const signature = await noble.sign(signKey, message)

        const tamperedMessage = new Uint8Array(message)
        tamperedMessage[0] ^= 0xFF

        const valid = await wc.verify(publicKey, tamperedMessage, signature)
        t.equal(valid, false,
            'WebCrypto should reject tampered message signed by noble')
    })
