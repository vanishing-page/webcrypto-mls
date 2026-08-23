import { test } from '@substrate-system/tapzero'
import {
    seekWindow,
    formatRanges,
    sliceRanges,
    errorStatus,
    releasePlayback,
    type PlaybackResources
} from '../../example/attachment-plan.js'
import { SAMPLE_RATE } from '../../example/attachment-audio.js'
import { createDemoGroup } from '../../example/attachment-group.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { encryptAttachmentForGroup } from
    '../../src/attachment/writer.js'
import { openAttachmentRangeForGroup } from
    '../../src/attachment/range.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'

/**
 * The attachments demo's own wiring: the arithmetic behind the seek
 * button, the range slicing it hands to `decrypt`, the status text on
 * a failure, and the teardown the stop button runs. All of it is
 * exercised through the exported functions, so none of these tests
 * touch preact or rendered markup.
 */

let cs:CiphersuiteImpl

test('the ciphersuite initialises', async (t) => {
    cs = await getCipherSuite()
    t.ok(cs, 'should return a ciphersuite')
})

test('seekWindow plans from the requested second', (t) => {
    const total = 12 * SAMPLE_RATE * 4
    const window = seekWindow(8, total)
    t.equal(window.offset, 8 * SAMPLE_RATE * 4,
        'should start at the sample the second lands on')
    t.equal(window.offset + window.length, total,
        'should run to the end of the plaintext')
})

test('seekWindow lands on a sample boundary', (t) => {
    // 8.0001s is mid-sample. bytesToPcm rejects an offset that is not
    // a multiple of four, so the plan has to floor to a whole sample.
    const total = 12 * SAMPLE_RATE * 4
    const window = seekWindow(8.0001, total)
    t.equal(window.offset % 4, 0, 'should be four-octet aligned')
    t.ok(window.offset >= 8 * SAMPLE_RATE * 4,
        'should not rewind before the requested second')
})

test('seekWindow rejects a seek past the end', (t) => {
    const total = 12 * SAMPLE_RATE * 4
    try {
        seekWindow(12, total)
        t.fail('should not plan an empty window')
    } catch (err) {
        t.ok(err instanceof AttachmentError,
            'should throw AttachmentError')
    }
})

test('seekWindow rejects a negative start', (t) => {
    try {
        seekWindow(-1, 4096)
        t.fail('should not plan a window before zero')
    } catch (err) {
        t.ok(err instanceof AttachmentError,
            'should throw AttachmentError')
    }
})

test('formatRanges reports kilobytes for a large range', (t) => {
    const text = formatRanges([{ offset: 2048, length: 4096 }])
    t.equal(text, '2-6 KB', 'should report the KB span')
})

test('formatRanges reports octets for a small range', (t) => {
    const text = formatRanges([{ offset: 0, length: 96 }])
    t.equal(text, '96 bytes', 'should report the byte count')
})

test('formatRanges joins every range it was given', (t) => {
    const text = formatRanges([
        { offset: 0, length: 96 },
        { offset: 65536, length: 131072 }
    ])
    t.equal(text, '96 bytes, 64-192 KB',
        'should list both ranges in order')
})

test('sliceRanges cuts one slice per range', (t) => {
    const bytes = new Uint8Array(256)
    bytes.forEach((_, i) => { bytes[i] = i & 0xff })
    const slices = sliceRanges(bytes, [
        { offset: 0, length: 16 },
        { offset: 200, length: 56 }
    ])
    t.equal(slices.length, 2, 'should return a slice per range')
    t.equal(slices[0].join(), bytes.slice(0, 16).join(),
        'should carry the first range exactly')
    t.equal(slices[1].join(), bytes.slice(200, 256).join(),
        'should carry the second range exactly')
})

test('sliceRanges rejects a range past the stored object', (t) => {
    // A short read would otherwise reach `decrypt` as a truncated
    // stream. This guard is the only thing that throws when
    // sliceRanges is called on its own.
    try {
        sliceRanges(new Uint8Array(64), [{ offset: 32, length: 64 }])
        t.fail('should not slice past the end')
    } catch (err) {
        t.ok(err instanceof AttachmentError,
            'should throw AttachmentError')
    }
})

