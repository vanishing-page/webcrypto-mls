import { test } from '@substrate-system/tapzero'
import { openAttachmentRange } from '../../src/attachment/range.js'
import type { AttachmentRangeRead } from
    '../../src/attachment/range.js'
import { encryptAttachment } from '../../src/attachment/writer.js'
import { attachmentCek } from '../../src/attachment/keys.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import { sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'
import { chunked, drainStream } from './stream-helpers.js'

/**
 * The range path's own drain, driven through `decrypt` with sources
 * the test controls. Every source here has `highWaterMark: 0`, so it
 * is pulled only when the drain reads, and `pulled` is exactly what
 * the drain asked for. Nothing waits on a timer: a source that must
 * stay open while the consumer cancels parks its `pull` on a promise
 * that only the cancel settles.
 */

const CHUNK = 4096

interface Source {
    stream:ReadableStream<Uint8Array>
    pulled:() => number
    cancelled:() => boolean
    /** Resolves once the source's cancel callback has run. */
    whenCancelled:Promise<void>
    /** Resolves once the source has been pulled at least once. */
    whenPulled:Promise<void>
}

/**
 * A counting source. It serves `bytes` in CHUNK-sized pieces, then
 * either closes, keeps sending zeros forever (`endless`), or parks
 * (`hang`) until it is cancelled.
 */
function source (
    bytes:Uint8Array,
    tail:'close'|'endless'|'hang' = 'close',
):Source {
    let offset = 0
    let pulled = 0
    let cancelled = false
    let onCancel!:() => void
    let onPull!:() => void
    const whenCancelled = new Promise<void>(resolve => {
        onCancel = resolve
    })
    const whenPulled = new Promise<void>(resolve => { onPull = resolve })
    const stream = new ReadableStream<Uint8Array>({
        pull (controller) {
            onPull()
            if (offset < bytes.length) {
                const chunk = bytes.slice(offset, offset + CHUNK)
                offset += chunk.length
                pulled += chunk.length
                controller.enqueue(chunk)
            } else if (tail === 'endless') {
                pulled += CHUNK
                controller.enqueue(new Uint8Array(CHUNK))
            } else if (tail === 'hang') {
                return whenCancelled
            } else {
                controller.close()
            }
        },
        cancel () {
            cancelled = true
            onCancel()
        },
    }, { highWaterMark: 0 })
    return {
        stream,
        pulled: () => pulled,
        cancelled: () => cancelled,
        whenCancelled,
        whenPulled,
    }
}

interface Fixture {
    read:AttachmentRangeRead
    sealed:Uint8Array
    plaintext:Uint8Array
    window:{ offset:number, length:number }
}

/**
 * A four-segment object read at segment 2, so the read needs two
 * disjoint ranges: the header through the gap, and block 2.
 */
async function fixture ():Promise<Fixture> {
    const cs = await getCipherSuite(getCiphersuiteFromName(
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    ))
    const objectId = new TextEncoder().encode('range-drain')
    const cek = await attachmentCek(
        { applicationExportSecret: new Uint8Array(32) }, objectId, cs,
    )
    const crypto = sealCryptoFromCiphersuite(cs)
    const plaintext = new Uint8Array(4 * SEGMENT_MAX)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i & 0xff
    const encrypted = await encryptAttachment(
        cek, objectId, plaintext, crypto,
    )
    const window = { offset: 2 * SEGMENT_MAX + 5, length: 100 }
    const read = await openAttachmentRange(
        cek, encrypted.reference, window, crypto,
    )
    return {
        read,
        sealed: encrypted.bytes,
        plaintext,
        window,
    }
}

function rangeBytes (f:Fixture, i:number):Uint8Array {
    const r = f.read.ranges[i]
    return f.sealed.slice(r.offset, r.offset + r.length)
}

/** Settle the output stream, returning the error it raised, if any. */
async function outcome (
    stream:ReadableStream<Uint8Array>,
):Promise<unknown> {
    try {
        await drainStream(stream)
        return null
    } catch (err) {
        return err
    }
}

