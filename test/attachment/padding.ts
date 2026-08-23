import { test } from '@substrate-system/tapzero'
import { isZeroRegion } from '../../src/attachment/layout.js'
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
import {
    buildLayout, buildRef,
} from './attachment-fixtures.js'
import {
    chunked, drainStream,
} from './stream-helpers.js'

// Tests for the zero-region predicate used to validate alignment
// padding between the header and the first segment

test('all-zero buffer over sub-range returns true', t => {
    const buffer = new Uint8Array(100)
    t.ok(isZeroRegion(buffer, 10, 50), 'zero region detected')
})

test('buffer with non-zero byte inside range returns false', t => {
    const buffer = new Uint8Array(100)
    buffer[25] = 1
    t.equal(
        isZeroRegion(buffer, 10, 50),
        false,
        'non-zero byte detected'
    )
})

test('non-zero byte outside range does not affect result', t => {
    const buffer = new Uint8Array(100)
    buffer[9] = 1
    buffer[50] = 1
    t.ok(
        isZeroRegion(buffer, 10, 50),
        'bytes outside range ignored'
    )
})

test('from === to returns true (empty-gap boundary)', t => {
    const buffer = new Uint8Array(100)
    buffer[25] = 1
    t.ok(
        isZeroRegion(buffer, 50, 50),
        'empty region is trivially zero'
    )
})

test('from > to returns true', t => {
    const buffer = new Uint8Array(100)
    buffer[25] = 1
    t.ok(
        isZeroRegion(buffer, 50, 25),
        'inverted range is trivially zero'
    )
})

test('out-of-range indices fail closed', t => {
    const buffer = new Uint8Array(10)
    // Accessing buffer[15] returns undefined, which is not 0
    const result = isZeroRegion(buffer, 5, 20)
    t.equal(
        result, false,
        'out-of-range access reads undefined, not 0'
    )
})

test('openObject rejects non-zero padding (AC1.2)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xAA)
    const objectId = new TextEncoder().encode('test-object')
    const plaintext = new Uint8Array(1000)

    // Seal the object
    const sealed = await sealObject(cek, objectId, plaintext, crypto)

    // Compute layout to find gap bounds
    const { l } = buildLayout(plaintext.length, crypto)

    // Flip a byte in the gap
    const tampered = new Uint8Array(sealed.bytes)
    const gapOffset = l.headerSize
    tampered[gapOffset] = 1

    // Verify that opening the tampered object throws AttachmentError
    try {
        await openObject(cek, objectId, tampered, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, crypto)
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects non-zero padding'
        )
    }
})

test('openObject accepts valid padding (AC1.3)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xAA)
    const objectId = new TextEncoder().encode('test-object')
    const plaintext = new Uint8Array(1000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    // Seal and open the object
    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const opened = await openObject(cek, objectId, sealed.bytes, {
        snapshot: sealed.snapshot,
        plaintextLength: plaintext.length,
    }, crypto)

    // Verify plaintext matches
    let match = opened.length === plaintext.length
    if (match) {
        for (let i = 0; i < plaintext.length; i++) {
            if (opened[i] !== plaintext[i]) {
                match = false
                break
            }
        }
    }
    t.ok(match, 'plaintext matches after round-trip')
})

test('streaming reader rejects non-zero padding' +
    ' (AC1.1)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xAA)
    const objectId = new TextEncoder().encode('stream-test')
    const plaintext = new Uint8Array(1000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    // Seal the object
    const sealed = await sealObject(cek, objectId, plaintext, crypto)

    // Compute layout to find gap bounds
    const { l } = buildLayout(plaintext.length, crypto)

    // Flip a byte in the gap
    const tampered = new Uint8Array(sealed.bytes)
    const gapOffset = l.headerSize
    tampered[gapOffset] = 1

    // Stream the tampered bytes and verify error and zero plaintext
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered, 8192),
        crypto,
    )

    const emitted:Uint8Array[] = []
    try {
        await drainStream(stream, emitted)
        t.ok(false, 'should reject non-zero padding')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects non-zero padding'
        )
        t.equal(
            emitted.length, 0,
            'zero plaintext bytes emitted before error'
        )
    }
})

