import type { SealState } from './schedule.js'
import { startOpen, openSegment, wipeSealState }
    from './schedule.js'
import type { SealCrypto } from './crypto.js'
import { sealCryptoFromCiphersuite } from './crypto.js'
import type { AttachmentRef } from './reference.js'
import { validateAttachmentRef } from './reference.js'
import { AttachmentError } from './error.js'
import {
    epochHead, epochTreeRoot, segmentLeaf,
} from './snapshot.js'
import type { LayoutParams, Layout } from './layout.js'
import {
    layout, segmentLength, isZeroRegion,
} from './layout.js'
import { constantTimeEqual } from './kdf.js'
import {
    PROTOCOL_RO, SNAP_EPOCH_TREE, NONCE_DERIVED,
    SEGMENT_MAX, ATTACHMENT_EPOCH_LENGTH,
    type SealParams,
} from './schedule.js'
import { attachmentCek } from './keys.js'
import type { KeySchedule } from '../key-schedule.js'
import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'

export interface HeaderPrefix {
    salt:Uint8Array
    storedCommitment:Uint8Array
    storedSnapshot:Uint8Array
    epochHeads:Uint8Array
    layoutParams:LayoutParams
    l:Layout
}

/**
 * Pure slicing of the fixed prefix + epoch heads. `bytes` must
 * cover at least [0, epochHeadsOffset + nEp * nh). No crypto.
 */
export function parsePrefix (
    bytes:Uint8Array,
    plaintextLength:number,
    nh:number,
):HeaderPrefix {
    if (!Number.isSafeInteger(plaintextLength) ||
        plaintextLength <= 0) {
        throw new AttachmentError()
    }

    const layoutParams:LayoutParams = {
        plaintextLength,
        segmentMax: SEGMENT_MAX,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        nh,
    }

    const l = layout(layoutParams)

    // Verify we have enough bytes
    const neededSize = l.epochHeadsOffset + (l.nEp * nh)
    if (bytes.length < neededSize) {
        throw new AttachmentError()
    }

    const salt = bytes.slice(0, 32)
    const storedCommitment = bytes.slice(32, 32 + nh)
    const storedSnapshot = bytes.slice(32 + nh, 32 + (2 * nh))
    const epochHeads = bytes.slice(
        l.epochHeadsOffset,
        l.epochHeadsOffset + (l.nEp * nh),
    )

    return {
        salt,
        storedCommitment,
        storedSnapshot,
        epochHeads,
        layoutParams,
        l,
    }
}

/**
 * Commitment gate + root check: startOpen with the parsed salt and
 * stored commitment, recompute epochTreeRoot over the complete
 * epoch heads, constant-time compare against ref.snapshot AND
 * require the stored snapshot field to match. Returns the SealState.
 */
export async function verifyRoot (
    cek:Uint8Array,
    objectId:Uint8Array,
    prefix:HeaderPrefix,
    refSnapshot:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    const { l } = prefix

    // Build SealParams from constants
    const params:SealParams = {
        protocolId: PROTOCOL_RO,
        aeadId: crypto.aeadId,
        kdfId: crypto.kdfId,
        segmentMax: SEGMENT_MAX,
        snapId: SNAP_EPOCH_TREE,
        nonceMode: NONCE_DERIVED,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        salt: prefix.salt,
    }

    // startOpen gates on commitment
    const state = await startOpen(
        cek, params, objectId, prefix.storedCommitment, crypto,
    )

    // Recompute epoch tree root over the complete epoch heads
    const root = await epochTreeRoot(
        state,
        BigInt(l.nSeg),
        prefix.epochHeads,
    )

    // Constant-time compare against refSnapshot
    if (!constantTimeEqual(root, refSnapshot)) {
        wipeSealState(state)
        throw new AttachmentError()
    }

    // Also verify against storedSnapshot for consistency
    if (!constantTimeEqual(root, prefix.storedSnapshot)) {
        wipeSealState(state)
        throw new AttachmentError()
    }

    return state
}

export interface HeaderContext {
    state:SealState
    prefix:HeaderPrefix
    metadata:Uint8Array
}

