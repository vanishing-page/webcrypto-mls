import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl } from
    '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { encryptAttachment } from '../../src/attachment/writer.js'
import {
    decryptAttachmentStream,
    decryptAttachmentStreamForGroup,
} from '../../src/attachment/reader.js'
import {
    openAttachmentRange,
    openAttachmentRangeForGroup,
} from '../../src/attachment/range.js'
import { attachmentCek } from '../../src/attachment/keys.js'
import { sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'
import { chunked, drainStream } from './stream-helpers.js'
import {
    recordingSuite, pureKdfSuite, settle, isZeroed,
} from './kdf-recorder.js'

// Audit 2026-10 F4: a cancel that lands while the commitment gate's
// schedule is still being derived. The whole object arrives in the
// first chunk, so once the derivation resumes nothing in start() has
// to read the (cancelled) source again, and the regression was that
// startup ran to completion with a live schedule nobody would wipe.
//
// Every assertion is taken after the gate is released and the read
// has settled, because the defect is in what happens once the
// derivation resumes. `settle` is a queue flush, not a timing wait:
// see `pureKdfSuite`.

/** The schedule's secret derivations, in the order they run. */
const SCHEDULE = ['payload_key', 'acc_key', 'nonce_base']

/**
 * KDF outputs that are public by construction: the commitment equals
 * the stored commitment in the header (wipeSealState deliberately
 * keeps it), each `snap_epoch` head is stored in the header, and the
 * `snap_epoch_root` is the reference's snapshot. Every other buffer
 * the KDF returned -- the schedule, anything keyed by it, and on the
 * group paths the CEK and its exporter-tree ancestors -- must be zero.
 */
const PUBLIC_LABELS = ['commit', 'snap_epoch']

type T = {
    ok:(v:unknown, m?:string) => void
    equal:(a:unknown, b:unknown, m?:string) => void
}

/**
 * `id` becomes the objectId, which the commitment frames into its
 * info, so it must not contain a derivation label: `pauseAt` and
 * `outputs` match labels by substring.
 */
async function fixture (id:string) {
    const base = await getCipherSuite(getCiphersuiteFromName(
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    ))
    const rec = recordingSuite(pureKdfSuite(base))
    let decrypts = 0
    const cs:CiphersuiteImpl = {
        ...rec.cs,
        hpke: {
            ...rec.cs.hpke,
            decryptAead: (key, nonce, aad, ct) => {
                decrypts++
                return rec.cs.hpke.decryptAead(key, nonce, aad, ct)
            },
        },
    }
    const crypto = sealCryptoFromCiphersuite(cs)
    const keySchedule = {
        applicationExportSecret: new Uint8Array(32).fill(9),
    }
    const oid = new TextEncoder().encode(id)
    const plaintext = new Uint8Array(3000)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 251
    const cek = await attachmentCek(keySchedule, oid, cs)
    const encrypted = await encryptAttachment(
        cek, oid, plaintext, crypto,
    )
    rec.recorded.length = 0
    return {
        rec,
        cs,
        crypto,
        keySchedule,
        cek,
        plaintext,
        encrypted,
        decrypts: () => decrypts,
    }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** `bytes` as a source's first and only chunk. */
function oneChunk (bytes:Uint8Array):ReadableStream<Uint8Array> {
    return chunked(bytes, bytes.length)
}

/**
 * Every schedule derivation ran exactly once, and every buffer the KDF
 * returned other than the public commitment is zero. Counting first
 * keeps a derivation that never ran from passing over an empty list.
 */
function assertNothingLive (t:T, f:Fixture, label:string):void {
    for (const name of SCHEDULE) {
        const outs = f.rec.outputs(name)
        t.equal(outs.length, 1, `${label}: ${name} was derived once`)
        t.ok(outs.every(isZeroed), `${label}: ${name} is zeroed`)
    }
    const live = f.rec.recorded
        .filter(r => !PUBLIC_LABELS.some(p => r.label.includes(p)))
        .filter(r => !isZeroed(r.out))
        .map(r => r.label.trim())
    t.equal(live.length, 0,
        `${label}: no buffer the KDF returned is live (${live})`)
}

/**
 * Cancel a sequential read while its schedule is parked at a gate, then
 * release the derivation and let the read settle. Returns what the
 * pending read resolved with.
 */
async function cancelSequential (
    stream:ReadableStream<Uint8Array>,
    gate:ReturnType<Fixture['rec']['pauseAt']>,
):Promise<ReadableStreamReadResult<Uint8Array>|undefined> {
    const reader = stream.getReader()
    const reading = reader.read().catch(() => undefined)
    await gate.reached
    const cancelling = reader.cancel().catch(() => undefined)
    gate.release()
    const [, result] = await Promise.all([cancelling, reading])
    await settle()
    return result
}

SCHEDULE.forEach((at, n) => {
    test(`F4: sequential cancel at ${at} wipes the schedule`, async t => {
        const f = await fixture(`f4-seq-${n}`)
        const ownedCek = f.cek
        const gate = f.rec.pauseAt(at)
        const stream = decryptAttachmentStream(
            f.cek, f.encrypted.reference,
            oneChunk(f.encrypted.bytes), f.crypto, { ownedCek },
        )
        const result = await cancelSequential(stream, gate)

        assertNothingLive(t, f, 'sequential')
        t.ok(isZeroed(ownedCek), 'sequential: the owned CEK is wiped')
        t.ok(result?.done === true, 'sequential: no chunk was emitted')
        t.equal(f.decrypts(), 0, 'sequential: no AEAD decryption ran')
    })

    test(`F4: group cancel at ${at} wipes the schedule and CEK`,
        async t => {
            const f = await fixture(`f4-group-${n}`)
            const gate = f.rec.pauseAt(at)
            const stream = await decryptAttachmentStreamForGroup(
                f.keySchedule, f.encrypted.reference,
                oneChunk(f.encrypted.bytes), f.cs,
            )
            const result = await cancelSequential(stream, gate)

            // The group wrapper derives its own CEK, so it is one of
            // the recorded buffers assertNothingLive checks.
            t.ok(f.rec.recorded.length > SCHEDULE.length + 1,
                'group: the CEK derivation was recorded')
            assertNothingLive(t, f, 'group')
            t.ok(result?.done === true, 'group: no chunk was emitted')
            t.equal(f.decrypts(), 0, 'group: no AEAD decryption ran')
        })

    test(`F4: range cancel at ${at} wipes the schedule`, async t => {
        const f = await fixture(`f4-range-${n}`)
        const read = await openAttachmentRangeForGroup(
            f.keySchedule, f.encrypted.reference,
            { offset: 0, length: f.plaintext.length }, f.cs,
        )
        const sources = read.ranges.map(r => oneChunk(
            f.encrypted.bytes.slice(r.offset, r.offset + r.length),
        ))
        const gate = f.rec.pauseAt(at)
        const stream = read.decrypt(sources)
        const reader = stream.getReader()
        const reading = reader.read().catch(() => undefined)
        await gate.reached
        const cancelling = reader.cancel().catch(() => undefined)
        gate.release()
        const [, result] = await Promise.all([cancelling, reading])
        await settle()

        assertNothingLive(t, f, 'range')
        t.ok(result?.done === true, 'range: no chunk was emitted')
        t.equal(f.decrypts(), 0, 'range: no AEAD decryption ran')
    })
})

function sameBytes (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

test('F4: an uncancelled read over the same fixture returns the ' +
    'plaintext', async t => {
    const f = await fixture('f4-uncancelled')
    const caller = f.cek.slice()
    const seq = await drainStream(decryptAttachmentStream(
        caller, f.encrypted.reference,
        oneChunk(f.encrypted.bytes), f.crypto,
    ))
    t.ok(sameBytes(seq.total, f.plaintext),
        'sequential: the plaintext round-trips')

    const group = await drainStream(
        await decryptAttachmentStreamForGroup(
            f.keySchedule, f.encrypted.reference,
            oneChunk(f.encrypted.bytes), f.cs,
        ),
    )
    t.ok(sameBytes(group.total, f.plaintext),
        'group: the plaintext round-trips')

    const read = await openAttachmentRange(
        caller, f.encrypted.reference,
        { offset: 0, length: f.plaintext.length }, f.crypto,
    )
    const range = await drainStream(read.decrypt(read.ranges.map(r =>
        oneChunk(f.encrypted.bytes.slice(r.offset, r.offset + r.length)),
    )))
    t.ok(sameBytes(range.total, f.plaintext),
        'range: the plaintext round-trips')
    t.ok(sameBytes(caller, f.cek), 'the borrowed CEK is unchanged')
})