// The gap-skip loop has two trim branches: one that drops a whole
// chunk, and one that drops only the leading part of a chunk that
// straddles the end of the gap. Each has its own isZeroRegion call.
// The tests above exercise the whole-chunk branch; deleting the
// STRADDLING branch's check left the entire suite green, so a byte
// flipped in the trimmed part of a straddling chunk went undetected.
//
// The straddle position depends on (headerSize + gap) mod chunkSize,
// so a single chunk size proves nothing in general. Sweep several and
// flip the last byte of the gap, which is always inside the trimmed
// span of whichever chunk straddles the boundary.
for (const chunkSize of [1000, 700, 333, 4096]) {
    test('streaming rejects a flip in a straddling chunk, ' +
        `chunk ${chunkSize} (AC1.1)`, async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x9C)
        const objectId = new TextEncoder().encode('straddle-test')
        const plaintext = new Uint8Array(2000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = (i * 31) % 256
        }

        const sealed = await sealObject(cek, objectId, plaintext, crypto)
        const { l } = buildLayout(plaintext.length, crypto)

        // Last byte of the gap: always in the trimmed span. Assert
        // the gap is non-empty rather than relying on the geometry --
        // it cannot collapse without a deliberate layout change, but
        // if it ever did, this test would otherwise pass for the
        // wrong reason.
        t.ok(
            l.firstBlockOffset > l.headerSize,
            'fixture has a non-empty gap to flip a byte in'
        )
        const tampered = new Uint8Array(sealed.bytes)
        tampered[l.firstBlockOffset - 1] = 0x5A

        const ref = buildRef(plaintext, objectId, sealed)
        const stream = decryptAttachmentStream(
            cek, ref, chunked(tampered, chunkSize), crypto,
        )

        const emitted:Uint8Array[] = []
        try {
            await drainStream(stream, emitted)
            t.ok(false, `should reject at chunk ${chunkSize}`)
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                `rejects straddling-chunk flip at ${chunkSize}`
            )
            t.equal(emitted.length, 0, 'no plaintext emitted')
        }
    })
}

test('streaming with small chunks and flip' +
    ' near gap start (AC1.1)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xBB)
    const objectId = new TextEncoder().encode('stream-chunk-test')
    const plaintext = new Uint8Array(2000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i ^ 0x55) % 256
    }

    // Seal the object
    const sealed = await sealObject(cek, objectId, plaintext, crypto)

    // Compute layout
    const { l } = buildLayout(plaintext.length, crypto)

    // Flip a byte near the start of the gap
    const tampered = new Uint8Array(sealed.bytes)
    const flipOffset = l.headerSize + 1
    tampered[flipOffset] = 0xFF

    // Stream with small chunks
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered, 1024),
        crypto,
    )

    const emitted:Uint8Array[] = []
    try {
        await drainStream(stream, emitted)
        t.ok(false, 'should reject non-zero padding')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects non-zero gap with small chunks'
        )
        t.equal(
            emitted.length, 0,
            'zero plaintext bytes emitted'
        )
    }
})

test('streaming with small chunks and flip' +
    ' near gap end (AC1.1)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xCC)
    const objectId = new TextEncoder().encode('stream-chunk-end-test')
    const plaintext = new Uint8Array(2500)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i * 7) % 256
    }

    // Seal the object
    const sealed = await sealObject(cek, objectId, plaintext, crypto)

    // Compute layout
    const { l } = buildLayout(plaintext.length, crypto)

    // Flip a byte near the end of the gap
    const tampered = new Uint8Array(sealed.bytes)
    const flipOffset = l.firstBlockOffset - 2
    tampered[flipOffset] = 0xAA

    // Stream with small chunks
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered, 512),
        crypto,
    )

    const emitted:Uint8Array[] = []
    try {
        await drainStream(stream, emitted)
        t.ok(false, 'should reject non-zero padding')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects non-zero gap end'
        )
        t.equal(
            emitted.length, 0,
            'zero plaintext bytes emitted'
        )
    }
})

