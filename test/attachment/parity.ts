import { test } from '@substrate-system/tapzero'
import {
    sealObject, openObject,
} from '../../src/attachment/object.js'
import {
    decryptAttachmentStream,
} from '../../src/attachment/reader.js'
import {
    openAttachmentRange,
} from '../../src/attachment/range.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import {
    buildRef, buildLayout,
} from './attachment-fixtures.js'
import {
    blockRange, metaRange,
} from '../../src/attachment/layout.js'
import {
    chunked, drainStream,
} from './stream-helpers.js'
import type { AttachmentRef } from '../../src/attachment/reference.js'

/**
 * Run the range path over `bytes` and report whether it accepted.
 *
 * The streams handed to decrypt() are cut from the same buffer the
 * other two paths are given, so a tamper the object and stream paths
 * see is a tamper this path sees -- as long as the mutated offset
 * falls inside a fetched range. That is the point of the sweep: an
 * offset the range path declines to fetch is an offset it cannot
 * check, and the disagreement shows up as a failure here.
 */
async function rangeAccepts (
    cek:Uint8Array,
    ref:AttachmentRef,
    bytes:Uint8Array,
    crypto:SealCrypto,
    range:{ offset:number, length:number },
):Promise<boolean> {
    const read = await openAttachmentRange(cek, ref, range, crypto)
    try {
        const streams = read.ranges.map(r => chunked(
            bytes.slice(r.offset, r.offset + r.length), 8192,
        ))
        await drainStream(read.decrypt(streams))
        return true
    } catch (err) {
        if (!(err instanceof AttachmentError)) throw err
        return false
    } finally {
        read.close()
    }
}

// Tests for input validation parity between openObject and the
// streaming reader. Both paths must agree on which inputs are valid.

/**
 * Wrap a bundle so kdf.expand calls can be counted.
 *
 * Asserting AttachmentError alone does not pin openObject's objectId
 * guard: an out-of-range objectId fails the commitment comparison
 * anyway, so the same error type comes back whether the guard is there
 * or not. The property that distinguishes them is the one the plan
 * asks for -- the guard sits before startOpen, so a rejected input
 * derives NO key material. Zero expands means the guard rejected it;
 * a non-zero count means execution reached the schedule.
 */
function countingKdf (crypto:SealCrypto):{
    crypto:SealCrypto
    expands:() => number
} {
    let n = 0
    const wrapped:SealCrypto = {
        ...crypto,
        kdf: {
            ...crypto.kdf,
            expand: async (
                prk:Uint8Array, info:Uint8Array, len:number,
            ):Promise<Uint8Array> => {
                n++
                return crypto.kdf.expand(prk, info, len)
            },
        },
    }
    return { crypto: wrapped, expands: () => n }
}

test('openObject rejects zero-length objectId (NEW)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xAA)
    const plaintext = new Uint8Array(1000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    // Seal with a valid objectId
    const validObjectId = new TextEncoder().encode('valid')
    const sealed = await sealObject(
        cek,
        validObjectId,
        plaintext,
        crypto
    )

    // Try to open with zero-length objectId
    const zeroId = new Uint8Array(0)
    const counted = countingKdf(crypto)
    try {
        await openObject(cek, zeroId, sealed.bytes, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, counted.crypto)
        t.ok(false, 'should reject zero-length objectId')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects zero-length objectId'
        )
        t.equal(
            counted.expands(), 0,
            'rejected before deriving any key material'
        )
    }

    // Positive control. countingKdf wraps expand only, so if key
    // derivation ever moved to another entry point the counter would
    // read zero for the wrong reason and the assertion above would go
    // vacuous -- the exact failure this helper was written to fix.
    // A valid open through the same wrapper must count something.
    const control = countingKdf(crypto)
    await openObject(cek, validObjectId, sealed.bytes, {
        snapshot: sealed.snapshot,
        plaintextLength: plaintext.length,
    }, control.crypto)
    t.ok(
        control.expands() > 0,
        'the counter observes derivation on a valid open'
    )
})

