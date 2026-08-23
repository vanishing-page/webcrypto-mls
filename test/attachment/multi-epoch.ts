import { test } from '@substrate-system/tapzero'
import { openObject } from '../../src/attachment/object.js'
import { decryptAttachmentStream } from '../../src/attachment/reader.js'
import {
    startSeal, sealSegment, wipeSealState,
    PROTOCOL_RO, SNAP_EPOCH_TREE, NONCE_DERIVED,
    ATTACHMENT_EPOCH_LENGTH, SEGMENT_MAX,
} from '../../src/attachment/schedule.js'
import type { SealParams } from '../../src/attachment/schedule.js'
import { segmentLeaf } from '../../src/attachment/snapshot.js'
import { blockRange, metaRange } from '../../src/attachment/layout.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { buildLayout } from './attachment-fixtures.js'
import { chunked } from './stream-helpers.js'
import {
    multiEpochFixture, patternByte, MULTI_EPOCH_SEGMENTS,
} from './multi-epoch-fixture.js'

/**
 * Positive multi-epoch coverage. Every other test that reaches a
 * second epoch stops at an early rejection, which means no test has
 * ever read real plaintext out of a segment whose key came from epoch
 * 1. A bug confined to those segments -- a key derived for the wrong
 * epoch, a head verified against the wrong run, a reader that verifies
 * the first epoch and then coasts -- would pass the whole suite.
 *
 * Parameters: SEGMENT_MAX = 65536 octets per segment, 1025 segments,
 * 67,174,400 octets of plaintext. Cost, measured under node on an
 * M-series laptop: about 0.53s to seal the shared fixture, about 0.34s
 * for the openObject read, about 0.36s for the streamed read and about
 * 0.35s more for the splice test's partial reads, so 1.5s to 1.9s of
 * wall clock for this file across repeated runs. That is the tradeoff:
 * a suite that otherwise finishes in seconds pays a second and a half
 * for the only coverage that reads real plaintext past segment 1024.
 * The browser run carries this file too and finished in 2:22 with it,
 * against 1:45 to 2:17 for the same suite before, so it stays well
 * inside the ten-minute page timeout and no step here goes quiet for
 * the three seconds that would make tapout treat the run as truncated.
 * See multi-epoch-fixture.ts for why the size cannot be reduced.
 */

/**
 * Index of the first byte that differs, or -1. Reported as an index
 * rather than as a boolean so a failure says where the read went
 * wrong: an offset inside segment 1024 is a different bug from an
 * offset in the first epoch.
 */
function firstMismatch (
    actual:Uint8Array,
    expected:Uint8Array,
    from = 0,
):number {
    if (actual.length !== expected.length - from) return -2
    for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[from + i]) return from + i
    }
    return -1
}

test('multi-epoch: the fixture really does span two epochs', async t => {
    const f = await multiEpochFixture()
    const { l } = buildLayout(f.plaintext.length, f.crypto)
    t.equal(l.nSeg, MULTI_EPOCH_SEGMENTS, '1025 segments')
    t.equal(l.nEp, 2, 'two epochs')
    t.equal(
        Math.floor((l.nSeg - 1) / (2 ** ATTACHMENT_EPOCH_LENGTH)), 1,
        'the last segment belongs to epoch 1'
    )
})

test('multi-epoch: openObject round-trips every segment', async t => {
    const f = await multiEpochFixture()
    const openRef = {
        snapshot: f.sealed.snapshot.slice(),
        plaintextLength: f.plaintext.length,
    }
    const recovered = await openObject(
        f.cek, f.objectId, f.sealed.bytes, openRef, f.crypto,
    )
    t.equal(
        recovered.length, f.plaintext.length,
        'recovered the whole plaintext',
    )
    t.equal(
        firstMismatch(recovered, f.plaintext), -1,
        'openObject: every byte matches, epoch 1 included',
    )
    // Named separately so a failure confined to the second epoch is
    // legible without decoding an offset.
    const past = (MULTI_EPOCH_SEGMENTS - 1) * SEGMENT_MAX
    t.equal(
        recovered[past], patternByte(past),
        'first byte of segment 1024 is the sealed plaintext byte',
    )
})

