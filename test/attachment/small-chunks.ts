import { test } from '@substrate-system/tapzero'
import { sealObject } from '../../src/attachment/object.js'
import {
    decryptAttachmentStream,
} from '../../src/attachment/reader.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import { buildRef } from './attachment-fixtures.js'
import { chunked, drainStream } from './stream-helpers.js'

/**
 * A source that emits one byte per chunk is legal -- a socket adapter
 * or a `TransformStream` can produce it -- and it is the worst case
 * for the reader's chunk buffer. Block assembly used to re-sum the
 * whole buffer with `reduce` on every read and to consume it with
 * `Array.shift`, both quadratic in the chunk count.
 *
 * Measured on this fixture (132096 ciphertext bytes, so 132096
 * chunks): 44415ms before the fix, 104ms after. The budget below sits
 * between those by a wide margin in both directions, so it is not
 * flaky on a slow machine but still fails if the quadratic behaviour
 * returns. The ceiling also has to stay under the browser harness's
 * three-second silence timeout, which ends a run whose page has
 * printed nothing for that long.
 */
const BUDGET_MS = 2500

test('small-chunk source: block assembly is linear', async t => {
    const cek = new Uint8Array(32).fill(0x5C)
    const salt = new Uint8Array(32).fill(0x11)
    const objectId = new TextEncoder().encode('small-chunks')
    const crypto = await sealCryptoFromIds(2, 1)

    // Two segments: one full block plus a short final one.
    const plaintext = new Uint8Array(SEGMENT_MAX + 1024)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i * 7) % 256
    }

    const sealed = await sealObject(
        cek, objectId, plaintext, crypto, { salt },
    )
    const ref = buildRef(plaintext, objectId, sealed)

    const started = Date.now()
    const { total: recovered } = await drainStream(
        decryptAttachmentStream(
            cek, ref, chunked(sealed.bytes, 1), crypto,
        ),
    )
    const elapsed = Date.now() - started

    t.equal(
        recovered.length,
        plaintext.length,
        'recovered the whole plaintext from a 1-byte-chunk source',
    )

    let match = true
    for (let i = 0; i < plaintext.length; i++) {
        if (recovered[i] !== plaintext[i]) {
            match = false
            break
        }
    }
    t.ok(match, 'recovered bytes match the plaintext')

    t.ok(
        elapsed < BUDGET_MS,
        `decrypted ${sealed.bytes.length} bytes as ${
            sealed.bytes.length} chunks in ${elapsed}ms ` +
            `(budget ${BUDGET_MS}ms)`,
    )
})
