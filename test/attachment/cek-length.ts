import { test } from '@substrate-system/tapzero'
import { sealObject, openObject } from '../../src/attachment/object.js'
import { encryptAttachment } from '../../src/attachment/writer.js'
import { decryptAttachmentStream } from '../../src/attachment/reader.js'
import { openAttachmentRange } from '../../src/attachment/range.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import { CEK_LENGTH } from '../../src/attachment/keys.js'
import { AttachmentError } from '../../src/attachment/error.js'

// Every length that is not CEK_LENGTH, at the three sizes that break
// differently: empty, short-but-plausible, and one octet too long.
const BAD_LENGTHS = [0, 16, 33]

const objectId = new TextEncoder().encode('cek-length-object')
const plaintext = new Uint8Array(1024).fill(0x5A)

function goodCek ():Uint8Array {
    return new Uint8Array(CEK_LENGTH).fill(0xC7)
}

/**
 * A SealCrypto whose KDF counts its calls. The length guard has to
 * fire before any derivation happens, otherwise `openObject` would
 * only be rejecting the wrong-length CEK the way it rejects any wrong
 * CEK -- on the commitment -- and the test would pass with the guard
 * deleted.
 */
function countingCrypto (crypto:SealCrypto):{
    crypto:SealCrypto
    calls:() => number
} {
    let n = 0
    return {
        crypto: {
            ...crypto,
            kdf: {
                size: crypto.kdf.size,
                extract: (salt, ikm) => {
                    n++
                    return crypto.kdf.extract(salt, ikm)
                },
                expand: (prk, info, len) => {
                    n++
                    return crypto.kdf.expand(prk, info, len)
                },
            },
        },
        calls: () => n,
    }
}

test('US-015: sealObject rejects a wrong-length CEK', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    for (const len of BAD_LENGTHS) {
        try {
            await sealObject(
                new Uint8Array(len), objectId, plaintext, crypto,
            )
            t.fail(`sealObject accepted a ${len}-octet CEK`)
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                `sealObject rejects a ${len}-octet CEK`,
            )
        }
    }
})

test('US-015: encryptAttachment rejects a wrong-length CEK', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    for (const len of BAD_LENGTHS) {
        try {
            await encryptAttachment(
                new Uint8Array(len), objectId, plaintext, crypto,
            )
            t.fail(`encryptAttachment accepted a ${len}-octet CEK`)
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                `encryptAttachment rejects a ${len}-octet CEK`,
            )
        }
    }
})

test(
    'US-015: openObject rejects a wrong-length CEK before deriving',
    async t => {
        const base = await sealCryptoFromIds(2, 1)
        const sealed = await sealObject(
            goodCek(), objectId, plaintext, base,
        )
        const ref = {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }

        for (const len of BAD_LENGTHS) {
            const counted = countingCrypto(base)
            try {
                await openObject(
                    new Uint8Array(len), objectId, sealed.bytes, ref,
                    counted.crypto,
                )
                t.fail(`openObject accepted a ${len}-octet CEK`)
            } catch (err) {
                t.ok(
                    err instanceof AttachmentError,
                    `openObject rejects a ${len}-octet CEK`,
                )
            }
            t.equal(
                counted.calls(), 0,
                `openObject derives nothing for a ${len}-octet CEK`,
            )
        }
    },
)

test('US-015: a CEK_LENGTH CEK still round-trips', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const encrypted = await encryptAttachment(
        goodCek(), objectId, plaintext, crypto,
    )
    const opened = await openObject(
        goodCek(), objectId, encrypted.bytes,
        {
            snapshot: encrypted.reference.snapshot,
            plaintextLength: Number(encrypted.reference.plaintextLength),
        },
        crypto,
    )
    t.equal(opened.length, plaintext.length, 'round-trip length matches')
    t.ok(
        opened.every((b, i) => b === plaintext[i]),
        'round-trip bytes match',
    )
})

