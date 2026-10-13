import { test } from '@substrate-system/tapzero'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { encryptAttachment } from '../../src/attachment/writer.js'
import { decryptAttachmentStream } from '../../src/attachment/reader.js'
import { openAttachmentRange } from '../../src/attachment/range.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'
import { chunked, drainStream } from './stream-helpers.js'
import { recordingSuite, isZeroed } from './kdf-recorder.js'

// Audit 2026-10 F7: a KDF that rejects partway through building a
// schedule, or partway through the root check that follows it, must
// not leave the keys it had already derived live in memory. Every
// assertion reads the buffers the KDF handed out, so it observes the
// overwrite from outside without reaching into a SealState.

class InjectedKdfError extends Error {}

async function fixture (label:string) {
    const cs = await getCipherSuite(getCiphersuiteFromName(
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    ))
    const rec = recordingSuite(cs)
    const crypto = sealCryptoFromCiphersuite(rec.cs)
    const cek = new Uint8Array(32)
    for (let i = 0; i < cek.length; i++) cek[i] = i + 1
    const cekCopy = cek.slice()
    const oid = new TextEncoder().encode(label)
    const plaintext = new Uint8Array(3000)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 251
    const encrypted = await encryptAttachment(
        cek, oid, plaintext, crypto,
    )
    rec.recorded.length = 0
    return { rec, crypto, cek, cekCopy, oid, plaintext, encrypted }
}

type T = {
    ok:(v:unknown, m?:string) => void
    equal:(a:unknown, b:unknown, m?:string) => void
}

/**
 * Each named derivation ran exactly once and its output is zero now.
 * Asserting the count first keeps a derivation that never ran from
 * passing as "every output is zero" over an empty list.
 */
function assertScheduleZeroed (
    t:T,
    rec:ReturnType<typeof recordingSuite>,
    labels:string[],
):void {
    for (const label of labels) {
        const outs = rec.outputs(label)
        t.equal(outs.length, 1, `${label} was derived once`)
        t.ok(outs.every(isZeroed), `${label} is zeroed`)
    }
}