test('errorStatus carries an Error message', (t) => {
    t.equal(errorStatus(new AttachmentError()),
        'Error: attachment integrity failure',
        'should prefix the error message')
})

test('errorStatus stringifies a non-Error throw', (t) => {
    t.equal(errorStatus('no ciphersuite'), 'Error: no ciphersuite',
        'should stringify whatever it was handed')
})

test('releasePlayback cancels the reader before the context', async t => {
    const order:string[] = []
    const refs:PlaybackResources = {
        streamReader: {
            cancel: async () => { order.push('cancel') }
        },
        audioContext: {
            close: async () => { order.push('close') }
        }
    }

    await releasePlayback(refs)

    t.equal(order.join(','), 'cancel,close',
        'should stop the read before tearing down the audio clock')
    t.equal(refs.streamReader, null, 'should drop the reader')
    t.equal(refs.audioContext, null, 'should drop the context')
})

test('releasePlayback survives a reader that already closed', async t => {
    let closed = false
    const refs:PlaybackResources = {
        streamReader: {
            cancel: () => Promise.reject(new Error('already released'))
        },
        audioContext: {
            close: async () => { closed = true }
        }
    }

    await releasePlayback(refs)

    t.equal(closed, true, 'should still close the audio context')
    t.equal(refs.streamReader, null, 'should drop the reader')
})

test('releasePlayback survives a context that already closed', async t => {
    const refs:PlaybackResources = {
        streamReader: null,
        audioContext: {
            close: () => Promise.reject(new Error('already closed'))
        }
    }

    await releasePlayback(refs)

    t.equal(refs.audioContext, null, 'should drop the context')
})

test('releasePlayback is a no-op with nothing open', async (t) => {
    const refs:PlaybackResources = {
        streamReader: null,
        audioContext: null
    }
    await releasePlayback(refs)
    t.equal(refs.streamReader, null, 'should leave the reader null')
    t.equal(refs.audioContext, null, 'should leave the context null')
})

test('the seek plan reads the window it asked for', async (t) => {
    const state = await createDemoGroup(cs)
    const seconds = 4
    const plaintext = new Uint8Array(seconds * SAMPLE_RATE * 4)
    plaintext.forEach((_, i) => { plaintext[i] = (i * 31) & 0xff })

    const enc = await encryptAttachmentForGroup(
        state.keySchedule, cs.rng.randomBytes(16), plaintext, cs
    )
    const window = seekWindow(3, plaintext.length)
    const read = await openAttachmentRangeForGroup(
        state.keySchedule, enc.reference, window, cs
    )

    try {
        const streams = sliceRanges(enc.bytes, read.ranges)
            .map(oneStream)
        const got = await drain(read.decrypt(streams))
        t.equal(
            got.join(),
            plaintext.slice(window.offset).join(),
            'should decrypt exactly the planned window'
        )
    } finally {
        read.close()
    }
})

test('a tampered object fails the seek read', async (t) => {
    const state = await createDemoGroup(cs)
    const plaintext = new Uint8Array(2 * SAMPLE_RATE * 4)
    plaintext.forEach((_, i) => { plaintext[i] = i & 0xff })

    const enc = await encryptAttachmentForGroup(
        state.keySchedule, cs.rng.randomBytes(16), plaintext, cs
    )
    const window = seekWindow(1, plaintext.length)
    const read = await openAttachmentRangeForGroup(
        state.keySchedule, enc.reference, window, cs
    )

    try {
        const tampered = enc.bytes.slice()
        tampered[tampered.length - 1] ^= 0xff
        const streams = sliceRanges(tampered, read.ranges).map(oneStream)
        await drain(read.decrypt(streams))
        t.fail('should not decrypt a tampered object')
    } catch (err) {
        t.ok(err instanceof AttachmentError,
            'should throw AttachmentError')
    } finally {
        read.close()
    }
})

function oneStream (bytes:Uint8Array):ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start (controller) {
            controller.enqueue(bytes)
            controller.close()
        }
    })
}

async function drain (
    stream:ReadableStream<Uint8Array>
):Promise<Uint8Array> {
    const chunks:Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
        out.set(c, at)
        at += c.length
    }
    return out
}
