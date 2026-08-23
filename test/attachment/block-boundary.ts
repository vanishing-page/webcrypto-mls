import { test } from '@substrate-system/tapzero'
import { sealObject, openObject } from '../../src/attachment/object.js'
import {
    decryptAttachmentStream,
} from '../../src/attachment/reader.js'
import {
    openAttachmentRange,
} from '../../src/attachment/range.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import type { AttachmentRef } from
    '../../src/attachment/reference.js'
import { buildRef } from './attachment-fixtures.js'
import { chunked, drainStream } from './stream-helpers.js'

/**
 * Block-boundary round-trips. `SEGMENT_MAX` is 65536, so a plaintext
 * of exactly that length is one full block with nothing after it, and
 * 65537 is one full block plus a one-octet final block. Those are the
 * two lengths where an off-by-one in `nSeg`, in the final block's
 * length, or in the reader's "is this the last block" test changes the
 * answer, and every other fixture in the suite sits away from them:
 * 131089 and 70000 have a large partial final block, and the
 * multi-epoch fixture is an exact multiple.
 *
 * The audit item is coverage, not a defect, so these are positive
 * round-trips only: seal, read back through each of the three paths,
 * compare byte for byte.
 */

const SIZES = [SEGMENT_MAX, SEGMENT_MAX + 1]

const CEK = new Uint8Array(32).fill(0xAA)
const SALT = new Uint8Array(32).fill(0x07)
const OBJECT_ID = new TextEncoder().encode('block-boundary')

type Fixture = {
    plaintext:Uint8Array
    sealed:{ bytes:Uint8Array, snapshot:Uint8Array }
    ref:AttachmentRef
    crypto:SealCrypto
}

/**
 * A plaintext whose byte at index i is `(i * 7 + 11) % 251`. 251 is
 * coprime with 65536, so the pattern does not repeat on a block
 * boundary and a block emitted twice, in the wrong order, or offset by
 * one is visible in the compared bytes.
 */
function patternOf (length:number):Uint8Array {
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i++) out[i] = ((i * 7) + 11) % 251
    return out
}

async function fixture (length:number):Promise<Fixture> {
    const crypto = await sealCryptoFromIds(2, 1)
    const plaintext = patternOf(length)
    const sealed = await sealObject(
        CEK, OBJECT_ID, plaintext, crypto, { salt: SALT },
    )
    return {
        plaintext,
        sealed,
        ref: buildRef(plaintext, OBJECT_ID, sealed),
        crypto,
    }
}

/** Index of the first differing byte, -2 on a length mismatch, else -1. */
function firstMismatch (actual:Uint8Array, expected:Uint8Array):number {
    if (actual.length !== expected.length) return -2
    for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i]) return i
    }
    return -1
}

/** Read `range` through the range path, serving bytes from `f.sealed`. */
async function readRange (
    f:Fixture,
    range:{ offset:number, length:number },
):Promise<Uint8Array> {
    const read = await openAttachmentRange(
        CEK, f.ref, range, f.crypto,
    )
    try {
        const streams = read.ranges.map(r => chunked(
            f.sealed.bytes.slice(r.offset, r.offset + r.length), 8192,
        ))
        const { total } = await drainStream(read.decrypt(streams))
        return total
    } finally {
        read.close()
    }
}

for (const size of SIZES) {
    test(`block boundary: object path round-trips ${size} bytes`,
        async t => {
            const f = await fixture(size)
            const out = await openObject(
                CEK, OBJECT_ID, f.sealed.bytes, {
                    snapshot: f.sealed.snapshot,
                    plaintextLength: size,
                }, f.crypto,
            )
            t.equal(out.length, size, `openObject returned ${size} bytes`)
            t.equal(
                firstMismatch(out, f.plaintext), -1,
                'object path matches byte for byte',
            )
        })

    test(`block boundary: stream path round-trips ${size} bytes`,
        async t => {
            const f = await fixture(size)
            // A chunk size that divides neither SEGMENT_MAX nor the
            // ciphertext length, so block boundaries fall inside
            // chunks rather than between them.
            const { total } = await drainStream(decryptAttachmentStream(
                CEK, f.ref, chunked(f.sealed.bytes, 7000), f.crypto,
            ))
            t.equal(total.length, size, `stream emitted ${size} bytes`)
            t.equal(
                firstMismatch(total, f.plaintext), -1,
                'stream path matches byte for byte',
            )
        })

    test(`block boundary: range path round-trips all ${size} bytes`,
        async t => {
            const f = await fixture(size)
            const out = await readRange(f, { offset: 0, length: size })
            t.equal(out.length, size, `range read returned ${size} bytes`)
            t.equal(
                firstMismatch(out, f.plaintext), -1,
                'range path matches byte for byte',
            )
        })
}

test('block boundary: range window over the last octet of 65537',
    async t => {
        // The one-octet final block, read on its own. A reader that
        // sizes the last block as a full segment cannot serve this.
        const f = await fixture(SEGMENT_MAX + 1)
        const out = await readRange(f, { offset: SEGMENT_MAX, length: 1 })
        t.equal(out.length, 1, 'window is one octet')
        t.equal(
            firstMismatch(out, f.plaintext.slice(SEGMENT_MAX)), -1,
            'the final octet matches',
        )
    })

test('block boundary: range window straddling the 65536 boundary',
    async t => {
        const f = await fixture(SEGMENT_MAX + 1)
        const range = { offset: SEGMENT_MAX - 8, length: 9 }
        const out = await readRange(f, range)
        t.equal(out.length, 9, 'window spans both blocks')
        t.equal(
            firstMismatch(out, f.plaintext.slice(
                range.offset, range.offset + range.length,
            )), -1,
            'the straddling window matches',
        )
    })