test('range drain: the fixture needs two disjoint ranges', async t => {
    const f = await fixture()
    t.equal(f.read.ranges.length, 2, 'two ranges')
    f.read.close()
})

test('range drain: an oversized body is cut off', async t => {
    const f = await fixture()
    const extra = new Uint8Array(1 << 20)
    const first = rangeBytes(f, 0)
    const over = new Uint8Array(first.length + extra.length)
    over.set(first)
    const src0 = source(over)
    const src1 = source(rangeBytes(f, 1))

    const err = await outcome(f.read.decrypt([src0.stream, src1.stream]))

    t.ok(err instanceof AttachmentError, 'rejects with AttachmentError')
    await src0.whenCancelled
    t.ok(src0.cancelled(), 'the overrunning source is cancelled')
    t.ok(
        src0.pulled() <= f.read.ranges[0].length + CHUNK,
        'pulled at most one chunk past the range length',
    )
    await src1.whenCancelled
    t.ok(src1.cancelled(), 'the later source is cancelled')
    t.equal(src1.pulled(), 0, 'the later source was never pulled')
    f.read.close()
})

test('range drain: an endless body settles', async t => {
    const f = await fixture()
    const src0 = source(rangeBytes(f, 0))
    const src1 = source(rangeBytes(f, 1), 'endless')

    const err = await outcome(f.read.decrypt([src0.stream, src1.stream]))

    t.ok(err instanceof AttachmentError, 'rejects with AttachmentError')
    await src1.whenCancelled
    t.ok(src1.cancelled(), 'the endless source is cancelled')
    t.ok(
        src1.pulled() <= f.read.ranges[1].length + CHUNK,
        'pulled at most one chunk past the range length',
    )
    t.ok(!src0.cancelled(), 'a fully drained source is left alone')
    f.read.close()
})

test('range drain: a short body is still rejected', async t => {
    const f = await fixture()
    const first = rangeBytes(f, 0)
    const src0 = source(first.slice(0, first.length - 1))
    const src1 = source(rangeBytes(f, 1))

    const err = await outcome(f.read.decrypt([src0.stream, src1.stream]))

    t.ok(err instanceof AttachmentError, 'rejects with AttachmentError')
    f.read.close()
})

test('range drain: a failing source cancels the rest', async t => {
    const f = await fixture()
    const failing = new ReadableStream<Uint8Array>({
        pull () { throw new Error('network gone') },
    })
    const src1 = source(rangeBytes(f, 1))

    const err = await outcome(f.read.decrypt([failing, src1.stream]))

    t.ok(err instanceof AttachmentError, 'rejects with AttachmentError')
    await src1.whenCancelled
    t.ok(src1.cancelled(), 'the undrained source is cancelled')
    f.read.close()
})

test('range drain: a consumer cancel mid-drain cancels sources',
    async t => {
        const f = await fixture()
        const src0 = source(rangeBytes(f, 0), 'hang')
        const src1 = source(rangeBytes(f, 1))
        const out = f.read.decrypt([src0.stream, src1.stream])
        const reader = out.getReader()

        // Past the range length the source parks, so the drain is
        // provably in flight on source 0 when the cancel lands.
        const read = reader.read().catch(() => null)
        await src0.whenPulled
        await reader.cancel()
        await read

        await src0.whenCancelled
        t.ok(src0.cancelled(), 'the source being drained is cancelled')
        await src1.whenCancelled
        t.ok(src1.cancelled(), 'the later source is cancelled')
        t.equal(src1.pulled(), 0, 'the later source was never pulled')
        f.read.close()
    })

test('range drain: a well-formed read still decrypts', async t => {
    const f = await fixture()
    const streams = f.read.ranges.map((_, i) => chunked(
        rangeBytes(f, i), CHUNK,
    ))
    const { total } = await drainStream(f.read.decrypt(streams))
    const { offset, length } = f.window
    t.deepEqual(
        total,
        f.plaintext.slice(offset, offset + length),
        'plaintext matches',
    )
    f.read.close()
})
