import { test } from '@substrate-system/tapzero'
import { openAttachmentRange } from '../../src/attachment/range.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import { chunked, drainStream } from './stream-helpers.js'
import {
    multiEpochFixture, MULTI_EPOCH_SEGMENTS,
} from './multi-epoch-fixture.js'

/**
 * Positive multi-epoch coverage for the range path. The object and
 * stream paths are covered in multi-epoch.ts; this file is the third
 * path, and it is the one the audit called out as carrying two of the
 * four mutations that no test could see: a read that starts at epoch 0
 * regardless of which segment was asked for, and a head comparison
 * that always reads stored head 0.
 *
 * Neither mutation is visible on a window inside the first epoch,
 * because there epoch 0 IS the right answer. They only show up on a
 * window whose segments live past index 1024.
 *
 * Runtime: this file reuses the shared 1025-segment fixture from
 * multi-epoch-fixture.ts rather than sealing a second 64 MiB object,
 * so when multi-epoch.ts has already run it pays nothing for the seal.
 * The three reads here are windows of a few hundred octets and each
 * fetches only the header, one or two metadata runs and one or two
 * blocks. Measured under node as the difference between a run that
 * only builds the fixture and a run that also does the reads, they
 * add 30ms to 70ms; the seal they share dominates at 1.7s to 2.2s.
 * That is the range path's whole point, and it is why this file is
 * cheap to keep even though the fixture behind it is not.
 */

const LAST = MULTI_EPOCH_SEGMENTS - 1
const EPOCH_1_START = LAST * SEGMENT_MAX

/**
 * Read `range` through the range path, serving each requested byte
 * range from the sealed object the way a storage backend would.
 */
async function readRange (
    range:{ offset:number, length:number },
):Promise<Uint8Array> {
    const f = await multiEpochFixture()
    const read = await openAttachmentRange(f.cek, f.ref, range, f.crypto)
    try {
        const streams = read.ranges.map(r => chunked(
            f.sealed.bytes.slice(r.offset, r.offset + r.length), 1 << 16,
        ))
        const { total } = await drainStream(read.decrypt(streams))
        return total
    } finally {
        read.close()
    }
}

/** Index of the first differing byte, or -1. */
function firstMismatch (actual:Uint8Array, expected:Uint8Array):number {
    if (actual.length !== expected.length) return -2
    for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i]) return i
    }
    return -1
}

test('multi-epoch range: a window inside epoch 1', async t => {
    const f = await multiEpochFixture()
    const range = { offset: EPOCH_1_START + 100, length: 256 }
    const out = await readRange(range)
    const want = f.plaintext.slice(
        range.offset, range.offset + range.length,
    )
    t.equal(out.length, range.length, 'window length matches')
    t.equal(
        firstMismatch(out, want), -1,
        'every byte of a window inside epoch 1 matches',
    )
})

test('multi-epoch range: a window straddling the boundary', async t => {
    const f = await multiEpochFixture()
    // 128 octets from the end of segment 1023 and 128 from the start
    // of segment 1024, so the read spans both epochs and the epoch 1
    // half is only correct if the second epoch was verified and keyed
    // on its own terms.
    const range = { offset: EPOCH_1_START - 128, length: 256 }
    const out = await readRange(range)
    const want = f.plaintext.slice(
        range.offset, range.offset + range.length,
    )
    t.equal(out.length, range.length, 'window length matches')
    t.equal(
        firstMismatch(out, want), -1,
        'every byte across the epoch boundary matches',
    )
})

test('multi-epoch range: the last octet of the object', async t => {
    const f = await multiEpochFixture()
    const range = { offset: f.plaintext.length - 1, length: 1 }
    const out = await readRange(range)
    t.equal(out.length, 1, 'one octet')
    t.equal(
        out[0], f.plaintext[f.plaintext.length - 1],
        'the final octet, in the final segment of epoch 1, matches',
    )
})