test('multi-epoch: the stream round-trips every segment', async t => {
    const f = await multiEpochFixture()
    // Compared chunk by chunk rather than through drainStream, which
    // concatenates: holding a second copy of 64 MiB is what would put
    // this test out of reach of the browser run.
    const stream = decryptAttachmentStream(
        f.cek, f.ref, chunked(f.sealed.bytes, 1 << 20), f.crypto,
    )
    const reader = stream.getReader()
    let at = 0
    let bad = -1
    try {
        let result = await reader.read()
        while (!result.done) {
            if (result.value) {
                if (bad < 0) {
                    bad = firstMismatch(result.value, f.plaintext, at)
                }
                at += result.value.length
            }
            result = await reader.read()
        }
    } finally {
        reader.releaseLock()
    }
    t.equal(at, f.plaintext.length, 'streamed the whole plaintext')
    t.equal(bad, -1, 'stream: every byte matches, epoch 1 included')
})

/**
 * The positive round-trips above cannot see a reader that verifies
 * epoch 0 and then stops re-verifying, because on an untampered object
 * the skipped check would have passed. What that check is worth is
 * the binding from the metadata run to the epoch head, so the test
 * that needs it is a splice: replace segment 1024's block and its leaf
 * with a consistent pair sealed under the same CEK, object id, salt
 * and index. The AEAD accepts it -- same key, same derived nonce --
 * and openBlock accepts it, because the stored leaf it compares
 * against is the spliced one. Only the epoch 1 head, which is covered
 * by the snapshot and therefore cannot be rewritten, says no.
 */
async function spliceSegment1024 (
    plaintext:Uint8Array,
):Promise<Uint8Array> {
    const f = await multiEpochFixture()
    const { layoutParams, l } = buildLayout(f.plaintext.length, f.crypto)
    const params:SealParams = {
        protocolId: PROTOCOL_RO,
        aeadId: f.crypto.aeadId,
        kdfId: f.crypto.kdfId,
        segmentMax: SEGMENT_MAX,
        snapId: SNAP_EPOCH_TREE,
        nonceMode: NONCE_DERIVED,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        salt: f.sealed.salt,
    }
    const state = await startSeal(f.cek, params, f.objectId, f.crypto)
    try {
        const index = l.nSeg - 1
        const sealed = await sealSegment(state, {
            index: BigInt(index),
            isFinal: true,
            plaintext,
        })
        const leaf = await segmentLeaf(
            state, sealed.ciphertext, sealed.tag,
        )
        const bytes = new Uint8Array(f.sealed.bytes)
        const br = blockRange(l, layoutParams, index)
        const mr = metaRange(l, index)
        bytes.set(sealed.ciphertext, br.offset)
        bytes.set(leaf, mr.offset)
        return bytes
    } finally {
        wipeSealState(state)
    }
}

test('multi-epoch: a spliced segment 1024 is rejected', async t => {
    const f = await multiEpochFixture()
    const forged = new Uint8Array(SEGMENT_MAX).fill(0x2a)
    const bytes = await spliceSegment1024(forged)
    t.ok(
        bytes.length === f.sealed.bytes.length,
        'the splice is the same size as the object it replaces',
    )

    const openRef = {
        snapshot: f.sealed.snapshot.slice(),
        plaintextLength: f.plaintext.length,
    }
    try {
        await openObject(f.cek, f.objectId, bytes, openRef, f.crypto)
        t.fail('openObject accepted a spliced segment in epoch 1')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'openObject rejects a spliced segment in epoch 1',
        )
    }

    const stream = decryptAttachmentStream(
        f.cek, f.ref, chunked(bytes, 1 << 20), f.crypto,
    )
    const reader = stream.getReader()
    let emitted = 0
    try {
        let result = await reader.read()
        while (!result.done) {
            emitted += result.value?.length ?? 0
            result = await reader.read()
        }
        t.fail('the stream accepted a spliced segment in epoch 1')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'the stream rejects a spliced segment in epoch 1',
        )
    } finally {
        reader.releaseLock()
    }
    // The reader verifies an epoch run before it opens the first
    // block of that epoch, so a rejection at segment 1024 leaves
    // exactly the first epoch emitted and no spliced plaintext.
    t.equal(
        emitted, (MULTI_EPOCH_SEGMENTS - 1) * SEGMENT_MAX,
        'the stream emitted epoch 0 and stopped at segment 1024',
    )
})
