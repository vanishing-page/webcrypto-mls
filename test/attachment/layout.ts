import { test } from '@substrate-system/tapzero'
import {
    layout, rangesFor, segmentLength, blockRange, metaRange, epochOf,
    MAX_SEGMENTS,
    type LayoutParams, type ByteRange,
} from '../../src/attachment/layout.js'
import { AttachmentError } from '../../src/attachment/error.js'

function expectRangesSorted (ranges:ByteRange[]):boolean {
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i].offset < ranges[i - 1].offset) return false
    }
    return true
}

function expectRangesNonOverlapping (ranges:ByteRange[]):boolean {
    for (let i = 1; i < ranges.length; i++) {
        const prev = ranges[i - 1]
        const curr = ranges[i]
        if (curr.offset < prev.offset + prev.length) return false
    }
    return true
}

function rangesEqual (a:ByteRange[], b:ByteRange[]):boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i].offset !== b[i].offset || a[i].length !== b[i].length) {
            return false
        }
    }
    return true
}

// AC2.3: Layout math - single segment
test(
    'layout: single segment (1 byte)',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 1,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        const l = layout(params)

        t.equal(l.nSeg, 1, 'nSeg = 1')
        t.equal(l.nEp, 1, 'nEp = 1')
        t.ok(l.headerSize > 0, 'headerSize > 0')
        t.equal(l.totalSize, l.firstBlockOffset + 1, 'totalSize correct')
    },
)

test(
    'layout: single segment (65536 bytes exactly)',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        const l = layout(params)

        t.equal(l.nSeg, 1, 'nSeg = 1')
        t.equal(l.nEp, 1, 'nEp = 1')
        t.equal(
            l.totalSize,
            l.firstBlockOffset + 65536,
            'totalSize correct',
        )
    },
)

test(
    'layout: boundary condition (65537 bytes)',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65537,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        const l = layout(params)

        t.equal(l.nSeg, 2, 'nSeg = 2')
        t.equal(l.nEp, 1, 'nEp = 1 (both in same epoch)')
        t.equal(
            l.totalSize,
            l.firstBlockOffset + 65536 + 1,
            'totalSize = firstBlockOffset + 65536 + 1',
        )
    },
)

