import { test } from '@substrate-system/tapzero'
import { openObject } from '../../src/attachment/object.js'
import { decryptAttachmentStream } from '../../src/attachment/reader.js'
import { openAttachmentRange } from '../../src/attachment/range.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { buildLayout } from './attachment-fixtures.js'
import { chunked, drainStream } from './stream-helpers.js'
import {
    multiEpochFixture, MULTI_EPOCH_SEGMENTS,
} from './multi-epoch-fixture.js'
import type { MultiEpochFixture } from './multi-epoch-fixture.js'

/**
 * Negative multi-epoch coverage: tamper detection past epoch 0.
 *
 * multi-epoch.ts and multi-epoch-range.ts read the shared two-epoch
 * fixture and check the plaintext comes back. That is the positive
 * half. This file is the negative half, and it is the one that says
 * the integrity checks are indexed by epoch rather than applied to
 * epoch 0 and then trusted for the rest of the object.
 *
 * Two tampers, each on all three read paths:
 *
 *   1. A bit flipped in the stored head of epoch 1. The heads region
 *      is covered by the epoch-tree root, so this is the case that
 *      exercises the root binding on a head that is not head 0.
 *   2. A bit flipped in the LH(ct) half of segment 1024's leaf --
 *      the first and only segment of epoch 1. The leaf run is covered
 *      by the epoch head, so this is the case that exercises head
 *      recomputation for an epoch that is not epoch 0.
 *
 * Every case pins AttachmentError rather than "it threw", because a
 * TypeError from an out-of-range slice would otherwise read as a
 * successful rejection.
 *
 * Cost: the fixture is shared with multi-epoch.ts and sealed once per
 * run, so this file pays for the reads only. The two head-tamper
 * stream and range cases reject at the header and are close to free.
 * The two openObject cases recompute every leaf, and the leaf-tamper
 * stream case decrypts all of epoch 0 before it reaches the epoch 1
 * head, so budget roughly a second of wall clock for the file. No
 * step here goes quiet for the three seconds that would make the
 * browser runner treat the run as truncated.
 */

/** Offset of epoch `e`'s stored head. */
function headOffset (f:MultiEpochFixture, e:number):number {
    const { l } = buildLayout(f.plaintext.length, f.crypto)
    return l.epochHeadsOffset + (e * f.crypto.kdf.size)
}

/** Offset of segment `i`'s stored leaf. */
function leafOffset (f:MultiEpochFixture, i:number):number {
    const { l } = buildLayout(f.plaintext.length, f.crypto)
    return l.metaOffset + (i * l.metaLen)
}

/**
 * A copy of the sealed object with the byte at `at` flipped. Copied
 * per call rather than cached so the 64 MiB stays collectable between
 * tests; the browser run is the constraint.
 */
async function tamperedAt (at:number):Promise<Uint8Array> {
    const f = await multiEpochFixture()
    const bytes = new Uint8Array(f.sealed.bytes)
    bytes[at] ^= 0x01
    return bytes
}

const LAST = MULTI_EPOCH_SEGMENTS - 1

/** `openObject` over `bytes`, with the untampered ref. */
async function readObject (bytes:Uint8Array):Promise<Uint8Array> {
    const f = await multiEpochFixture()
    return openObject(f.cek, f.objectId, bytes, {
        snapshot: f.sealed.snapshot.slice(),
        plaintextLength: f.plaintext.length,
    }, f.crypto)
}

/** `decryptAttachmentStream` over `bytes`, drained to completion. */
async function readStream (bytes:Uint8Array):Promise<void> {
    const f = await multiEpochFixture()
    const stream = decryptAttachmentStream(
        f.cek, f.ref, chunked(bytes, 1 << 20), f.crypto,
    )
    const reader = stream.getReader()
    try {
        let result = await reader.read()
        while (!result.done) result = await reader.read()
    } finally {
        reader.releaseLock()
    }
}

/**
 * Read `range` through the range path, serving each requested byte
 * range out of `bytes` the way a storage backend would.
 */
async function readRange (
    bytes:Uint8Array,
    range:{ offset:number, length:number },
):Promise<Uint8Array> {
    const f = await multiEpochFixture()
    const read = await openAttachmentRange(f.cek, f.ref, range, f.crypto)
    try {
        const streams = read.ranges.map(r => chunked(
            bytes.slice(r.offset, r.offset + r.length), 1 << 16,
        ))
        const { total } = await drainStream(read.decrypt(streams))
        return total
    } finally {
        read.close()
    }
}

/** A window wholly inside epoch 1. */
const EPOCH_1_WINDOW = { offset: (LAST * SEGMENT_MAX) + 100, length: 256 }

test('multi-epoch tamper: openObject rejects a flipped epoch 1 head',
    async t => {
        const f = await multiEpochFixture()
        const bytes = await tamperedAt(headOffset(f, 1))
        try {
            await readObject(bytes)
            t.fail('openObject accepted a flipped epoch 1 head')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openObject throws AttachmentError',
            )
        }
    })

test('multi-epoch tamper: the stream rejects a flipped epoch 1 head',
    async t => {
        const f = await multiEpochFixture()
        const bytes = await tamperedAt(headOffset(f, 1))
        try {
            await readStream(bytes)
            t.fail('the stream accepted a flipped epoch 1 head')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'the stream throws AttachmentError',
            )
        }
    })

test('multi-epoch tamper: the range path rejects a flipped epoch 1 head',
    async t => {
        const f = await multiEpochFixture()
        const bytes = await tamperedAt(headOffset(f, 1))
        try {
            await readRange(bytes, EPOCH_1_WINDOW)
            t.fail('the range path accepted a flipped epoch 1 head')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'the range path throws AttachmentError',
            )
        }
    })

test('multi-epoch tamper: openObject rejects a flipped epoch 1 leaf',
    async t => {
        const f = await multiEpochFixture()
        const bytes = await tamperedAt(leafOffset(f, LAST))
        try {
            await readObject(bytes)
            t.fail('openObject accepted a flipped leaf in epoch 1')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openObject throws AttachmentError',
            )
        }
    })

test('multi-epoch tamper: the stream rejects a flipped epoch 1 leaf',
    async t => {
        const f = await multiEpochFixture()
        const bytes = await tamperedAt(leafOffset(f, LAST))
        try {
            await readStream(bytes)
            t.fail('the stream accepted a flipped leaf in epoch 1')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'the stream throws AttachmentError',
            )
        }
    })

test('multi-epoch tamper: the range path rejects a flipped epoch 1 leaf',
    async t => {
        const f = await multiEpochFixture()
        const bytes = await tamperedAt(leafOffset(f, LAST))
        try {
            await readRange(bytes, EPOCH_1_WINDOW)
            t.fail('the range path accepted a flipped leaf in epoch 1')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'the range path throws AttachmentError',
            )
        }
    })