test('streaming reader rejects zero-length' +
    ' objectId (parity)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xBB)
    const plaintext = new Uint8Array(1000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    // Seal with a valid objectId
    const validObjectId = new TextEncoder().encode('valid')
    const sealed = await sealObject(
        cek,
        validObjectId,
        plaintext,
        crypto
    )

    // Try to stream with zero-length objectId
    const zeroId = new Uint8Array(0)
    const ref = buildRef(plaintext, zeroId, sealed)

    try {
        const stream = decryptAttachmentStream(
            cek,
            ref,
            chunked(sealed.bytes, 8192),
            crypto,
        )
        await drainStream(stream)
        t.ok(false, 'should reject zero-length objectId')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects zero-length objectId'
        )
    }
})

test('openObject rejects objectId > 255 octets' +
    ' (NEW)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xCC)
    const plaintext = new Uint8Array(1000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    // Seal with a valid objectId
    const validObjectId = new TextEncoder().encode('valid')
    const sealed = await sealObject(
        cek,
        validObjectId,
        plaintext,
        crypto
    )

    // Try to open with oversized objectId (256 bytes)
    const oversized = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
        oversized[i] = i % 256
    }

    const counted = countingKdf(crypto)
    try {
        await openObject(cek, oversized, sealed.bytes, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, counted.crypto)
        t.ok(false, 'should reject oversized objectId')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects objectId > 255 octets'
        )
        t.equal(
            counted.expands(), 0,
            'rejected before deriving any key material'
        )
    }
})

test('streaming reader rejects objectId > 255' +
    ' octets (parity)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xDD)
    const plaintext = new Uint8Array(1000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    // Seal with a valid objectId
    const validObjectId = new TextEncoder().encode('valid')
    const sealed = await sealObject(
        cek,
        validObjectId,
        plaintext,
        crypto
    )

    // Try to stream with oversized objectId (256 bytes)
    const oversized = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
        oversized[i] = i % 256
    }

    const ref = buildRef(plaintext, oversized, sealed)

    try {
        const stream = decryptAttachmentStream(
            cek,
            ref,
            chunked(sealed.bytes, 8192),
            crypto,
        )
        await drainStream(stream)
        t.ok(false, 'should reject oversized objectId')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects objectId > 255 octets'
        )
    }
})

// AC4.3 parity assertions for plaintextLength validation.
// These inputs are already rejected by layout() which openObject
// calls before key derivation. These tests assert parity with the
// streaming path and document that the bounds are enforced, not that
// the new objectId guard is enforcing them.

test('openObject rejects non-positive plaintextLength' +
    ' (parity, via layout)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xEE)
    const objectId = new TextEncoder().encode('test')

    // Create fake sealed bytes with correct structure
    const sealed = await sealObject(
        cek,
        objectId,
        new Uint8Array(100),
        crypto
    )

    // Try to open with zero plaintextLength
    try {
        await openObject(cek, objectId, sealed.bytes, {
            snapshot: sealed.snapshot,
            plaintextLength: 0,
        }, crypto)
        t.ok(false, 'should reject zero plaintextLength')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects zero plaintextLength via layout'
        )
    }

    // Try with negative plaintextLength
    try {
        await openObject(cek, objectId, sealed.bytes, {
            snapshot: sealed.snapshot,
            plaintextLength: -1,
        }, crypto)
        t.ok(false, 'should reject negative plaintextLength')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects negative plaintextLength via layout'
        )
    }
})

test('streaming reader rejects non-positive' +
    ' plaintextLength (parity)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xFF)
    const objectId = new TextEncoder().encode('test')

    // Create fake sealed bytes with correct structure
    const sealed = await sealObject(
        cek,
        objectId,
        new Uint8Array(100),
        crypto
    )

    // Try to stream with zero plaintextLength
    try {
        const ref = {
            version: 1,
            objectId: objectId.slice(),
            plaintextLength: 0n,
            snapshot: sealed.snapshot.slice(),
            locator: new Uint8Array(),
        }
        decryptAttachmentStream(
            cek,
            ref,
            chunked(sealed.bytes, 8192),
            crypto,
        )
        t.ok(false, 'should reject zero plaintextLength')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects zero plaintextLength'
        )
    }
})