test(
    'layout: multi-epoch (65536 * 1025 + 5 bytes)',
    async t => {
        // This gives nSeg 1026, nEp 2 (2^10 = 1024 per epoch)
        const plaintextLength = (65536 * 1025) + 5
        const params:LayoutParams = {
            plaintextLength,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        const l = layout(params)

        t.equal(l.nSeg, 1026, 'nSeg = 1026')
        t.equal(l.nEp, 2, 'nEp = 2 (two epochs)')

        // Header formula: 32 + 2*Nh + nEp*Nh + nSeg*(Nh+16)
        const expectedHeaderSize = 32 + (2 * 32) + (2 * 32) +
            (1026 * (32 + 16))
        t.equal(l.headerSize, expectedHeaderSize, 'headerSize matches formula')

        // firstBlockOffset should be ceil(headerSize / segmentMax) * segmentMax
        const expectedFirstBlock = Math.ceil(expectedHeaderSize / 65536) * 65536
        t.equal(l.firstBlockOffset, expectedFirstBlock,
            'firstBlockOffset correct')

        // totalSize = firstBlockOffset + (nSeg-1)*segmentMax + lastLen
        const lastLen = plaintextLength - (1025 * 65536)
        const expectedTotal = expectedFirstBlock + (1025 * 65536) + lastLen
        t.equal(l.totalSize, expectedTotal, 'totalSize matches formula')
    },
)

test(
    'layout: header is exact multiple of segmentMax',
    async t => {
        // Design params so headerSize is exactly segmentMax
        // headerSize = 32 + 2*nh + nEp*nh + nSeg*(nh+16)
        // Use: segmentMax=128, nh=20, nSeg=1, nEp=1
        // 32 + 40 + 20 + 36 = 128 exactly!
        const params:LayoutParams = {
            plaintextLength: 100,
            segmentMax: 128,
            epochLength: 10,
            nh: 20,
        }

        const l = layout(params)

        t.equal(l.headerSize, 128, 'headerSize exactly 128')
        t.equal(l.firstBlockOffset, 128,
            'firstBlockOffset equals headerSize')
        t.ok(l.firstBlockOffset % 128 === 0, 'firstBlockOffset is multiple')
    },
)

test(
    'layout: header exceeds segmentMax',
    async t => {
        // Design so headerSize > segmentMax and firstBlockOffset > headerSize
        // Use segmentMax=64, nh=16, nSeg=2, epochLength=1, nEp=1
        // headerSize = 32 + 32 + 16 + 2*32 = 144 > 64
        // firstBlockOffset = ceil(144/64)*64 = 3*64 = 192 > 144
        const params:LayoutParams = {
            plaintextLength: 128,
            segmentMax: 64,
            epochLength: 1,
            nh: 16,
        }

        const l = layout(params)

        // nSeg = ceil(128/64) = 2
        // nEp = ceil(2/2) = 1
        // headerSize = 32 + 32 + 16 + 2*32 = 144
        const expectedHeaderSize = 32 + (2 * 16) + (1 * 16) + (2 * 32)
        t.equal(l.headerSize, expectedHeaderSize, 'headerSize > segmentMax')

        // firstBlockOffset = ceil(144/64)*64 = 3*64 = 192
        const expectedFirstBlock = Math.ceil(expectedHeaderSize / 64) * 64
        t.equal(l.firstBlockOffset, expectedFirstBlock,
            'firstBlockOffset is aligned')
        t.ok(
            l.firstBlockOffset > l.headerSize,
            'firstBlockOffset > headerSize',
        )
    },
)

// AC2.3: Layout throws on invalid inputs
test(
    'layout: rejects zero plaintext length',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 0,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        try {
            layout(params)
            t.fail('should throw AttachmentError')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

test(
    'layout: rejects negative plaintext length',
    async t => {
        const params:LayoutParams = {
            plaintextLength: -1,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        try {
            layout(params)
            t.fail('should throw AttachmentError')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

// AC2.3: rangesFor returns correct ranges
test(
    'rangesFor: single segment access',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        const result = rangesFor(params, 0, 65536)

        // Hand-computed expected ranges:
        // headerSize = 32 + 2*32 + 1*32 + 1*48 = 176
        // firstBlockOffset = ceil(176/65536)*65536 = 65536
        // Prefix+heads: [0, 128) = salt, commitment, snapshot, epoch heads
        // Metadata: [128, 176) = 1 epoch * 48 bytes/segment
        // Padding gap: [176, 65536)
        // Block 0: [65536, 131072) = segment 0
        // The gap bridges the header and the block, so coalescing
        // leaves one range over the whole object.
        const expectedRanges:ByteRange[] = [
            { offset: 0, length: 131072 },
        ]

        t.ok(
            expectRangesSorted(result.ranges),
            'ranges are sorted by offset',
        )
        t.ok(
            expectRangesNonOverlapping(result.ranges),
            'ranges are non-overlapping',
        )
        t.ok(
            rangesEqual(result.ranges, expectedRanges),
            'ranges exactly match expected',
        )
        t.equal(result.segFirst, 0, 'segFirst = 0')
        t.equal(result.segLast, 0, 'segLast = 0')
    },
)

test(
    'rangesFor: cross-segment span',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 131072,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        // Read bytes 32768 to 98304 (crosses both segments)
        const result = rangesFor(params, 32768, 65536)

        // Hand-computed expected ranges:
        // nSeg = 2, nEp = 1
        // metaLen = 32 + 16 = 48
        // headerSize = 32 + 2*32 + 1*32 + 2*48 = 224
        // firstBlockOffset = ceil(224/65536)*65536 = 65536
        // epochHeadsOffset = 96, epoch heads [96, 128)
        // Prefix+heads: [0, 128)
        // Metadata both segments: [128, 224)
        // Padding gap: [224, 65536)
        // Block 0: [65536, 131072)
        // Block 1: [131072, 196608)
        // After coalescing: [0, 196608)
        const expectedRanges:ByteRange[] = [
            { offset: 0, length: 196608 },
        ]

        t.ok(
            expectRangesSorted(result.ranges),
            'ranges sorted',
        )
        t.ok(
            expectRangesNonOverlapping(result.ranges),
            'ranges non-overlapping',
        )
        t.ok(
            rangesEqual(result.ranges, expectedRanges),
            'ranges exactly match expected',
        )
        t.equal(result.segFirst, 0, 'segFirst = 0')
        t.equal(result.segLast, 1, 'segLast = 1')
    },
)

test(
    'rangesFor: cross-epoch span (synthetic small params)',
    async t => {
        // Small params: segmentMax 64, epochLength 2 (4 segments per epoch)
        const params:LayoutParams = {
            plaintextLength: 512,
            segmentMax: 64,
            epochLength: 2,
            nh: 32,
        }

        // 8 segments total (512 / 64 = 8)
        // epoch 0: segments 0-3, epoch 1: segments 4-7
        // Request bytes 224-320, which is segments 3-4
        // This crosses from epoch 0 to epoch 1
        const result = rangesFor(params, 224, 96)

        // Hand-computed expected ranges:
        // nSeg = 8, nEp = 2
        // metaLen = 48
        // headerSize = 32 + 64 + 64 + 384 = 544
        // firstBlockOffset = ceil(544/64)*64 = 576
        // Prefix+heads: [0, 160)
        // Metadata epoch 0: [160, 352)
        // Metadata epoch 1: [352, 544)
        // Padding gap: [544, 576)
        // Block 3: [768, 832)
        // Block 4: [832, 896)
        // After coalescing: [0, 576) and [768, 896). The gap does not
        // reach block 3, so the two stay separate here.
        const expectedRanges:ByteRange[] = [
            { offset: 0, length: 576 },
            { offset: 768, length: 128 },
        ]

        t.ok(
            expectRangesSorted(result.ranges),
            'ranges sorted',
        )
        t.ok(
            expectRangesNonOverlapping(result.ranges),
            'ranges non-overlapping',
        )
        t.ok(
            rangesEqual(result.ranges, expectedRanges),
            'ranges exactly match expected',
        )
        t.equal(result.segFirst, 3, 'segFirst = 3')
        t.equal(result.segLast, 4, 'segLast = 4')
    },
)

test(
    'rangesFor: prefix abuts metadata (coalescing)',
    async t => {
        // Design with headerSize that places metadata immediately after
        // prefix+heads so coalescing is observable
        const params:LayoutParams = {
            plaintextLength: 128,
            segmentMax: 64,
            epochLength: 2,
            nh: 32,
        }

        // 2 segments, 1 epoch
        // headerSize = 32 + 2*32 + 1*32 + 2*48 = 224
        // firstBlockOffset = ceil(224/64)*64 = 4*64 = 256
        // Prefix+heads: [0, 128)
        // Metadata for epoch 0 (all segments): [128, 224)
        // Block 0: [256, 320)
        // Request segment 0 reads [0, 64)
        const result = rangesFor(params, 0, 64)

        // Padding gap: [224, 256)
        // After coalescing: headers, metadata, gap and block 0 all
        // abut, so one range [0, 320) covers them.
        const expectedRanges:ByteRange[] = [
            { offset: 0, length: 320 },
        ]

        t.ok(
            expectRangesSorted(result.ranges),
            'ranges sorted',
        )
        t.ok(
            expectRangesNonOverlapping(result.ranges),
            'ranges non-overlapping',
        )
        t.ok(
            rangesEqual(result.ranges, expectedRanges),
            'ranges exactly match expected',
        )
        t.equal(result.segFirst, 0, 'segFirst = 0')
        t.equal(result.segLast, 0, 'segLast = 0')
    },
)

test(
    'rangesFor: empty padding gap emits no range',
    async t => {
        // headerSize lands exactly on a segmentMax boundary, so
        // [headerSize, firstBlockOffset) is empty and the gap range
        // must be omitted rather than emitted with length 0.
        // nSeg = 4, nEp = 1, metaLen = 48
        // headerSize = 32 + 2*32 + 1*32 + 4*48 = 320 = 5 * 64
        // firstBlockOffset = ceil(320/64)*64 = 320
        const params:LayoutParams = {
            plaintextLength: 256,
            segmentMax: 64,
            epochLength: 2,
            nh: 32,
        }

        const l = layout(params)
        t.equal(
            l.headerSize, l.firstBlockOffset,
            'fixture really does have an empty gap',
        )

        const result = rangesFor(params, 0, 64)

        // Prefix+heads: [0, 128)
        // Metadata epoch 0: [128, 320)
        // Block 0: [320, 384)
        const expectedRanges:ByteRange[] = [
            { offset: 0, length: 384 },
        ]

        t.ok(
            result.ranges.every(r => r.length > 0),
            'no zero-length range emitted',
        )
        t.ok(
            rangesEqual(result.ranges, expectedRanges),
            'ranges exactly match expected',
        )
    },
)

// AC2.3: rangesFor throws on invalid inputs
test(
    'rangesFor: rejects zero length',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        try {
            rangesFor(params, 0, 0)
            t.fail('should throw')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

test(
    'rangesFor: rejects negative offset',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        try {
            rangesFor(params, -1, 100)
            t.fail('should throw')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

test(
    'rangesFor: rejects offset+length past end',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        try {
            rangesFor(params, 65536, 1)
            t.fail('should throw')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

// Tests for segmentLength
test(
    'segmentLength: full segment',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 131072,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }
        const l = layout(params)

        const len0 = segmentLength(l, params, 0)
        t.equal(len0, 65536, 'segment 0 is full')

        const len1 = segmentLength(l, params, 1)
        t.equal(len1, 65536, 'segment 1 is full')
    },
)

test(
    'segmentLength: partial final segment',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65537,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }
        const l = layout(params)

        const len1 = segmentLength(l, params, 1)
        t.equal(len1, 1, 'final segment is partial')
    },
)

test(
    'segmentLength: out of range throws',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }
        const l = layout(params)

        try {
            segmentLength(l, params, -1)
            t.fail('should throw on negative index')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }

        try {
            segmentLength(l, params, 1)
            t.fail('should throw on index >= nSeg')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

// Tests for blockRange
test(
    'blockRange: offset and length',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 131072,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }
        const l = layout(params)

        const br0 = blockRange(l, params, 0)
        t.equal(br0.offset, 65536, 'block 0 offset')
        t.equal(br0.length, 65536, 'block 0 length')

        const br1 = blockRange(l, params, 1)
        t.equal(br1.offset, 131072, 'block 1 offset')
        t.equal(br1.length, 65536, 'block 1 length')
    },
)

test(
    'blockRange: out of range throws',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }
        const l = layout(params)

        try {
            blockRange(l, params, 1)
            t.fail('should throw on out of range')
        } catch (err) {
            t.ok(err instanceof AttachmentError, 'throws AttachmentError')
        }
    },
)

// Tests for metaRange
test(
    'metaRange: offset and length',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 131072,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }
        const l = layout(params)

        const mr0 = metaRange(l, 0)
        t.equal(mr0.offset, l.metaOffset, 'segment 0 meta offset')
        t.equal(mr0.length, l.metaLen, 'segment 0 meta length')

        const mr1 = metaRange(l, 1)
        t.equal(mr1.offset, l.metaOffset + l.metaLen,
            'segment 1 meta offset')
        t.equal(mr1.length, l.metaLen, 'segment 1 meta length')
    },
)

// Tests for epochOf
test(
    'epochOf: segment to epoch mapping',
    async t => {
        const params:LayoutParams = {
            plaintextLength: 65536,
            segmentMax: 65536,
            epochLength: 10,
            nh: 32,
        }

        // epochLength 10 means 2^10 = 1024 segments per epoch
        t.equal(epochOf(params, 0), 0, 'segment 0 -> epoch 0')
        t.equal(epochOf(params, 1023), 0, 'segment 1023 -> epoch 0')
        t.equal(epochOf(params, 1024), 1, 'segment 1024 -> epoch 1')
        t.equal(epochOf(params, 2048), 2, 'segment 2048 -> epoch 2')
    },
)

// Tests for MAX_SEGMENTS
test(
    'MAX_SEGMENTS constant',
    async t => {
        t.equal(MAX_SEGMENTS, 2 ** 31, 'MAX_SEGMENTS = 2^31')
        t.ok(
            Number.isSafeInteger(MAX_SEGMENTS),
            'MAX_SEGMENTS is safe integer',
        )
    },
)
