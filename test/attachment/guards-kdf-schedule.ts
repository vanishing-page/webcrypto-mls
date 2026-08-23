import { test } from '@substrate-system/tapzero'
import { frame, lh, uint16be } from '../../src/attachment/kdf.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import { startSeal, SALT_LENGTH } from
    '../../src/attachment/schedule.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { fromHex, paramsFromVector } from './helpers.js'
import F1 from '../../test_vectors/seal/core/F1.json'

// Three guards the mutation pass found unprotected. Each test is
// pinned at the layer where the guard is the only thing that throws.

/**
 * kdf.ts frame(): a field longer than 0xFFFE is replaced by
 * 0xFFFF || LH(x) rather than length-prefixed, because a u16 cannot
 * carry the length. Delete the branch and a 0xFFFF-octet field frames
 * as 0xFFFF || x, so the output is 65537 octets instead of 2 + Nh and
 * the bytes past the prefix are the field, not its hash.
 */
test('US-022a: frame replaces an over-long field with its hash',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const { kdf } = crypto
        const long = new Uint8Array(0xFFFF).fill(0x5a)

        const framed = await frame(long, kdf)
        const expected = await lh(long, kdf)

        t.equal(
            framed.length,
            2 + kdf.size,
            'an over-long field frames to a prefix plus one hash',
        )
        t.deepEqual(
            Array.from(framed.slice(0, 2)),
            Array.from(uint16be(0xFFFF)),
            'the prefix is the 0xFFFF escape',
        )
        t.deepEqual(
            Array.from(framed.slice(2)),
            Array.from(expected),
            'the body is LH(x), not x',
        )
    },
)

/**
 * The other side of the same boundary: 0xFFFE octets is the longest
 * field that still frames literally. This pins `<=` against `<`.
 */
test('US-022a: frame keeps the longest in-range field literal',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const { kdf } = crypto
        const atLimit = new Uint8Array(0xFFFE).fill(0x27)

        const framed = await frame(atLimit, kdf)

        t.equal(
            framed.length,
            2 + 0xFFFE,
            'a 0xFFFE-octet field frames to its own length',
        )
        t.deepEqual(
            Array.from(framed.slice(0, 2)),
            Array.from(uint16be(0xFFFE)),
            'the prefix is the real length',
        )
        t.deepEqual(
            Array.from(framed.slice(2)),
            Array.from(atLimit),
            'the body is the field itself',
        )
    },
)

/**
 * crypto.ts sealCryptoFromIds(): an id outside the two registry tables
 * is an AttachmentError, not whatever the primitive constructors
 * happen to throw when handed an undefined algorithm name.
 */
test('US-022a: sealCryptoFromIds rejects an unknown aead id',
    async t => {
        try {
            await sealCryptoFromIds(0x00FF, 1)
            t.fail('should reject an aead id with no registry entry')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

test('US-022a: sealCryptoFromIds rejects an unknown kdf id',
    async t => {
        try {
            await sealCryptoFromIds(2, 0x00FF)
            t.fail('should reject a kdf id with no registry entry')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

/**
 * schedule.ts validateParams(): the salt is a fixed-width raw field in
 * the extract input, so a short or long one shifts every field after
 * it and derives a schedule no other implementation would agree with.
 * Nothing downstream notices -- delete the check and both of these
 * seal happily -- so this is the only layer that can pin it.
 */
test('US-022a: startSeal rejects a short salt', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const params = paramsFromVector(F1)
    const bad = { ...params, salt: new Uint8Array(SALT_LENGTH - 1) }

    try {
        await startSeal(
            fromHex(F1.cek_hex), bad, new Uint8Array(), crypto,
        )
        t.fail('should reject a salt shorter than SALT_LENGTH')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'should throw AttachmentError',
        )
    }
})

test('US-022a: startSeal rejects a long salt', async t => {
    const crypto = await sealCryptoFromIds(2, 1)
    const params = paramsFromVector(F1)
    const bad = { ...params, salt: new Uint8Array(SALT_LENGTH + 1) }

    try {
        await startSeal(
            fromHex(F1.cek_hex), bad, new Uint8Array(), crypto,
        )
        t.fail('should reject a salt longer than SALT_LENGTH')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'should throw AttachmentError',
        )
    }
})
