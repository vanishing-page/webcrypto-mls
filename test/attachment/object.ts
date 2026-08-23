import { test } from '@substrate-system/tapzero'
import { sealObject, openObject } from
    '../../src/attachment/object.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { sealCryptoFromIds } from
    '../../src/attachment/crypto.js'
import { layout } from '../../src/attachment/layout.js'
import { toHex, fromHex } from './helpers.js'
import epochTreeVector from
    '../../test_vectors/seal/own/epoch-tree.json'

// Helper to create standard test setup (CEK, objectId, crypto, plaintext)
// reused by tamper tests to eliminate duplication
async function createStandardTamperSetup () {
    const cek = new Uint8Array(32).fill(0xAA)
    const objectId = new TextEncoder().encode('test-object')
    const crypto = await sealCryptoFromIds(2, 1)

    const plaintext = new Uint8Array(131089)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    return { cek, objectId, crypto, plaintext }
}

// AC2.1: Seal and open round-trip with correct bytes and length
test(
    'AC2.1 object: sealObject then openObject round-trips ' +
    'identical plaintext',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('test-object')
        const crypto = await sealCryptoFromIds(2, 1)

        // Deterministic plaintext: 3 segments
        // (2 * 65536) + 17 = 131089 bytes
        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Layout should indicate 3 segments
            // (plaintext 131089 / segment_max 65536 = 2.something, ceil = 3)
            // totalSize should match bytes.length
            const expectedLayout = layout({
                plaintextLength: plaintext.length,
                segmentMax: 65536,
                epochLength: 10,
                nh: crypto.kdf.size,
            })
            t.equal(
                sealed.bytes.length,
                expectedLayout.totalSize,
                'sealed bytes match layout.totalSize',
            )

            // Verify round-trip
            const ref1 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            const recovered = await openObject(
                cek, objectId, sealed.bytes, ref1, crypto,
            )

            t.equal(
                toHex(recovered),
                toHex(plaintext),
                'recovered plaintext matches original',
            )

            t.equal(
                recovered.length,
                plaintext.length,
                'recovered length matches original',
            )
        } catch (err) {
            t.ok(false, `sealObject/openObject failed: ${err}`)
        }
    },
)