test('openObject rejects non-safe-integer' +
    ' plaintextLength (parity, via layout)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0x11)
    const objectId = new TextEncoder().encode('test')

    // Create fake sealed bytes with correct structure
    const sealed = await sealObject(
        cek,
        objectId,
        new Uint8Array(100),
        crypto
    )

    // Try to open with non-safe-integer plaintextLength
    // (larger than Number.MAX_SAFE_INTEGER)
    const tooLarge = Number.MAX_SAFE_INTEGER + 1
    try {
        await openObject(cek, objectId, sealed.bytes, {
            snapshot: sealed.snapshot,
            plaintextLength: tooLarge,
        }, crypto)
        t.ok(false, 'should reject non-safe-integer plaintextLength')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects non-safe-integer plaintextLength via layout'
        )
    }
})

test('streaming reader rejects non-safe-integer' +
    ' plaintextLength (parity)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0x22)
    const objectId = new TextEncoder().encode('test')

    // Create fake sealed bytes with correct structure
    const sealed = await sealObject(
        cek,
        objectId,
        new Uint8Array(100),
        crypto
    )

    // Try to stream with non-safe-integer plaintextLength
    // (larger than MAX_SAFE_INTEGER)
    try {
        const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n
        const ref = {
            version: 1,
            objectId: objectId.slice(),
            plaintextLength: tooLarge,
            snapshot: sealed.snapshot.slice(),
            locator: new Uint8Array(),
        }
        decryptAttachmentStream(
            cek,
            ref,
            chunked(sealed.bytes, 8192),
            crypto,
        )
        t.ok(false, 'should reject non-safe-integer plaintextLength')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects non-safe-integer plaintextLength'
        )
    }
})

// Task 2: Attack shapes against both paths (AC4.2, AC4.4)

/**
 * Helper to build both openObject and streaming ref shapes from
 * one source of truth (plaintext, objectId, sealed).
 */
function makeBothRefs (
    plaintext:Uint8Array,
    objectId:Uint8Array,
    sealed:{ snapshot:Uint8Array },
):{
    openRef:{
        snapshot:Uint8Array
        plaintextLength:number
    }
    streamRef:{
        version:number
        objectId:Uint8Array
        plaintextLength:bigint
        snapshot:Uint8Array
        locator:Uint8Array
    }
} {
    return {
        openRef: {
            snapshot: sealed.snapshot.slice(),
            plaintextLength: plaintext.length,
        },
        streamRef: {
            version: 1,
            objectId: objectId.slice(),
            plaintextLength: BigInt(plaintext.length),
            snapshot: sealed.snapshot.slice(),
            locator: new Uint8Array(),
        },
    }
}

test('attack shapes: drop final segment', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0x33)
    const objectId = new TextEncoder().encode('attack1')
    // Make large enough for multiple segments
    const plaintext = new Uint8Array(100000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { openRef, streamRef } = makeBothRefs(plaintext, objectId, sealed)
    const { layoutParams, l } = buildLayout(plaintext.length, crypto)

    // Drop the whole final segment. The cut point comes from
    // blockRange, not a literal: SEGMENT_MAX is 65536, so the previous
    // `totalSize - 4096` landed inside the final segment and merely
    // truncated it, making this a duplicate of the truncate-by-10 test
    // rather than the distinct "drop" shape AC4.2 requires.
    const last = blockRange(l, layoutParams, l.nSeg - 1)
    const tamperedBytes = sealed.bytes.slice(0, last.offset)
    t.equal(
        sealed.bytes.length - tamperedBytes.length, last.length,
        'exactly one whole segment was removed'
    )

    // Test openObject rejects it
    try {
        await openObject(cek, objectId, tamperedBytes, openRef, crypto)
        t.ok(false, 'openObject should reject truncated object')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects truncated by segment drop'
        )
    }

    // Test streaming path rejects it
    try {
        const stream = decryptAttachmentStream(
            cek, streamRef, chunked(tamperedBytes, 8192), crypto,
        )
        await drainStream(stream)
        t.ok(false, 'streaming should reject truncated object')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects truncated by segment drop'
        )
    }
})