test('streaming accepts valid padding (AC1.3)', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xDD)
    const objectId = new TextEncoder().encode('stream-valid-test')
    const plaintext = new Uint8Array(1500)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i + 42) % 256
    }

    // Seal the object
    const sealed = await sealObject(cek, objectId, plaintext, crypto)

    // Stream the unmodified bytes
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(sealed.bytes, 4096),
        crypto,
    )

    // Drain through the same sink the tamper tests use, so their
    // `emitted.length === 0` assertion is pinned as non-vacuous: this
    // asserts the sink does receive chunks when plaintext flows.
    const emitted:Uint8Array[] = []
    try {
        const result = await drainStream(stream, emitted)
        const { chunks } = result
        t.ok(emitted.length > 0, 'sink receives chunks when they flow')

        // Reconstruct plaintext
        let totalLen = 0
        for (const chunk of chunks) {
            totalLen += chunk.length
        }

        let match = totalLen === plaintext.length
        if (match) {
            let offset = 0
            for (const chunk of chunks) {
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] !== plaintext[offset + i]) {
                        match = false
                        break
                    }
                }
                offset += chunk.length
                if (!match) break
            }
        }

        t.ok(match, 'plaintext matches after streaming')
    } catch (err) {
        t.ok(
            false,
            'should not throw on valid padding: ' + String(err)
        )
    }
})

// AC1.4: The range path holds the same invariant. It used to skip
// the gap entirely, on the reasoning that rangesFor did not fetch it;
// rangesFor now emits it precisely so this check is possible.

test('range read rejects non-zero padding', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xEE)
    const objectId = new TextEncoder().encode('range-gap')
    const plaintext = new Uint8Array(10000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i * 7) % 256
    }

    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { l } = buildLayout(plaintext.length, crypto)
    const ref = buildRef(plaintext, objectId, sealed)
    t.ok(
        l.firstBlockOffset > l.headerSize,
        'fixture really does have a non-empty gap',
    )

    const tampered = new Uint8Array(sealed.bytes)
    tampered[l.headerSize + 3] = 0x42

    const read = await openAttachmentRange(
        cek, ref, { offset: 100, length: 64 }, crypto,
    )
    const covers = read.ranges.some(r => (
        r.offset <= l.headerSize &&
        r.offset + r.length >= l.firstBlockOffset
    ))
    t.ok(covers, 'a fetched range covers the padding gap')

    try {
        const streams = read.ranges.map(r => chunked(
            tampered.slice(r.offset, r.offset + r.length), 2048,
        ))
        await drainStream(read.decrypt(streams))
        t.ok(false, 'range read should reject non-zero gap')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'range read rejects non-zero gap',
        )
    }
})

test('range read accepts valid padding', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xEF)
    const objectId = new TextEncoder().encode('range-gap-ok')
    const plaintext = new Uint8Array(10000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i * 11) % 256
    }

    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const ref = buildRef(plaintext, objectId, sealed)

    const read = await openAttachmentRange(
        cek, ref, { offset: 100, length: 64 }, crypto,
    )
    const streams = read.ranges.map(r => chunked(
        sealed.bytes.slice(r.offset, r.offset + r.length), 2048,
    ))
    const { total: out } = await drainStream(read.decrypt(streams))

    const want = plaintext.slice(100, 164)
    t.equal(out.length, want.length, 'window length matches')
    let same = true
    for (let i = 0; i < want.length; i++) {
        if (out[i] !== want[i]) same = false
    }
    t.ok(same, 'range plaintext matches')
})

// AC1.4: Sweep gap sizes across different plaintext lengths and
// epochs. The gap is empty only when headerSize is an exact multiple
// of segmentMax. With headerSize = 32 + 2*nh + nEp*nh + nSeg*(nh+16),
// the first solutions are nSeg=1362 for nh=32 (~85 MiB) and nSeg=6546
// for nh=64 (~409 MiB). These are reachable but too large to seal in
// this test suite (peak allocation would exceed browser and CI
// capacity). The empty-gap boundary is covered by task 1's predicate
// tests (from >= to); task 4 records this arithmetic and verifies
// rejection holds across varying gap lengths.