/**
 * verifyEpochRun slices that epoch's leaf run from `ctx.metadata`,
 * recomputes `epochHead(state, run)`, and compares against the stored
 * head slice for that epoch.
 */
export async function verifyEpochRun (
    ctx:HeaderContext,
    epoch:number,
):Promise<void> {
    const { state, prefix, metadata } = ctx
    const { l, layoutParams, epochHeads } = prefix

    if (epoch < 0 || epoch >= l.nEp) {
        throw new AttachmentError()
    }

    const perEpoch = 2 ** layoutParams.epochLength
    const first = epoch * perEpoch
    const count = Math.min(perEpoch, l.nSeg - first)

    // Extract the run for this epoch from metadata
    const metaLen = layoutParams.nh + 16
    const runStart = first * metaLen
    const runEnd = runStart + (count * metaLen)
    const epochRun = metadata.slice(runStart, runEnd)

    // Recompute epoch head
    const head = await epochHead(state, epochRun)

    // Compare against stored head
    const storedHeadOffset = epoch * state.crypto.kdf.size
    const storedHead = epochHeads.slice(
        storedHeadOffset,
        storedHeadOffset + state.crypto.kdf.size,
    )

    if (!constantTimeEqual(head, storedHead)) {
        throw new AttachmentError()
    }
}

/**
 * openBlock computes `segmentLeaf` from the block and the metadata
 * tag, compares against the stored leaf for `index` (constant time),
 * then `openSegment` with `isFinal = (index === nSeg - 1)` and the
 * metadata tag.
 */
export async function openBlock (
    ctx:HeaderContext,
    index:number,
    block:Uint8Array,
):Promise<Uint8Array> {
    const { state, prefix, metadata } = ctx
    const { l, layoutParams } = prefix

    if (index < 0 || index >= l.nSeg) {
        throw new AttachmentError()
    }

    // Get the ciphertext length for this block
    const ctLen = segmentLength(l, layoutParams, index)

    // block should be the ciphertext (no tag)
    if (block.length !== ctLen) {
        throw new AttachmentError()
    }

    // Extract metadata tag for this segment
    const metaLen = layoutParams.nh + 16
    const metaOffset = index * metaLen
    const storedLeaf = metadata.slice(
        metaOffset,
        metaOffset + metaLen,
    )

    // Tag is the last 16 bytes of the leaf
    const tag = storedLeaf.slice(layoutParams.nh)

    // Verify the stored leaf by recomputing segmentLeaf
    const recomputedLeaf = await segmentLeaf(state, block, tag)

    if (!constantTimeEqual(recomputedLeaf, storedLeaf)) {
        throw new AttachmentError()
    }

    // Now decrypt the segment
    const isFinal = index === l.nSeg - 1

    return openSegment(state, {
        index: BigInt(index),
        isFinal,
        ciphertext: block,
        tag,
    })
}

/**
 * Full-header convenience: parsePrefix + verifyRoot + take the
 * complete metadata region from `header` (which must be exactly
 * l.headerSize octets).
 */
export async function verifyHeader (
    cek:Uint8Array,
    objectId:Uint8Array,
    header:Uint8Array,
    ref:{ snapshot:Uint8Array, plaintextLength:number },
    crypto:SealCrypto,
):Promise<HeaderContext> {
    // Validate plaintextLength before using Number()
    if (!Number.isSafeInteger(ref.plaintextLength) ||
        ref.plaintextLength <= 0) {
        throw new AttachmentError()
    }

    const plaintextLength = ref.plaintextLength

    // Parse prefix
    const prefix = parsePrefix(header, plaintextLength, crypto.kdf.size)

    // Verify that header is exactly the expected size
    if (header.length !== prefix.l.headerSize) {
        throw new AttachmentError()
    }

    // Verify root (commitment + snapshot)
    const state = await verifyRoot(
        cek, objectId, prefix, ref.snapshot, crypto,
    )

    // Extract complete metadata region from header
    const metadata = header.slice(
        prefix.l.metaOffset,
        prefix.l.metaOffset + prefix.l.metaLen * prefix.l.nSeg,
    )

    return { state, prefix, metadata }
}

