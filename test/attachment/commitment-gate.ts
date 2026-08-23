import { test } from '@substrate-system/tapzero'
import { sealObject, openObject } from '../../src/attachment/object.js'
import { decryptAttachmentStream } from '../../src/attachment/reader.js'
import { openAttachmentRange } from '../../src/attachment/range.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import type { AttachmentRef } from '../../src/attachment/reference.js'
import { CEK_LENGTH } from '../../src/attachment/keys.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { buildRef } from './attachment-fixtures.js'
import { chunked, drainStream } from './stream-helpers.js'

/**
 * US-022 (PRD US-021): the key-commitment gate, exercised through the
 * three public read entry points rather than through `startOpen`.
 *
 * A wrong CEK and a wrong objectId both land on the same gate, because
 * the objectId enters the commitment and nothing else. What this file
 * pins is that every entry point reaches the gate at all, and that all
 * six failures are indistinguishable from the failure a tampered
 * object produces -- an opaque `AttachmentError` carrying no detail.
 *
 * WHAT THIS FILE DOES NOT PIN: the gate itself. Delete the commitment
 * compare in `startOpen` and every assertion here still passes,
 * because the snapshot root check one layer down also depends on the
 * CEK and rejects first. That is the redundant-guard shape described
 * in progress.log: the guard is pinned where it is the only thing that
 * throws -- `test/attachment/seal-core.ts`, which calls `startOpen`
 * directly and asserts it rejects before touching the AEAD -- and this
 * file is the separate reachability half, covering the public entry
 * points.
 */

const OBJECT_ID = new TextEncoder().encode('commitment-gate-object')
const WRONG_OBJECT_ID = new TextEncoder().encode('commitment-gate-otherx')

// Two segments' worth, so the range path has a window to ask for that
// is not the whole object.
const PLAINTEXT_LENGTH = 128 * 1024

function goodCek ():Uint8Array {
    return new Uint8Array(CEK_LENGTH).fill(0x2B)
}

/** A CEK of the right length that differs in exactly one bit. */
function wrongCek ():Uint8Array {
    const cek = goodCek()
    cek[0] ^= 0x01
    return cek
}

interface Fixture {
    crypto:SealCrypto
    plaintext:Uint8Array
    bytes:Uint8Array
    ref:AttachmentRef
}

let cached:Promise<Fixture>|null = null

function fixture ():Promise<Fixture> {
    if (!cached) cached = build()
    return cached
}

async function build ():Promise<Fixture> {
    const crypto = await sealCryptoFromIds(2, 1)
    const plaintext = new Uint8Array(PLAINTEXT_LENGTH)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i & 0xFF
    const sealed = await sealObject(goodCek(), OBJECT_ID, plaintext, crypto)
    return {
        crypto,
        plaintext,
        bytes: sealed.bytes,
        ref: buildRef(plaintext, OBJECT_ID, sealed),
    }
}

/** A ref for the same object under a different objectId. */
function refWithObjectId (ref:AttachmentRef, objectId:Uint8Array) {
    return { ...ref, objectId: objectId.slice() }
}

/**
 * The three public read entry points, each reduced to "decrypt this
 * whole object with this CEK and this objectId, or throw".
 */
const ENTRY_POINTS:Array<{
    name:string
    read:(
        f:Fixture, cek:Uint8Array, objectId:Uint8Array
    ) => Promise<Uint8Array>
}> = [
    {
        name: 'openObject',
        read: (f, cek, objectId) => openObject(
            cek,
            objectId,
            f.bytes,
            {
                snapshot: f.ref.snapshot,
                plaintextLength: Number(f.ref.plaintextLength),
            },
            f.crypto,
        ),
    },
    {
        name: 'decryptAttachmentStream',
        read: async (f, cek, objectId) => {
            const stream = decryptAttachmentStream(
                cek,
                refWithObjectId(f.ref, objectId),
                chunked(f.bytes, 1 << 16),
                f.crypto,
            )
            const { total } = await drainStream(stream)
            return total
        },
    },
    {
        name: 'openAttachmentRange',
        read: async (f, cek, objectId) => {
            // A window inside the second segment, so the read is a
            // real partial fetch and not the whole object by another
            // name.
            const range = { offset: 70000, length: 256 }
            const read = await openAttachmentRange(
                cek, refWithObjectId(f.ref, objectId), range, f.crypto,
            )
            try {
                const streams = read.ranges.map(r => chunked(
                    f.bytes.slice(r.offset, r.offset + r.length), 1 << 16,
                ))
                const { total } = await drainStream(read.decrypt(streams))
                return total
            } finally {
                read.close()
            }
        },
    },
]