function sameBytes (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

test('F7: a KDF rejecting at nonce_base during a sequential read ' +
    'leaves no derived key live', async t => {
    const f = await fixture('f7-reader-nonce-base')
    f.rec.rejectAt('nonce_base', new InjectedKdfError())

    const stream = decryptAttachmentStream(
        f.cek, f.encrypted.reference,
        chunked(f.encrypted.bytes, 1024), f.crypto,
    )
    let caught:unknown = null
    try {
        await drainStream(stream)
    } catch (err) {
        caught = err
    }

    t.ok(caught instanceof AttachmentError,
        'the read rejects with the opaque AttachmentError')
    assertScheduleZeroed(t, f.rec, ['commit', 'payload_key', 'acc_key'])
    t.ok(sameBytes(f.cek, f.cekCopy), 'the borrowed CEK is unchanged')
})

test('F7: a KDF rejecting at nonce_base during a seal rejects with ' +
    'the original error and leaves no derived key live', async t => {
    const f = await fixture('f7-seal-nonce-base')
    const injected = new InjectedKdfError()
    f.rec.rejectAt('nonce_base', injected)

    let caught:unknown = null
    try {
        await encryptAttachment(f.cek, f.oid, f.plaintext, f.crypto)
    } catch (err) {
        caught = err
    }

    // The seal path does not wrap a crypto failure (see "One error
    // type, on purpose" in src/attachment/AGENTS.md), so the cleanup
    // must not replace it either.
    t.ok(caught === injected, 'the seal rejects with the KDF error itself')
    t.ok(caught instanceof InjectedKdfError, 'of the same class')
    assertScheduleZeroed(t, f.rec, ['commit', 'payload_key', 'acc_key'])
    t.ok(sameBytes(f.cek, f.cekCopy), 'the borrowed CEK is unchanged')
})

/**
 * Open a range read with the caller's own CEK (borrowed, not owned)
 * and drain it, returning what it rejected with, or null.
 */
async function rangeRead (
    f:Awaited<ReturnType<typeof fixture>>,
    ref = f.encrypted.reference,
):Promise<unknown> {
    const read = await openAttachmentRange(
        f.cek, ref, { offset: 10, length: 100 }, f.crypto,
    )
    const streams = read.ranges.map(r => chunked(
        f.encrypted.bytes.slice(r.offset, r.offset + r.length), 512,
    ))
    try {
        await drainStream(read.decrypt(streams))
        return null
    } catch (err) {
        return err
    } finally {
        read.close()
    }
}

const SCHEDULE_KEYS = ['payload_key', 'acc_key', 'nonce_base']

test('F7: a KDF rejecting at the snapshot epoch root during a range ' +
    "read's root check leaves the schedule zeroed", async t => {
    const f = await fixture('f7-range-root')
    f.rec.rejectAt('snap_epoch_root', new InjectedKdfError())

    const caught = await rangeRead(f)

    t.ok(caught instanceof AttachmentError,
        'the range read rejects with the opaque AttachmentError')
    assertScheduleZeroed(t, f.rec, SCHEDULE_KEYS)
    t.ok(sameBytes(f.cek, f.cekCopy), 'the borrowed CEK is unchanged')
})

/** The fixture's reference with one bit of its snapshot flipped. */
function tamperedRef (f:Awaited<ReturnType<typeof fixture>>) {
    const snapshot = f.encrypted.reference.snapshot.slice()
    snapshot[0] ^= 0x01
    return { ...f.encrypted.reference, snapshot }
}

test('F7: a root mismatch on a range read, honest KDF, still ' +
    'rejects and leaves the schedule zeroed', async t => {
    const f = await fixture('f7-range-mismatch')
    const caught = await rangeRead(f, tamperedRef(f))

    t.ok(caught instanceof AttachmentError,
        'the range read rejects with AttachmentError')
    t.equal(f.rec.outputs('snap_epoch_root').length, 1,
        'the root check ran')
    assertScheduleZeroed(t, f.rec, SCHEDULE_KEYS)
    t.ok(sameBytes(f.cek, f.cekCopy), 'the borrowed CEK is unchanged')
})

test('F7: a root mismatch on a sequential read, honest KDF, still ' +
    'rejects and leaves the schedule zeroed', async t => {
    const f = await fixture('f7-reader-mismatch')
    const stream = decryptAttachmentStream(
        f.cek, tamperedRef(f), chunked(f.encrypted.bytes, 1024), f.crypto,
    )
    let caught:unknown = null
    try {
        await drainStream(stream)
    } catch (err) {
        caught = err
    }

    t.ok(caught instanceof AttachmentError,
        'the read rejects with AttachmentError')
    t.equal(f.rec.outputs('snap_epoch_root').length, 1,
        'the root check ran')
    assertScheduleZeroed(t, f.rec, SCHEDULE_KEYS)
    t.ok(sameBytes(f.cek, f.cekCopy), 'the borrowed CEK is unchanged')
})

test('F7: with an honest KDF, seal, sequential read and range read ' +
    'still return the plaintext', async t => {
    const f = await fixture('f7-round-trip')

    const { total } = await drainStream(decryptAttachmentStream(
        f.cek, f.encrypted.reference,
        chunked(f.encrypted.bytes, 1024), f.crypto,
    ))
    t.ok(sameBytes(total, f.plaintext), 'the sequential read matches')

    const read = await openAttachmentRange(
        f.cek, f.encrypted.reference, { offset: 10, length: 100 }, f.crypto,
    )
    const window = await drainStream(read.decrypt(read.ranges.map(r =>
        chunked(f.encrypted.bytes.slice(r.offset, r.offset + r.length), 512)
    )))
    read.close()
    t.ok(sameBytes(window.total, f.plaintext.subarray(10, 110)),
        'the range read matches')
})
