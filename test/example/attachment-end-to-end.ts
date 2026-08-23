import { test } from '@substrate-system/tapzero'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import type {
    AttachmentFlowResult
} from '../../example/attachment-end-to-end.js'
import {
    attachmentEndToEnd,
    memoryObjectStore
} from '../../example/attachment-end-to-end.js'

/**
 * The README's attachment example is real code, so it has to keep
 * working. These drive it once and assert on what the flow observed:
 * a whole-object read, a range read, and the reference travelling as
 * the authenticated data of an application message.
 */

let cs:CiphersuiteImpl
let flow:AttachmentFlowResult

test('the ciphersuite initialises', async (t) => {
    cs = await getCipherSuite()
    t.ok(cs, 'should return a ciphersuite')
})

test('the example flow runs end to end', async (t) => {
    flow = await attachmentEndToEnd(cs)
    t.ok(flow, 'should return what the flow observed')
})

test('the caption arrives as the application message', async (t) => {
    t.equal(flow.caption, flow.sentCaption,
        'should decrypt to the caption that was sent')
})

test('the reference survives the round trip', async (t) => {
    t.deepEqual(flow.ref.objectId, flow.sentRef.objectId,
        'should recover the objectId from the authenticated data')
    t.deepEqual(flow.ref.snapshot, flow.sentRef.snapshot,
        'should recover the snapshot from the authenticated data')
    t.equal(flow.ref.plaintextLength, flow.sentRef.plaintextLength,
        'should recover the plaintext length')
})

test('the whole object decrypts to the original bytes', async (t) => {
    t.equal(flow.received.length, flow.plaintext.length,
        'should be the same length as the plaintext')
    t.deepEqual(
        Array.from(flow.received),
        Array.from(flow.plaintext),
        'should be byte for byte the plaintext'
    )
})

test('the range read returns just that slice', async (t) => {
    const { offset, length } = flow.rangeRequest
    const want = flow.plaintext.subarray(offset, offset + length)
    t.equal(flow.rangeBytes.length, length,
        'should return exactly the requested length')
    t.deepEqual(
        Array.from(flow.rangeBytes),
        Array.from(want),
        'should be the plaintext slice at that offset'
    )
})

test('the range read drives real HTTP Range requests', async (t) => {
    t.ok(flow.httpRanges.length > 0,
        'should have fetched at least one byte range')
    t.ok(
        flow.httpRanges.every(h => (/^bytes=\d+-\d+$/).test(h)),
        'should send a well formed Range header for each'
    )
    t.ok(flow.httpRanges.length < flow.storedLength,
        'should fetch fewer ranges than the object has bytes')
})

test('the store hands back only the bytes asked for', async (t) => {
    const store = memoryObjectStore()
    const id = new Uint8Array([1, 2, 3])
    await store.put(id, oneStream(new Uint8Array([9, 8, 7, 6, 5])))
    const got = await drain(store.getRange(id, 'bytes=1-3'))
    t.deepEqual(Array.from(got), [8, 7, 6],
        'should slice the stored object inclusively')
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