/**
 * Everything a caller can observe about a thrown error, as one string.
 * Comparing these against a baseline is what "the same opaque error"
 * means: not merely the same class, but the same message and the same
 * set of own properties, so nothing distinguishes a wrong key from a
 * wrong objectId from a tampered byte.
 */
function shapeOf (err:unknown):string {
    const e = err as Error
    return JSON.stringify({
        ctor: e?.constructor?.name,
        name: e?.name,
        message: e?.message,
        keys: Object.keys(e ?? {}).sort(),
    })
}

/**
 * A SealCrypto that counts AEAD decrypt calls. Everything else is
 * passed straight through.
 *
 * The count pins a property of the read paths, not of the commitment
 * gate: no entry point attempts to open ciphertext under a key it has
 * not already accepted. Two layers hold that jointly (see the file
 * comment), so removing either one alone leaves it true.
 */
function countingAead (crypto:SealCrypto):{
    crypto:SealCrypto
    decrypts:() => number
} {
    let n = 0
    return {
        crypto: {
            ...crypto,
            aead: {
                encrypt: crypto.aead.encrypt,
                decrypt: (key, nonce, aad, ct) => {
                    n++
                    return crypto.aead.decrypt(key, nonce, aad, ct)
                },
            },
        },
        decrypts: () => n,
    }
}

/** Run `read` and return what it threw, or null if it returned. */
async function thrownBy (
    read:() => Promise<Uint8Array>,
):Promise<unknown> {
    try {
        await read()
        return null
    } catch (err) {
        return err
    }
}

test('US-022: every read entry point rejects a wrong CEK', async t => {
    const f = await fixture()
    for (const entry of ENTRY_POINTS) {
        const err = await thrownBy(() => entry.read(f, wrongCek(), OBJECT_ID))
        t.ok(
            err instanceof AttachmentError,
            `${entry.name} rejects a wrong CEK with AttachmentError`,
        )
    }
})

test('US-022: every read entry point rejects a wrong objectId', async t => {
    const f = await fixture()
    for (const entry of ENTRY_POINTS) {
        const err = await thrownBy(
            () => entry.read(f, goodCek(), WRONG_OBJECT_ID),
        )
        t.ok(
            err instanceof AttachmentError,
            `${entry.name} rejects a wrong objectId with AttachmentError`,
        )
    }
})

test('US-022: all six failures are the same opaque error', async t => {
    const f = await fixture()

    // Baseline: the correct key and objectId against a tampered
    // object. This is the failure the others must be indistinguishable
    // from. Flip a payload byte well past the header.
    const tampered = f.bytes.slice()
    tampered[tampered.length - 1] ^= 0xFF
    const baseline = await thrownBy(() => openObject(
        goodCek(),
        OBJECT_ID,
        tampered,
        {
            snapshot: f.ref.snapshot,
            plaintextLength: Number(f.ref.plaintextLength),
        },
        f.crypto,
    ))
    t.ok(
        baseline instanceof AttachmentError,
        'a tampered object throws AttachmentError',
    )

    const want = shapeOf(baseline)
    for (const entry of ENTRY_POINTS) {
        const badKey = await thrownBy(
            () => entry.read(f, wrongCek(), OBJECT_ID),
        )
        t.equal(
            shapeOf(badKey), want,
            `${entry.name} wrong CEK is indistinguishable from tampering`,
        )
        const badId = await thrownBy(
            () => entry.read(f, goodCek(), WRONG_OBJECT_ID),
        )
        t.equal(
            shapeOf(badId), want,
            `${entry.name} wrong objectId is indistinguishable ` +
            'from tampering',
        )
    }
})

test('US-022: the right CEK and objectId still read', async t => {
    const f = await fixture()
    for (const entry of ENTRY_POINTS) {
        const out = await entry.read(f, goodCek(), OBJECT_ID)
        t.ok(out.length > 0, `${entry.name} reads with the right inputs`)
    }
})

test(
    'US-022: no entry point attempts an AEAD open on a bad key',
    async t => {
        const f = await fixture()
        const cases:Array<{
            label:string, cek:Uint8Array, objectId:Uint8Array
        }> = [
            { label: 'wrong CEK', cek: wrongCek(), objectId: OBJECT_ID },
            {
                label: 'wrong objectId',
                cek: goodCek(),
                objectId: WRONG_OBJECT_ID,
            },
        ]

        for (const entry of ENTRY_POINTS) {
            for (const c of cases) {
                const counted = countingAead(f.crypto)
                const counting = { ...f, crypto: counted.crypto }
                const err = await thrownBy(
                    () => entry.read(counting, c.cek, c.objectId),
                )
                t.ok(
                    err instanceof AttachmentError,
                    `${entry.name} rejects a ${c.label}`,
                )
                t.equal(
                    counted.decrypts(), 0,
                    `${entry.name} attempts no AEAD open for a ` +
                    c.label,
                )
            }
        }
    },
)