test('attack shapes: reorder two segments', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0x44)
    const objectId = new TextEncoder().encode('attack-reorder')
    const plaintext = new Uint8Array(200000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { openRef, streamRef } = makeBothRefs(
        plaintext, objectId, sealed,
    )
    const { layoutParams, l } = buildLayout(plaintext.length, crypto)

    // Swap segment 0 and segment 1. Both are full segments here, so
    // the object's length is unchanged: a length check structurally
    // cannot see this, and rejection has to come from the
    // leaf-to-head-to-root chain. Not the per-leaf comparison
    // specifically -- with that disabled the swap is still caught at
    // the epoch head, because the recomputed head diverges from the
    // stored one. Offsets come from blockRange, not literals.
    const b0 = blockRange(l, layoutParams, 0)
    const b1 = blockRange(l, layoutParams, 1)
    t.equal(b0.length, b1.length, 'segments 0 and 1 are the same size')

    const tamperedBytes = new Uint8Array(sealed.bytes)
    const seg0 = sealed.bytes.slice(b0.offset, b0.offset + b0.length)
    const seg1 = sealed.bytes.slice(b1.offset, b1.offset + b1.length)
    tamperedBytes.set(seg1, b0.offset)
    tamperedBytes.set(seg0, b1.offset)
    t.equal(
        tamperedBytes.length, sealed.bytes.length,
        'reorder leaves the object length unchanged'
    )

    try {
        await openObject(cek, objectId, tamperedBytes, openRef, crypto)
        t.ok(false, 'openObject should reject reordered segments')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects reordered segments'
        )
    }

    // No emission assertion here: a reorder is only detectable once
    // the affected segment is reached, so the streaming reader may
    // legitimately emit earlier plaintext first. See "Differences
    // that are deliberate" item 3 in the phase plan.
    try {
        const stream = decryptAttachmentStream(
            cek, streamRef, chunked(tamperedBytes, 8192), crypto,
        )
        await drainStream(stream)
        t.ok(false, 'streaming should reject reordered segments')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects reordered segments'
        )
    }
})

test('attack shapes: substitute segment from different object',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x4A)
        const objectId = new TextEncoder().encode('attack2')
        const plaintext = new Uint8Array(100000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(cek, objectId, plaintext, crypto)
        const { openRef, streamRef } = makeBothRefs(plaintext, objectId, sealed)
        const { layoutParams, l } = buildLayout(plaintext.length, crypto)

        // Create a different object with different CEK
        const cek2 = new Uint8Array(32).fill(0x45)
        const objectId2 = new TextEncoder().encode('attack2b')
        const sealed2 = await sealObject(cek2, objectId2, plaintext, crypto)

        // Substitute segment 0 from sealed with segment 0 from sealed2
        const tamperedBytes = new Uint8Array(sealed.bytes)
        const br0 = blockRange(l, layoutParams, 0)
        const seg0FromSealed2 = sealed2.bytes.slice(br0.offset,
            br0.offset + br0.length)
        tamperedBytes.set(seg0FromSealed2, br0.offset)

        // Test openObject rejects it
        try {
            await openObject(cek, objectId, tamperedBytes, openRef, crypto)
            t.ok(false, 'openObject should reject substituted segment')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openObject rejects substituted segment'
            )
        }

        // Test streaming path rejects it
        try {
            const stream = decryptAttachmentStream(
                cek, streamRef, chunked(tamperedBytes, 8192), crypto,
            )
            await drainStream(stream)
            t.ok(false, 'streaming should reject substituted segment')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'streaming rejects substituted segment'
            )
        }
    })

