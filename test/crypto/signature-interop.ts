import { test } from '@substrate-system/tapzero'
import { makeWebCryptoSignatureImpl } from '../../src/crypto/implementation/default/make-webcrypto-signature-impl.js'
import { makeNobleSignatureImpl } from '../../src/crypto/implementation/default/make-noble-signature-impl.js'
import { verifyWithLabel } from '../../src/crypto/signature.js'

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

// RFC 8032 5.1.7 decodes R strictly: a y coordinate >= p is not a point.
// y = p + 1 is the identity written non-canonically, so a cofactored
// (zip215) verifier accepts it where a strict one refuses it.
const P_PLUS_ONE = (() => {
    const b = new Uint8Array(32).fill(0xff)
    b[0] = 0xee
    b[31] = 0x7f
    return b
})()

// The canonical encoding of the Ed25519 identity point (y = 1).
const IDENTITY = (() => {
    const b = new Uint8Array(32)
    b[0] = 1
    return b
})()

async function verifyBoth (
    publicKey:Uint8Array,
    signature:Uint8Array,
):Promise<[boolean, boolean]> {
    const wc = makeWebCryptoSignatureImpl()
    const noble = await makeNobleSignatureImpl('Ed25519')
    const content = new TextEncoder().encode('any content')
    const run = async (s:typeof wc) => {
        try {
            return await verifyWithLabel(publicKey, 'LeafNodeTBS',
                content, signature, s)
        } catch (_err) {
            return false
        }
    }
    return [await run(wc), await run(noble)]
}

test('Providers agree on a non-canonical R (M4)', async (t) => {
    // canonical key (encoding-wise), non-canonical R, S = 0
    const sig = new Uint8Array(64)
    sig.set(P_PLUS_ONE, 0)
    const [wc, noble] = await verifyBoth(IDENTITY, sig)
    t.equal(wc, false, 'WebCrypto rejects a non-canonical R')
    t.equal(noble, false, 'noble rejects a non-canonical R')
})

test('Providers reject the identity key universal forgery (M4)',
    async (t) => {
        // R = identity, S = 0
        const sig = new Uint8Array(64)
        sig.set(IDENTITY, 0)
        const [wc, noble] = await verifyBoth(IDENTITY, sig)
        t.equal(wc, false, 'WebCrypto rejects the identity key')
        t.equal(noble, false, 'noble rejects the identity key')
    })