test('gap rejection sweep: sub-segment plaintext', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xBB)
    const objectId = new TextEncoder().encode('sweep-small')
    const plaintext = new Uint8Array(10000) // smaller than segmentMax
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i * 13) % 256
    }

    // Seal and compute layout
    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { l } = buildLayout(plaintext.length, crypto)

    // Test with openObject
    const tampered1 = new Uint8Array(sealed.bytes)
    tampered1[l.headerSize] = 1
    try {
        await openObject(cek, objectId, tampered1, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, crypto)
        t.ok(false, 'openObject should reject non-zero gap')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects gap at sub-segment size'
        )
    }

    // Test with streaming
    const tampered2 = new Uint8Array(sealed.bytes)
    tampered2[l.headerSize + 5] = 0x42
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered2, 2048),
        crypto,
    )

    try {
        await drainStream(stream)
        t.ok(false, 'streaming should reject non-zero gap')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects gap at sub-segment size'
        )
    }
})

test('gap rejection sweep: exact segment boundary', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xCC)
    const objectId = new TextEncoder().encode('sweep-boundary')
    // Create plaintext exactly at segment boundary
    const plaintext = new Uint8Array(SEGMENT_MAX)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i ^ 0xAB) % 256
    }

    // Seal and compute layout
    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { l } = buildLayout(plaintext.length, crypto)

    // Test rejection with openObject
    const tampered1 = new Uint8Array(sealed.bytes)
    const flipOffset = Math.floor(
        l.headerSize + (l.firstBlockOffset - l.headerSize) / 2,
    )
    tampered1[flipOffset] = 0xFF

    try {
        await openObject(cek, objectId, tampered1, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, crypto)
        t.ok(false, 'openObject should reject')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects gap at segment boundary'
        )
    }

    // Test rejection with streaming
    const tampered2 = new Uint8Array(sealed.bytes)
    tampered2[flipOffset] = 0xFF
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered2, 4096),
        crypto,
    )

    try {
        await drainStream(stream)
        t.ok(false, 'streaming should reject')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects gap at segment boundary'
        )
    }
})

test('gap rejection sweep: multi-segment plaintext', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xDD)
    const objectId = new TextEncoder().encode('sweep-multi')
    // Create plaintext spanning multiple segments
    const plaintext = new Uint8Array(SEGMENT_MAX * 3 + 5000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i >> 2) % 256
    }

    // Seal and compute layout
    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { l } = buildLayout(plaintext.length, crypto)

    // Test rejection with openObject
    const tampered1 = new Uint8Array(sealed.bytes)
    tampered1[l.headerSize + 100] = 0x77

    try {
        await openObject(cek, objectId, tampered1, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, crypto)
        t.ok(false, 'openObject should reject')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects gap in multi-segment object'
        )
    }

    // Test rejection with streaming
    const tampered2 = new Uint8Array(sealed.bytes)
    tampered2[l.headerSize + 100] = 0x77
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered2, 4096),
        crypto,
    )

    try {
        await drainStream(stream)
        t.ok(false, 'streaming should reject')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects gap in multi-segment object'
        )
    }
})

test('gap rejection sweep: multi-epoch plaintext', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0xEE)
    const objectId = new TextEncoder().encode('sweep-epoch')
    // Create plaintext large enough for multiple epochs
    // With epochLength 10, perEpoch = 1024, so 1025 segments -> 2 epochs
    const plaintext = new Uint8Array(SEGMENT_MAX * 1030)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = ((i * 17) >> 1) % 256
    }

    // Seal and compute layout
    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const { l } = buildLayout(plaintext.length, crypto)

    // Verify we have multiple epochs
    t.ok(l.nEp > 1, 'multi-epoch object created')

    // Test rejection with openObject
    const tampered1 = new Uint8Array(sealed.bytes)
    tampered1[l.firstBlockOffset - 50] = 0x99

    try {
        await openObject(cek, objectId, tampered1, {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }, crypto)
        t.ok(false, 'openObject should reject')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects gap in multi-epoch object'
        )
    }

    // Test rejection with streaming. Reuse sealed.bytes rather than
    // sealing a second object, to mind peak allocation.
    const tampered2 = new Uint8Array(sealed.bytes)
    tampered2[l.firstBlockOffset - 50] = 0x99
    const ref = buildRef(plaintext, objectId, sealed)
    const stream = decryptAttachmentStream(
        cek,
        ref,
        chunked(tampered2, 8192),
        crypto,
    )

    try {
        await drainStream(stream)
        t.ok(false, 'streaming should reject')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'streaming rejects gap in multi-epoch object'
        )
    }
})