test('attack shapes: alter a byte in segment ciphertext',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x55)
        const objectId = new TextEncoder().encode('attack3')
        const plaintext = new Uint8Array(100000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(cek, objectId, plaintext, crypto)
        const { openRef, streamRef } = makeBothRefs(plaintext, objectId, sealed)
        const { l } = buildLayout(plaintext.length, crypto)

        // Alter a byte inside first segment ciphertext
        const tamperedBytes = new Uint8Array(sealed.bytes)
        tamperedBytes[l.firstBlockOffset + 100] ^= 0xFF

        // Test openObject rejects it
        try {
            await openObject(cek, objectId, tamperedBytes, openRef, crypto)
            t.ok(false, 'openObject should reject altered segment')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openObject rejects altered segment ciphertext'
            )
        }

        // Test streaming path rejects it
        try {
            const stream = decryptAttachmentStream(
                cek, streamRef, chunked(tamperedBytes, 8192), crypto,
            )
            await drainStream(stream)
            t.ok(false, 'streaming should reject altered segment')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'streaming rejects altered segment ciphertext'
            )
        }
    })

test('attack shapes: truncate object by few bytes (AC4.4)',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x66)
        const objectId = new TextEncoder().encode('attack4')
        const plaintext = new Uint8Array(100000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(cek, objectId, plaintext, crypto)
        const { openRef, streamRef } = makeBothRefs(plaintext, objectId, sealed)

        // Truncate by 10 bytes
        const tamperedBytes = sealed.bytes.slice(0, sealed.bytes.length - 10)

        // Test openObject rejects it
        try {
            await openObject(cek, objectId, tamperedBytes, openRef, crypto)
            t.ok(false, 'openObject should reject truncated object')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openObject rejects truncated object'
            )
        }

        // Test streaming path rejects it
        try {
            const stream = decryptAttachmentStream(
                cek, streamRef, chunked(tamperedBytes, 8192), crypto,
            )
            await drainStream(stream)
            t.ok(false, 'streaming should reject truncated object')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'streaming rejects truncated object'
            )
        }
    })

test('attack shapes: append trailing bytes (AC4.4)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0x77)
    const objectId = new TextEncoder().encode('attack5')
    const plaintext = new Uint8Array(100000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { openRef, streamRef } = makeBothRefs(plaintext, objectId, sealed)

    // Append 20 bytes
    const tamperedBytes = new Uint8Array(sealed.bytes.length + 20)
    tamperedBytes.set(sealed.bytes, 0)
    tamperedBytes.set(new Uint8Array(20).fill(0xAA), sealed.bytes.length)

    // Test openObject rejects it
    try {
        await openObject(cek, objectId, tamperedBytes, openRef, crypto)
        t.ok(false, 'openObject should reject appended bytes')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects appended trailing bytes'
        )
    }

    // Test streaming path rejects it
    try {
        const stream = decryptAttachmentStream(
            cek, streamRef, chunked(tamperedBytes, 8192), crypto,
        )
        await drainStream(stream)
        t.ok(false, 'streaming should reject appended bytes')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects appended trailing bytes'
        )
    }
})

// Task 3: Differential test (AC4.1)