/**
 * Streaming sequential reader. Validates the attachment reference,
 * buffers the header, verifies commitment and root, then streams
 * plaintext as blocks arrive.
 *
 * Implements zeroization via wipeSealState on close/error/cancel.
 *
 * WIPING IS DRIVEN BY THE CONSUMER. The seal state, and a CEK passed
 * as `opts.ownedCek`, are zeroed when the stream ends, errors, or is
 * cancelled -- all three are consumer-triggered. A caller who reads
 * some plaintext and then drops the stream on the floor triggers none
 * of them, so the owned CEK stays in memory until the stream is
 * garbage collected. Always finish the stream or call `cancel()` on
 * its reader (a `try`/`finally` around the read loop is the usual
 * way); `for await` over the stream does this for you, including on
 * `break` and on a thrown error.
 */
export function decryptAttachmentStream (
    cek:Uint8Array,
    ref:AttachmentRef,
    ciphertext:ReadableStream<Uint8Array>,
    crypto:SealCrypto,
    opts?:{ ownedCek?:Uint8Array },
):ReadableStream<Uint8Array> {
    // Validate the reference first (version, objectId, etc.). The
    // ciphersuite is in hand here, so the snapshot length is pinned to
    // this KDF's output size rather than to the set of all of them.
    validateAttachmentRef(ref, crypto.kdf.size)

    // Validate ref plaintextLength before entering stream
    if (ref.plaintextLength <= 0n ||
        ref.plaintextLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new AttachmentError()
    }

    const plaintextLength = Number(ref.plaintextLength)

    // Build layout params
    const layoutParams:LayoutParams = {
        plaintextLength,
        segmentMax: SEGMENT_MAX,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        nh: crypto.kdf.size,
    }

    const l = layout(layoutParams)

    let ctx:HeaderContext|null = null
    let stateWiped = false
    let cekWiped = false
    let reader:ReadableStreamDefaultReader<Uint8Array>|null = null

    const doWipe = () => {
        // Two independent latches, not one. cancel() can fire while
        // start() is still awaiting verifyHeader, when ctx is null and
        // there is no state to wipe yet. stateWiped therefore does not
        // latch on such a call, so the later doWipe -- from the gap
        // loop's catch, once verifyHeader has returned and ctx is set
        // -- still performs the wipe. A single latch shared with the
        // CEK would be set by that first call and swallow the second,
        // leaving payloadKey, snapKey and nonceBase live in memory.
        // That is a real leak, not a theoretical one; it is pinned by
        // the two-flag regression test in test/attachment/cek-wipe.ts,
        // which fails if these are collapsed into one flag.
        if (!stateWiped && ctx) {
            stateWiped = true
            wipeSealState(ctx.state)
        }
        // The CEK wipe has no precondition, so it can fire while
        // deriveSchedule is still reading the key across its four
        // awaits (commit, payload_key, acc_key, nonce_base). A cancel
        // landing between them leaves a SealState whose commitment
        // came from the real key and whose other fields came from
        // zeros; verifyRoot's constantTimeEqual then fails and the
        // stream errors, and verifyHeader wipes that state itself.
        // Benign: the stream is being cancelled, and keys derived
        // from zeros make it error rather than return wrong data.
        if (!cekWiped) {
            cekWiped = true
            opts?.ownedCek?.fill(0)
        }
    }

    // Shared state for streaming.
    //
    // `buffer` is a queue of not-yet-consumed ciphertext chunks, and
    // `bufferedBytes` is their running total. The total is maintained
    // on every push and every consume rather than recomputed, because
    // a source is allowed to emit one byte per chunk: re-summing the
    // array on each read made block assembly quadratic in the chunk
    // count, and a two-segment object from such a source took ~44s.
    // `bufferHead` exists for the same reason -- `Array.shift` moves
    // every remaining element, so consuming 65536 single-byte chunks
    // one at a time is quadratic on its own. Consumed slots are
    // dropped from the front only when the queue drains.
    const buffer:Uint8Array[] = []
    let bufferHead = 0
    let bufferedBytes = 0

    const pushChunk = (chunk:Uint8Array) => {
        buffer.push(chunk)
        bufferedBytes += chunk.length
    }

    // The chunk at the front of the queue, or null when it is empty.
    const peekChunk = ():Uint8Array|null => {
        return bufferHead < buffer.length ? buffer[bufferHead] : null
    }

    // Consume `take` bytes from the front chunk. `take` is always at
    // most that chunk's length; callers cross chunk boundaries by
    // looping, not by passing a larger count.
    const consumeFront = (take:number) => {
        const first = buffer[bufferHead]
        bufferedBytes -= take
        if (take >= first.length) {
            bufferHead++
            if (bufferHead >= buffer.length) {
                buffer.length = 0
                bufferHead = 0
            }
        } else {
            buffer[bufferHead] = first.subarray(take)
        }
    }
    let blockIndex = 0
    let lastEpochVerified = -1
    let headerDone = false

    return new ReadableStream({
        async start (controller) {
            try {
                // Inside the guarded region on purpose. getReader()
                // throws a raw TypeError when the caller hands us an
                // already-locked stream, and that used to escape the
                // catch below: the caller saw a TypeError instead of
                // the library's single opaque error, and the owned
                // CEK was never zeroed. Routing it through the same
                // path as any other start() failure fixes both.
                reader = ciphertext.getReader()

                // Buffer incoming chunks until header is available
                const totalBytes:Uint8Array[] = []
                let bytesRead = 0

                while (bytesRead < l.headerSize) {
                    const result = await reader.read()
                    if (result.done) {
                        throw new AttachmentError()
                    }
                    if (result.value) {
                        totalBytes.push(result.value)
                        bytesRead += result.value.length
                    }
                }

                // Reconstruct header from buffered chunks
                const headerTotal = new Uint8Array(l.headerSize)
                let offset = 0
                let byteIdx = 0
                let chunkIdx = 0

                while (offset < l.headerSize) {
                    const chunk = totalBytes[chunkIdx]
                    const take = Math.min(
                        chunk.length - byteIdx,
                        l.headerSize - offset,
                    )
                    headerTotal.set(
                        chunk.slice(byteIdx, byteIdx + take),
                        offset,
                    )
                    offset += take
                    byteIdx += take

                    if (byteIdx >= chunk.length) {
                        chunkIdx++
                        byteIdx = 0
                    }
                }

                // Verify header
                ctx = await verifyHeader(
                    cek, ref.objectId, headerTotal,
                    {
                        snapshot: ref.snapshot,
                        plaintextLength,
                    },
                    crypto,
                )

                // Collect remaining bytes from buffered chunks after header
                let inChunkIdx = chunkIdx
                let inByteIdx = byteIdx

                while (inChunkIdx < totalBytes.length) {
                    const chunk = totalBytes[inChunkIdx]
                    pushChunk(chunk.slice(inByteIdx))
                    inByteIdx = 0
                    inChunkIdx++
                }

                // Skip padding between header and first block
                let toSkip = l.firstBlockOffset - l.headerSize
                while (toSkip > 0) {
                    if (bufferedBytes >= toSkip) {
                        // Trim from buffer
                        let removed = 0
                        while (removed < toSkip) {
                            const first = peekChunk()
                            if (first === null) break
                            const take = Math.min(
                                first.length, toSkip - removed,
                            )
                            // Check the trimmed span is zero
                            if (!isZeroRegion(first, 0, take)) {
                                throw new AttachmentError()
                            }
                            consumeFront(take)
                            removed += take
                        }
                        toSkip = 0
                    } else {
                        // Need more bytes
                        const result = await reader.read()
                        if (result.done) {
                            throw new AttachmentError()
                        }
                        if (result.value) {
                            pushChunk(result.value)
                        }
                    }
                }

                headerDone = true
            } catch (err) {
                doWipe()
                if (reader) await reader.cancel().catch(() => {})
                if (err instanceof AttachmentError) {
                    controller.error(err)
                } else {
                    controller.error(new AttachmentError())
                }
            }
        },
        async pull (controller) {
            if (!headerDone || !ctx) {
                return
            }

            try {
                if (blockIndex >= l.nSeg) {
                    // Verify the stream ended with no extra bytes.
                    // A TransformStream or socket adapter may enqueue
                    // zero-length chunks, including on the read before
                    // done, so read until done and decide emptiness by
                    // length. Testing the value for truthiness read a
                    // legal empty chunk as trailing ciphertext.
                    let extra = bufferedBytes
                    while (extra === 0) {
                        const result = await reader?.read()
                        if (!result || result.done) break
                        extra += result.value?.length ?? 0
                    }
                    if (extra > 0) {
                        throw new AttachmentError()
                    }
                    doWipe()
                    controller.close()
                    return
                }

                const blockLen = segmentLength(l, layoutParams,
                    blockIndex)

                // On first segment of epoch, verify epoch run
                const epoch = Math.floor(blockIndex /
                    (2 ** layoutParams.epochLength))
                if (epoch !== lastEpochVerified) {
                    await verifyEpochRun(ctx, epoch)
                    lastEpochVerified = epoch
                }

                // Buffer until block is available
                // Written as an explicit break because
                // `no-unmodified-loop-condition` cannot see that
                // `pushChunk` updates `bufferedBytes`.
                for (;;) {
                    if (bufferedBytes >= blockLen) break
                    const result = await reader?.read()
                    if (result?.done) {
                        throw new AttachmentError()
                    }
                    if (result?.value) {
                        pushChunk(result.value)
                    }
                }

                // Extract block
                const block = new Uint8Array(blockLen)
                let blockOffset = 0
                while (blockOffset < blockLen) {
                    const first = peekChunk()
                    if (first === null) {
                        throw new AttachmentError()
                    }
                    const take = Math.min(first.length,
                        blockLen - blockOffset)
                    block.set(first.subarray(0, take), blockOffset)
                    blockOffset += take
                    consumeFront(take)
                }

                // Decrypt block
                const plaintext = await openBlock(ctx, blockIndex,
                    block)
                controller.enqueue(plaintext)
                blockIndex++
            } catch (err) {
                doWipe()
                if (reader) await reader.cancel().catch(() => {})
                if (err instanceof AttachmentError) {
                    controller.error(err)
                } else {
                    controller.error(new AttachmentError())
                }
            }
        },
        cancel () {
            doWipe()
            if (reader) return reader.cancel().catch(() => {})
        },
    })
}