// AC2.2: Detect dropping final segment
test(
    'AC2.2 object: truncating bytes rejects with length mismatch',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Truncate bytes to remove last block
        const lastBlockLength = plaintext.length % 65536 || 65536
        const truncated = sealed.bytes.slice(0, sealed.bytes.length -
            lastBlockLength)

        try {
            const ref2 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, truncated, ref2, crypto)
            t.fail('should reject truncated bytes')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect zero-filling final block
test(
    'AC2.2 object: zeroing final block rejects with leaf mismatch',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Tamper: zero the final block
        const tampered = sealed.bytes.slice()
        // First block at 65536, block 1 at 131072, block 2 (final) at 196608
        const lastBlockStart = 196608
        tampered.fill(0, lastBlockStart, lastBlockStart + 17)

        try {
            const ref3 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref3, crypto)
            t.fail('should reject tampered block')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect reordering segments
test(
    'AC2.2 object: reordering blocks rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Swap block 0 @65536-131072 with block 1 @131072-196608
        const tampered = sealed.bytes.slice()
        const block0 = tampered.slice(65536, 131072)
        const block1 = tampered.slice(131072, 196608)
        block1.forEach((byte, i) => { tampered[65536 + i] = byte })
        block0.forEach((byte, i) => { tampered[131072 + i] = byte })

        try {
            const ref4 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref4, crypto)
            t.fail('should reject reordered blocks')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect cross-object substitution
test(
    'AC2.2 object: block from different object rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt1 = new Uint8Array(32).fill(0x04)
        const salt2 = new Uint8Array(32).fill(0x05)

        let sealed1, sealed2
        try {
            sealed1 = await sealObject(
                cek, objectId, plaintext, crypto, { salt: salt1 },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        try {
            sealed2 = await sealObject(
                cek, objectId, plaintext, crypto, { salt: salt2 },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Substitute block 0 @65536-131072 from sealed2 into sealed1
        const tampered = sealed1.bytes.slice()
        tampered.set(
            sealed2.bytes.slice(65536, 131072),
            65536,
        )

        try {
            const ref5 = {
                snapshot: sealed1.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref5, crypto)
            t.fail('should reject cross-object substitution')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect bit flips in block
test(
    'AC2.2 object: bit flip in block rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Flip one bit in block 0
        const tampered = sealed.bytes.slice()
        tampered[65536] ^= 0x01

        try {
            const ref6 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref6, crypto)
            t.fail('should reject bit flip')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect bit flip in epoch head
test(
    'AC2.2 object: bit flip in epoch head rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Flip one bit in epoch head (at offset 96)
        const tampered = sealed.bytes.slice()
        // Salt: 32, commitment: 32, snapshot: 32 = 96 bytes, epoch heads
        tampered[96] ^= 0x01

        try {
            const ref7 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref7, crypto)
            t.fail('should reject epoch head bit flip')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect bit flip in metadata leaf
test(
    'AC2.2 object: bit flip in metadata rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Flip one bit in metadata (after salt+commitment+snapshot+epoch heads)
        const tampered = sealed.bytes.slice()
        // Metadata starts at offset 128
        tampered[128] ^= 0x01

        try {
            const ref8 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref8, crypto)
            t.fail('should reject metadata bit flip')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect bit flip in stored snapshot field
test(
    'AC2.2 object: bit flip in stored snapshot rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Flip one bit in stored snapshot field (at offset 64)
        const tampered = sealed.bytes.slice()
        // Salt: 32, commitment: 32 = 64 bytes, snapshot starts
        tampered[64] ^= 0x01

        try {
            const ref9 = {
                snapshot: sealed.snapshot,
                plaintextLength: plaintext.length,
            }
            await openObject(cek, objectId, tampered, ref9, crypto)
            t.fail('should reject stored snapshot bit flip')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Detect wrong ref snapshot
test(
    'AC2.2 object: wrong ref snapshot rejects',
    async t => {
        const { cek, objectId, crypto, plaintext } =
            await createStandardTamperSetup()
        const salt = new Uint8Array(32).fill(0x04)

        let sealed
        try {
            sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )
        } catch (err) {
            t.ok(false, `seal failed: ${err}`)
            return
        }

        // Flip a byte in ref.snapshot
        const wrongSnapshot = sealed.snapshot.slice()
        wrongSnapshot[0] ^= 0x01

        try {
            await openObject(
                cek, objectId, sealed.bytes,
                { snapshot: wrongSnapshot, plaintextLength: plaintext.length },
                crypto,
            )
            t.fail('should reject wrong ref snapshot')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Reject empty plaintext
test(
    'AC2.2 object: empty plaintext rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const objectId = new TextEncoder().encode('test-object')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array()

        try {
            await sealObject(cek, objectId, plaintext, crypto)
            t.fail('should reject empty plaintext')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Reject empty objectId
test(
    'AC2.2 object: empty objectId rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const objectId = new Uint8Array()
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(100)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            await sealObject(cek, objectId, plaintext, crypto)
            t.fail('should reject empty objectId')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC2.2: Reject oversized objectId
test(
    'AC2.2 object: oversized objectId rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const objectId = new Uint8Array(256)
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(100)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            await sealObject(cek, objectId, plaintext, crypto)
            t.fail('should reject oversized objectId')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError',
            )
        }
    },
)

// AC3.1: sealObject uses pluggable RNG for salt generation
test(
    'AC3.1 object: sealObject uses supplied RNG for salt',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const objectId = new TextEncoder().encode('test-object')
        const plaintext = new Uint8Array(100)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Create a stub RNG that returns a predictable pattern
        let rngCalled = false
        const stubRng = {
            randomBytes (n:number) {
                rngCalled = true
                const result = new Uint8Array(n)
                for (let i = 0; i < n; i++) {
                    result[i] = (i + 1) % 256
                }
                return result
            },
        }

        // Build crypto bundle with stub RNG
        const baseCrypto = await sealCryptoFromIds(2, 1)
        const cryptoWithStubRng = { ...baseCrypto, rng: stubRng }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, cryptoWithStubRng,
            )

            // Verify that the RNG was called
            t.ok(rngCalled, 'RNG was called')

            // Verify that the salt in the sealed object matches
            // the stub's output (0x01, 0x02, 0x03, ... for 32 bytes)
            const expectedSalt = new Uint8Array(32)
            for (let i = 0; i < 32; i++) {
                expectedSalt[i] = (i + 1) % 256
            }
            t.equal(
                toHex(sealed.salt),
                toHex(expectedSalt),
                'salt matches stub RNG output',
            )
        } catch (err) {
            t.ok(false, `sealObject failed: ${err}`)
        }
    },
)

// AC3.1: opts.salt override still works and RNG is not called
test(
    'AC3.1 object: opts.salt override prevents RNG call',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const objectId = new TextEncoder().encode('test-object')
        const plaintext = new Uint8Array(100)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Create a stub RNG that we expect NOT to be called
        let rngCalled = false
        const stubRng = {
            randomBytes (n:number) {
                rngCalled = true
                return new Uint8Array(n)
            },
        }

        // Supply explicit salt via opts
        const explicitSalt = new Uint8Array(32).fill(0x42)

        // Build crypto bundle with stub RNG
        const baseCrypto = await sealCryptoFromIds(2, 1)
        const cryptoWithStubRng = { ...baseCrypto, rng: stubRng }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, cryptoWithStubRng,
                { salt: explicitSalt },
            )

            // Verify that the RNG was NOT called
            t.ok(!rngCalled, 'RNG was not called')

            // Verify that the salt in the sealed object matches
            // the supplied salt, not a RNG-generated one
            t.equal(
                toHex(sealed.salt),
                toHex(explicitSalt),
                'salt matches explicit override',
            )
        } catch (err) {
            t.ok(false, `sealObject failed: ${err}`)
        }
    },
)

// Frozen regression test against own-generated vector
test(
    'object: epoch-tree own vector (frozen regression test)',
    async t => {
        const cek = fromHex(epochTreeVector.cek_hex)
        const salt = fromHex(epochTreeVector.salt_hex)
        const objectId = fromHex(epochTreeVector.object_id_hex)
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(epochTreeVector.plaintext_length)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Extract commitment and compute SHA-256
            const commitment = sealed.bytes.slice(32, 64)
            const digest = await crypto.hash.digest(sealed.bytes)

            // Verify against frozen vector
            t.equal(
                toHex(commitment),
                epochTreeVector.commitment_hex,
                'commitment matches frozen vector',
            )

            t.equal(
                toHex(sealed.snapshot),
                epochTreeVector.snapshot_hex,
                'snapshot matches frozen vector',
            )

            t.equal(
                toHex(digest),
                epochTreeVector.object_sha256_hex,
                'object SHA-256 matches frozen vector',
            )
        } catch (err) {
            t.ok(false, `sealObject failed: ${err}`)
        }
    },
)