test('differential: both paths agree under byte mutations',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x88)
        const objectId = new TextEncoder().encode('diff')
        // Large enough to span multiple segments and epochs
        // Two epochs. ATTACHMENT_EPOCH_LENGTH is 10, so a second
        // epoch needs 1025 segments, about 67 MiB. That sounds
        // expensive and is not: every offset in the sweep is rejected
        // early, so no path ever walks the full object. Measured at
        // 0.27s to seal and 0.67s for the whole sweep. A one-epoch
        // fixture cannot cover a second epoch head or cross-epoch head
        // ordering in epochTreeRoot, which is why task 3 asks for two.
        const plaintext = new Uint8Array(SEGMENT_MAX * 1025)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(cek, objectId, plaintext, crypto)
        const { openRef, streamRef } = makeBothRefs(plaintext, objectId, sealed)
        const { layoutParams, l } = buildLayout(
            plaintext.length, crypto,
        )
        t.ok(l.nEp > 1, 'fixture really does span two epochs')

        // Every offset names the region it probes and is derived from
        // layout(), metaRange() or blockRange(). A raw delta from a
        // region base is nh-dependent -- metaLen is nh + 16, so the
        // same literal picks out a different leaf, and a different
        // half of it, under a different suite. Deriving each offset
        // keeps the sweep covering the region it claims to.
        const nh = crypto.kdf.size
        const leaf0 = metaRange(l, 0)
        const leaf1 = metaRange(l, 1)
        const block0 = blockRange(l, layoutParams, 0)

        // A metadata leaf is LH(ciphertext) || tag. The tag half needs
        // its own offsets: openObject recomputes the leaf using the tag
        // read from these same bytes, so a tag mutation is invisible to
        // its leaf comparison and has to be caught one layer up, at the
        // epoch head. That is exactly the kind of divergence this test
        // exists to catch, so it must be swept, not assumed.
        // The range read the sweep drives. A one-byte window at
        // plaintext offset 0 touches segment 0 and epoch 0, so its
        // fetched ranges cover every offset below: the whole prefix
        // (salt, commitment, snapshot, BOTH epoch heads), epoch 0's
        // metadata run, the header padding gap, and block 0. Epoch
        // 1's metadata run is the one region of the header it does
        // not fetch, and no offset here lands in it.
        const sweepRange = { offset: 0, length: 1 }

        const testOffsets = [
            l.saltOffset,                    // salt
            l.saltOffset + 15,               // salt, interior
            l.commitmentOffset,              // commitment
            l.commitmentOffset + 10,         // commitment, interior
            l.snapshotOffset,                // stored snapshot
            l.snapshotOffset + 5,            // stored snapshot, interior
            l.epochHeadsOffset,              // epoch 0 head
            l.epochHeadsOffset + 20,         // epoch 0 head, interior
            l.epochHeadsOffset + nh,         // epoch 1 head
            l.epochHeadsOffset + nh + 7,     // epoch 1 head, interior
            leaf0.offset,                    // leaf 0, hash half
            leaf1.offset,                    // leaf 1, hash half
            leaf0.offset + nh,               // leaf 0, TAG half
            leaf1.offset + nh + 4,           // leaf 1, TAG half interior
            l.headerSize,                    // padding gap
            block0.offset,                   // segment ciphertext
            block0.offset + 5000,            // segment ciphertext interior
        ]

        for (const offset of testOffsets) {
            const tamperedBytes = new Uint8Array(sealed.bytes)
            tamperedBytes[offset] ^= 0x01

            // Test openObject
            let openAccepts = false
            try {
                await openObject(cek, objectId, tamperedBytes, openRef, crypto)
                openAccepts = true
            } catch (err) {
                if (!(err instanceof AttachmentError)) {
                    throw err
                }
            }

            // Test streaming path
            let streamAccepts = false
            try {
                const stream = decryptAttachmentStream(
                    cek, streamRef, chunked(tamperedBytes, 8192), crypto,
                )
                await drainStream(stream)
                streamAccepts = true
            } catch (err) {
                if (!(err instanceof AttachmentError)) {
                    throw err
                }
            }

            // Test range path
            const rangeAcceptsResult = await rangeAccepts(
                cek, streamRef, tamperedBytes, crypto, sweepRange,
            )

            // All three must agree
            if (openAccepts !== streamAccepts ||
                openAccepts !== rangeAcceptsResult) {
                t.fail(
                    `Paths disagree at offset ${offset}: ` +
                    `openObject=${openAccepts}, ` +
                    `streaming=${streamAccepts}, ` +
                    `range=${rangeAcceptsResult}`
                )
            } else {
                t.ok(true, `offset ${offset}: all three paths agree`)
            }
        }
    })