/**
 * Convenience wrapper: derive the CEK via attachmentCek and
 * delegate to decryptAttachmentStream.
 *
 * LIFETIME: a ref is only decryptable within the epoch it was created
 * in. The CEK is derived from the current epoch's
 * `applicationExportSecret` and the ref carries no epoch, so after the
 * group commits this derives a different key and the read fails the
 * commitment gate with a bare `AttachmentError` -- the same failure a
 * tampered object produces. A post-commit read is indistinguishable
 * from tampering; do not report one as the other.
 *
 * WIPING: the derived CEK is handed to `decryptAttachmentStream` as
 * `opts.ownedCek`, so it is zeroed when the stream ends, errors or is
 * cancelled. A consumer who abandons the stream without doing any of
 * those leaves the CEK live in memory. Read the stream to the end or
 * cancel its reader -- see `decryptAttachmentStream` above.
 */
export async function decryptAttachmentStreamForGroup (
    keySchedule:Pick<KeySchedule, 'applicationExportSecret'>,
    ref:AttachmentRef,
    ciphertext:ReadableStream<Uint8Array>,
    cs:CiphersuiteImpl,
):Promise<ReadableStream<Uint8Array>> {
    const cek = await attachmentCek(keySchedule, ref.objectId, cs)
    try {
        const crypto = sealCryptoFromCiphersuite(cs)
        return decryptAttachmentStream(
            cek, ref, ciphertext, crypto,
            { ownedCek: cek },
        )
    } catch (err) {
        cek.fill(0)
        throw err
    }
}
