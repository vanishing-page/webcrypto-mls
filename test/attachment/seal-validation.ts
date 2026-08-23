import { test } from '@substrate-system/tapzero'
import {
    startSeal,
    sealSegment,
    openSegment,
    segmentKey,
    derivedNonce,
    segmentAad,
} from '../../src/attachment/schedule.js'
import { AttachmentError } from '../../src/attachment/error.js'
import {
    fromHex,
    paramsFromVector,
    sealCryptoFromVector,
} from './helpers.js'
import { uint64be } from '../../src/attachment/kdf.js'
import F1 from '../../test_vectors/seal/core/F1.json'

// I7.2: derivedNonce must validate nonceBase.length >= 8
test('I7.2: derivedNonce rejects short nonceBase',
    t => {
        const shortBase = new Uint8Array(7)
        try {
            derivedNonce(shortBase, 0n, false)
            t.ok(false, 'should reject nonceBase < 8 bytes')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.1: sealSegment must validate nonce.length === crypto.nonceLength
test('I7.1: sealSegment rejects wrong-length nonce',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        // F1 uses random nonce mode with nonce length 12
        const shortNonce = new Uint8Array(11)
        try {
            await sealSegment(state, {
                index: 0n,
                isFinal: false,
                plaintext: new Uint8Array([1, 2, 3]),
                nonce: shortNonce,
            })
            t.ok(false, 'should reject wrong nonce length')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.1: openSegment must validate nonce.length === crypto.nonceLength
test('I7.1: openSegment rejects wrong-length nonce',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        const shortNonce = new Uint8Array(11)
        try {
            await openSegment(state, {
                index: 0n,
                isFinal: false,
                ciphertext: new Uint8Array(12),
                tag: new Uint8Array(16),
                nonce: shortNonce,
            })
            t.ok(false, 'should reject wrong nonce length')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.3: openSegment must validate tag.length === crypto.tagLength
//
// The error type alone cannot pin this guard: openSegment wraps any
// AEAD failure in an AttachmentError of its own, and an AEAD handed a
// 15-octet tag fails too. What separates the two is whether the AEAD
// runs at all, so the test counts decrypt calls and asserts on zero.
// Deleting the guard makes that count 1 and this test red.
test('I7.3: openSegment rejects a wrong-length tag before the AEAD runs',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const base = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        let decryptCalls = 0
        const sealCrypto = {
            ...base,
            aead: {
                encrypt: base.aead.encrypt,
                decrypt: (
                    key:Uint8Array,
                    nonce:Uint8Array,
                    aad:Uint8Array,
                    ct:Uint8Array,
                ) => {
                    decryptCalls++
                    return base.aead.decrypt(key, nonce, aad, ct)
                },
            },
        }

        const state = await startSeal(cek, params, g, sealCrypto)

        const nonce = new Uint8Array(12)
        crypto.getRandomValues(nonce)
        const shortTag = new Uint8Array(15)

        try {
            await openSegment(state, {
                index: 0n,
                isFinal: false,
                ciphertext: new Uint8Array(12),
                tag: shortTag,
                nonce,
            })
            t.ok(false, 'should reject wrong tag length')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
        t.equal(decryptCalls, 0, 'the AEAD is never handed a short tag')
    },
)

// I7.4: deriveSchedule must reject out-of-range numeric fields
test('I7.4: startSeal rejects out-of-range aeadId',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        // Set aeadId out of range (u16)
        const badParams = { ...params, aeadId: 0x10000 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject aeadId >= 2^16')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

test('I7.4: startSeal rejects negative aeadId',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const badParams = { ...params, aeadId: -1 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject negative aeadId')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

test('I7.4: startSeal rejects out-of-range segmentMax',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        // Set segmentMax out of range (u32)
        const badParams = { ...params, segmentMax: 0x100000000 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject segmentMax >= 2^32')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

test('I7.4: startSeal rejects out-of-range nonceMode',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        // Set nonceMode out of range (u8)
        const badParams = { ...params, nonceMode: 0x100 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject nonceMode >= 2^8')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.5: segmentKey's own guard, pinned where it is the only thing
// that throws. segmentKey is the first of the two index guards
// sealSegment reaches, but segmentAad carries an identical one right
// behind it, so removing this guard alone leaves the sealSegment and
// openSegment tests below green. Call segmentKey directly and there is
// nothing behind it: without the guard the derivation succeeds.
//
// Only the upper clause is pinnable. The `index < 0n` half is shadowed
// by uint64be, one line down, which rejects negatives itself, so no
// test can tell the two apart from outside segmentKey.
test('I7.5: segmentKey rejects an index at 2^63',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        try {
            await segmentKey(state, 1n << 63n)
            t.ok(false, 'should reject index >= 2^63')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// Reachability, not isolation: these two say an out-of-range index
// cannot get past the public seal and open entry points. Which of the
// three identical guards -- segmentKey's, segmentAad's or
// derivedNonce's -- does the throwing is deliberately not pinned here.
test('I7.5: sealSegment rejects huge segment index',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        // Index >= 2^63 would overflow in (index << 1n) | finality
        const hugeIndex = 1n << 63n

        try {
            await sealSegment(state, {
                index: hugeIndex,
                isFinal: false,
                plaintext: new Uint8Array([1, 2, 3]),
                nonce: new Uint8Array(12),
            })
            t.ok(false, 'should reject index >= 2^63')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

test('I7.5: openSegment rejects negative segment index',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        try {
            await openSegment(state, {
                index: -1n,
                isFinal: false,
                ciphertext: new Uint8Array(12),
                tag: new Uint8Array(16),
                nonce: new Uint8Array(12),
            })
            t.ok(false, 'should reject negative index')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// M-2: paddedSalt guard for overlong salt (protocol_id used as salt)
test('M-2: startSeal rejects overlong protocol_id as salt',
    async t => {
        const params = paramsFromVector(F1)
        // protocol_id is used as salt in extract(); if longer than
        // hash size (typically 32 for SHA-256), paddedSalt throws
        params.protocolId = 'this-is-an-extremely-long-protocol-id-' +
            'that-exceeds-hash-block-size-and-should-trigger'
        try {
            await startSeal(
                fromHex(F1.cek_hex),
                params,
                new Uint8Array(),
                await sealCryptoFromVector(F1),
            )
            t.ok(false, 'should reject overlong protocol_id')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.4 missing: kdfId range guard test
test('I7.4: startSeal rejects out-of-range kdfId',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const badParams = { ...params, kdfId: 0x10000 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject kdfId >= 2^16')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.4 missing: snapId range guard test
test('I7.4: startSeal rejects out-of-range snapId',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const badParams = { ...params, snapId: 0x10000 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject snapId >= 2^16')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// I7.4 missing: epochLength range guard test
test('I7.4: startSeal rejects out-of-range epochLength',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const badParams = { ...params, epochLength: 0x100 }

        try {
            await startSeal(cek, badParams, g, sealCrypto)
            t.ok(false, 'should reject epochLength >= 2^8')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// IMPORTANT 1: uint64be rejects negative values
test('IMPORTANT 1: uint64be rejects negative bigint',
    t => {
        try {
            uint64be(-1n)
            t.ok(false, 'should reject negative value')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// IMPORTANT 1: uint64be rejects over-range values
test('IMPORTANT 1: uint64be rejects over-range bigint',
    t => {
        try {
            uint64be(0x10000000000000000n)
            t.ok(false, 'should reject value >= 2^64')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// IMPORTANT 1: segmentAad rejects negative index
test('IMPORTANT 1: segmentAad rejects negative index',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        try {
            await segmentAad(state, -1n, false, new Uint8Array())
            t.ok(false, 'should reject negative index')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// IMPORTANT 1: segmentAad rejects over-range index
test('IMPORTANT 1: segmentAad rejects over-range index',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        try {
            await segmentAad(state, 1n << 63n, false, new Uint8Array())
            t.ok(false, 'should reject index >= 2^63')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)