/**
 * A source that counts how often it was pulled. A reader that checked
 * the CEK only at the commitment gate would have pulled at least once.
 */
function countingSource (bytes:Uint8Array):{
    stream:ReadableStream<Uint8Array>
    pulls:() => number
} {
    let n = 0
    return {
        stream: new ReadableStream<Uint8Array>({
            pull (controller) {
                n++
                controller.enqueue(bytes)
                controller.close()
            },
        }, { highWaterMark: 0 }),
        pulls: () => n,
    }
}

function byteStream (bytes:Uint8Array):ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start (controller) {
            controller.enqueue(bytes)
            controller.close()
        },
    })
}

async function encrypted () {
    const crypto = await sealCryptoFromIds(2, 1)
    const enc = await encryptAttachment(
        goodCek(), objectId, plaintext, crypto,
    )
    return { crypto, enc }
}

test(
    'decryptAttachmentStream rejects a wrong-length CEK before reading',
    async t => {
        const { crypto, enc } = await encrypted()
        for (const len of BAD_LENGTHS) {
            const src = countingSource(enc.bytes)
            try {
                decryptAttachmentStream(
                    new Uint8Array(len), enc.reference, src.stream, crypto,
                )
                t.fail(`decryptAttachmentStream accepted ${len} octets`)
            } catch (err) {
                t.ok(
                    err instanceof AttachmentError,
                    `decryptAttachmentStream rejects a ${len}-octet CEK`,
                )
            }
            t.equal(src.pulls(), 0, `no pulls for a ${len}-octet CEK`)
        }
    },
)

test('openAttachmentRange rejects a wrong-length CEK', async t => {
    const { crypto, enc } = await encrypted()
    for (const len of BAD_LENGTHS) {
        try {
            await openAttachmentRange(
                new Uint8Array(len), enc.reference,
                { offset: 0, length: 10 }, crypto,
            )
            t.fail(`openAttachmentRange accepted ${len} octets`)
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                `openAttachmentRange rejects a ${len}-octet CEK`,
            )
        }
    }
})

test('a CEK_LENGTH CEK still reads through the stream', async t => {
    const { crypto, enc } = await encrypted()
    const out = await new Response(decryptAttachmentStream(
        goodCek(), enc.reference, byteStream(enc.bytes), crypto,
    )).arrayBuffer()
    t.equal(out.byteLength, plaintext.length, 'stream length matches')
})

test('openAttachmentRange rejects non-finite ranges', async t => {
    const { crypto, enc } = await encrypted()
    for (const bad of [NaN, Infinity, -Infinity]) {
        for (const range of [
            { offset: bad, length: 10 },
            { offset: 0, length: bad },
        ]) {
            try {
                await openAttachmentRange(
                    goodCek(), enc.reference, range, crypto,
                )
                t.fail(`accepted ${range.offset}, ${range.length}`)
            } catch (err) {
                t.ok(
                    err instanceof AttachmentError,
                    `rejects ${range.offset}, ${range.length}`,
                )
            }
        }
    }
})

test('mutating the returned ranges does not change the read', async t => {
    const { crypto, enc } = await encrypted()
    const range = { offset: 100, length: 50 }
    const read = await openAttachmentRange(
        goodCek(), enc.reference, range, crypto,
    )
    // Fetch from the plan as returned, then vandalize it.
    const streams = read.ranges.map(r => byteStream(
        enc.bytes.subarray(r.offset, r.offset + r.length),
    ))
    read.ranges[0].offset = 7
    read.ranges[0].length = 1
    read.ranges.push({ offset: 0, length: 1 })

    const out = new Uint8Array(
        await new Response(read.decrypt(streams)).arrayBuffer(),
    )
    t.equal(out.length, range.length, 'decrypt returns the range')
    t.ok(
        out.every((b, i) => b === plaintext[range.offset + i]),
        'decrypt returns the right bytes',
    )
})
