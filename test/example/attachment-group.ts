import { test } from '@substrate-system/tapzero'
import { createDemoGroup } from '../../example/attachment-group.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { encryptAttachmentForGroup } from
    '../../src/attachment/writer.js'
import { decryptAttachmentStreamForGroup } from
    '../../src/attachment/reader.js'
import { openAttachmentRangeForGroup } from
    '../../src/attachment/range.js'
import { AttachmentError } from '../../src/attachment/error.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'

/**
 * The attachments demo derives its CEKs from a real group's key
 * schedule rather than from a random secret it invents, so these
 * cover the seam the demo builds that group through.
 */

let cs:CiphersuiteImpl

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

function oneStream (bytes:Uint8Array):ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start (controller) {
            controller.enqueue(bytes)
            controller.close()
        }
    })
}

test('the ciphersuite initialises', async (t) => {
    cs = await getCipherSuite()
    t.ok(cs, 'should return a ciphersuite')
})

test('createDemoGroup returns a real group at epoch 0', async (t) => {
    const state = await createDemoGroup(cs)
    t.equal(state.groupContext.epoch, 0n, 'should be at epoch 0')
    t.equal(
        state.keySchedule.applicationExportSecret.length,
        cs.kdf.size,
        'should carry a full-length application export secret'
    )
})

test('two demo groups get different export secrets', async (t) => {
    const one = await createDemoGroup(cs)
    const two = await createDemoGroup(cs)
    t.ok(
        one.keySchedule.applicationExportSecret.join() !==
            two.keySchedule.applicationExportSecret.join(),
        'should not repeat the export secret across groups'
    )
})

test('the group key schedule round-trips an attachment', async (t) => {
    const state = await createDemoGroup(cs)
    const plaintext = new Uint8Array(4096)
    plaintext.forEach((_, i) => { plaintext[i] = i & 0xff })
    const objectId = cs.rng.randomBytes(16)

    const enc = await encryptAttachmentForGroup(
        state.keySchedule, objectId, plaintext, cs
    )
    const plain = await drain(await decryptAttachmentStreamForGroup(
        state.keySchedule, enc.reference, oneStream(enc.bytes), cs
    ))

    t.equal(plain.join(), plaintext.join(),
        'should decrypt back to the same bytes')
})

test('a range read off the group schedule reads a window', async (t) => {
    const state = await createDemoGroup(cs)
    const plaintext = new Uint8Array(4096)
    plaintext.forEach((_, i) => { plaintext[i] = (i * 7) & 0xff })
    const objectId = cs.rng.randomBytes(16)

    const enc = await encryptAttachmentForGroup(
        state.keySchedule, objectId, plaintext, cs
    )
    const read = await openAttachmentRangeForGroup(
        state.keySchedule, enc.reference, { offset: 1000, length: 500 }, cs
    )
    try {
        const streams = read.ranges.map(r => oneStream(
            enc.bytes.slice(r.offset, r.offset + r.length)
        ))
        const window = await drain(read.decrypt(streams))
        t.equal(
            window.join(),
            plaintext.slice(1000, 1500).join(),
            'should decrypt exactly the requested window'
        )
    } finally {
        read.close()
    }
})

test('another group cannot read the attachment', async (t) => {
    const sender = await createDemoGroup(cs)
    const other = await createDemoGroup(cs)
    const plaintext = new Uint8Array(1024)
    const objectId = cs.rng.randomBytes(16)

    const enc = await encryptAttachmentForGroup(
        sender.keySchedule, objectId, plaintext, cs
    )

    try {
        await drain(await decryptAttachmentStreamForGroup(
            other.keySchedule, enc.reference, oneStream(enc.bytes), cs
        ))
        t.fail('should not decrypt under a different group')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'should throw AttachmentError'
        )
    }
})
