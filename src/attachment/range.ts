import type { ByteRange, LayoutParams } from './layout.js'
import {
    layout, rangesFor, segmentLength, epochOf, isZeroRegion,
} from './layout.js'
import {
    parsePrefix, verifyRoot, verifyEpochRun, openBlock,
    type HeaderContext,
} from './reader.js'
import type { AttachmentRef } from './reference.js'
import { validateAttachmentRef } from './reference.js'
import type { SealCrypto } from './crypto.js'
import { sealCryptoFromCiphersuite } from './crypto.js'
import { AttachmentError } from './error.js'
import { wipeSealState } from './schedule.js'
import { attachmentCek } from './keys.js'
import type { KeySchedule } from '../key-schedule.js'
import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'
import {
    SEGMENT_MAX, ATTACHMENT_EPOCH_LENGTH,
} from './schedule.js'

/**
 * A range read over an encrypted attachment.
 *
 * READ THIS BEFORE RELYING ON close(). What close() does depends on
 * how the read was opened, because it wipes only a CEK this layer
 * OWNS.
 *
 * Opened via `openAttachmentRangeForGroup`, the wrapper derives the
 * CEK and hands it over as `opts.ownedCek`. close() then zeroes it,
 * and the read is single-use: once any stream has ended or close()
 * has been called, a later decrypt() returns a stream that errors on
 * read, because verifyRoot runs against a zeroed CEK.
 *
 * Opened by calling `openAttachmentRange` DIRECTLY with your own cek
 * and no `opts.ownedCek`, close() zeroes nothing -- the key is yours
 * and wiping it underneath you would be wrong -- and the read is NOT
 * single-use, because nothing was zeroed for a later decrypt() to
 * fail on. Wipe your own key when you are done with it.
 *
 * Either way, abandoning a range read without calling close() leaks
 * whatever this layer holds; nothing here can prevent that.
 */
export interface AttachmentRangeRead {
    ranges:ByteRange[]
    decrypt:(
        streams:ReadableStream<Uint8Array>[]
    ) => ReadableStream<Uint8Array>
    /**
     * Zeroes the CEK this read owns, if it owns one.
     *
     * Required, so there is nothing to guard on: every range read
     * has a close(). What varies is what it does. It zeroes the key
     * only when the read was opened with `opts.ownedCek`, which is
     * what `openAttachmentRangeForGroup` passes. A direct caller who
     * supplied their own cek gets a close() that zeroes nothing; see
     * the note on the interface.
     */
    close:() => void
}

/**
 * Opens a range read over an encrypted attachment. Returns the
 * encrypted byte ranges needed and a decrypt function that
 * accepts a stream for each range.
 */
export async function openAttachmentRange (
    cek:Uint8Array,
    ref:AttachmentRef,
    range:{ offset:number, length:number },
    crypto:SealCrypto,
    opts?:{ ownedCek?:Uint8Array },
):Promise<AttachmentRangeRead> {
    // Validate reference. As in reader.ts, the ciphersuite is known
    // here, so the snapshot length is pinned exactly.
    validateAttachmentRef(ref, crypto.kdf.size)

    // Validate offset and length are safe integers
    if (!Number.isSafeInteger(range.offset) ||
        !Number.isSafeInteger(range.length)) {
        throw new AttachmentError()
    }

    // Validate and convert plaintextLength before using Number()
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

    // Compute ranges (throws if out of bounds)
    const { segFirst, segLast, ranges } = rangesFor(
        layoutParams,
        range.offset,
        range.length,
    )

    let cekWiped = false
    const wipeCek = () => {
        if (!cekWiped) {
            cekWiped = true
            opts?.ownedCek?.fill(0)
        }
    }

    return {
        ranges,
        decrypt (streams) {
            return decryptRangeStream(
                cek, ref, range, layoutParams, segFirst,
                segLast, ranges, streams, crypto, wipeCek,
            )
        },
        close: wipeCek,
    }
}

/**
 * Decrypts a set of range streams into plaintext.
 */
function decryptRangeStream (
    cek:Uint8Array,
    ref:AttachmentRef,
    range:{ offset:number, length:number },
    layoutParams:LayoutParams,
    segFirst:number,
    segLast:number,
    ranges:ByteRange[],
    streams:ReadableStream<Uint8Array>[],
    crypto:SealCrypto,
    wipeCek:() => void,
):ReadableStream<Uint8Array> {
    const l = layout(layoutParams)
    const plaintextLength = layoutParams.plaintextLength

    let ctx:HeaderContext|null = null
    let decrypted:Uint8Array|null = null
    let stateWiped = false
    let cancelled = false

    // Two independent latches, the same shape reader.ts uses. cancel()
    // can fire while start() is still awaiting a drain or verifyRoot,
    // when ctx is null and there is no state to wipe yet. stateWiped
    // therefore does not latch on such a call, so the later doWipe --
    // from start()'s catch, once verifyRoot has returned and ctx is
    // set -- still performs the wipe. Sharing one latch with the CEK
    // would let that first call swallow the second and leave
    // payloadKey, snapKey and nonceBase live in memory.
    const doWipe = () => {
        if (!stateWiped && ctx) {
            stateWiped = true
            wipeSealState(ctx.state)
        }
        wipeCek()
    }

    /**
     * Bail out of start() if a cancel landed while it was parked on an
     * await. Throwing hands the wipe to start()'s catch, which by then
     * has a ctx to wipe; it also stops the read from verifying epochs
     * and decrypting a window nobody is going to read. Erroring a
     * stream that is already closed by cancel() is a no-op per spec,
     * so this cannot surface as an unhandled rejection.
     */
    const throwIfCancelled = () => {
        if (cancelled) throw new AttachmentError()
    }

    return new ReadableStream({
        async start (_controller) {
            try {
                // Drain all streams to bytes
                const rangeBytes:Array<Uint8Array> = []
                for (let i = 0; i < streams.length; i++) {
                    const bytes = await drainStream(streams[i])
                    throwIfCancelled()
                    rangeBytes.push(bytes)
                }

                // Build sparse view from ranges
                const sparseView = new Map<number, Uint8Array>()

                // Verify we have the right number of streams
                if (rangeBytes.length !== ranges.length) {
                    throw new AttachmentError()
                }

                // Verify each stream's length matches its range
                for (let i = 0; i < ranges.length; i++) {
                    if (rangeBytes[i].length !== ranges[i].length) {
                        throw new AttachmentError()
                    }
                    sparseView.set(ranges[i].offset, rangeBytes[i])
                }

                // The alignment padding gap is covered by no
                // authenticator, so the two whole-object paths reject
                // a non-zero one and this path has to agree: a
                // content-addressed locator that resolves to two
                // byte-different objects is not one. rangesFor emits
                // the gap whenever it is non-empty, so some fetched
                // range contains it; a caller who served ranges that
                // do not is serving something other than what was
                // asked for.
                if (l.firstBlockOffset > l.headerSize) {
                    let gapChecked = false
                    for (const [offset, bytes] of sparseView) {
                        if (offset > l.headerSize ||
                            offset + bytes.length < l.firstBlockOffset) {
                            continue
                        }
                        if (!isZeroRegion(
                            bytes,
                            l.headerSize - offset,
                            l.firstBlockOffset - offset,
                        )) {
                            throw new AttachmentError()
                        }
                        gapChecked = true
                        break
                    }
                    if (!gapChecked) throw new AttachmentError()
                }

                // Parse and verify header from first range
                const firstRangeBytes = rangeBytes[0]
                const prefix = parsePrefix(
                    firstRangeBytes,
                    plaintextLength,
                    crypto.kdf.size,
                )

                // Verify root
                const state = await verifyRoot(
                    cek, ref.objectId, prefix,
                    ref.snapshot, crypto,
                )

                // Assign ctx immediately so state is protected by
                // catch -- including the throwIfCancelled below, which
                // covers a cancel that landed while verifyRoot was
                // building this very state.
                ctx = { state, prefix, metadata: new Uint8Array(0) }
                throwIfCancelled()

                // Build metadata buffer with only fetched epochs
                // Invariant: every leaf openBlock reads belongs to a
                // fetched, verifyEpochRun-verified epoch
                // NOTE: This allocates a full-object metadata buffer
                // (nSeg * (nh + 16)) regardless of range size. For the
                // design's 128 GiB target with typical parameters,
                // reading 10 bytes allocates ~96 MiB. This is a known
                // limitation documented in the design plan.
                const metadataBuffer = new Uint8Array(
                    l.nSeg * (crypto.kdf.size + 16),
                )

                // Extract epoch runs from fetched metadata ranges
                const perEpoch = 2 ** layoutParams.epochLength
                const epFirst = epochOf(layoutParams, segFirst)
                const epLast = epochOf(layoutParams, segLast)

                for (let e = epFirst; e <= epLast; e++) {
                    const first = e * perEpoch
                    const count = Math.min(perEpoch, l.nSeg - first)
                    const metaOffset = l.metaOffset +
                        (first * (crypto.kdf.size + 16))
                    const metaLen = count * (crypto.kdf.size + 16)

                    // Find this metadata range in sparseView
                    let found = false
                    for (const [offset, bytes] of sparseView.entries()) {
                        if (offset <= metaOffset &&
                            offset + bytes.length >= metaOffset + metaLen) {
                            const sliceOffset = metaOffset - offset
                            const epochRun = bytes.slice(
                                sliceOffset, sliceOffset + metaLen,
                            )
                            metadataBuffer.set(
                                epochRun,
                                metaOffset - l.metaOffset,
                            )
                            found = true
                            break
                        }
                    }
                    if (!found) {
                        throw new AttachmentError()
                    }
                }

                // Update ctx with final metadata buffer
                ctx.metadata = metadataBuffer

                // Verify all fetched epochs
                for (let e = epFirst; e <= epLast; e++) {
                    await verifyEpochRun(ctx, e)
                    throwIfCancelled()
                }

                // Decrypt all fetched blocks
                const plaintextChunks:Uint8Array[] = []

                for (let i = segFirst; i <= segLast; i++) {
                    const blockLen = segmentLength(l, layoutParams, i)
                    const blockOffset = l.firstBlockOffset +
                        (i * SEGMENT_MAX)

                    // Find block bytes in sparse view
                    let blockData:Uint8Array|null = null
                    for (const [offset, bytes] of sparseView.entries()) {
                        if (offset <= blockOffset &&
                            offset + bytes.length >= blockOffset +
                            blockLen) {
                            const sliceOffset = blockOffset - offset
                            blockData = bytes.slice(
                                sliceOffset, sliceOffset + blockLen,
                            )
                            break
                        }
                    }

                    // Depth, not sole defense, and untestable as
                    // such: sparseView is keyed by the same `ranges`
                    // this loop walks, and the length comparison above
                    // has already made every one of those ranges as
                    // long as it claims, so a block with no bytes
                    // behind it cannot be constructed from outside.
                    // Delete the length comparison and this is what
                    // catches a short range instead.
                    if (!blockData) {
                        throw new AttachmentError()
                    }

                    throwIfCancelled()
                    const plaintext = await openBlock(ctx, i, blockData)
                    plaintextChunks.push(plaintext)
                }

                // Concatenate decrypted blocks
                const totalLen = plaintextChunks.reduce(
                    (s, c) => s + c.length, 0,
                )
                decrypted = new Uint8Array(totalLen)
                let offset = 0
                for (const chunk of plaintextChunks) {
                    decrypted.set(chunk, offset)
                    offset += chunk.length
                }

                // Trim to requested window
                const plainStart = segFirst * SEGMENT_MAX
                const plaintextWindowStart = range.offset - plainStart
                const plaintextWindowEnd = plaintextWindowStart +
                    range.length

                decrypted = decrypted.slice(
                    plaintextWindowStart,
                    plaintextWindowEnd,
                )
            } catch (err) {
                doWipe()
                if (err instanceof AttachmentError) {
                    throw err
                } else {
                    throw new AttachmentError()
                }
            }
        },

        pull (controller) {
            try {
                // start() either assigns decrypted or errors the stream,
                // so pull() cannot observe null here. The guard keeps the
                // invariant checked rather than asserted.
                //
                // On why the catch below is exempt from the
                // delete-a-wipe-and-watch-a-test-fail rule: it is not
                // that nothing above it can throw before `ctx = null`
                // -- controller.enqueue runs first and, hypothetically,
                // could. It is that enqueue on a readable, unlocked
                // controller does not throw, and that wipeCek latches
                // on cekWiped, so by the time the catch could run the
                // wipe has already happened and its call there is a
                // no-op. Unreachable in effect, not merely untested.
                if (decrypted === null) throw new AttachmentError()
                if (decrypted.length > 0) {
                    controller.enqueue(decrypted)
                }

                // Wipe on close
                doWipe()
                ctx = null

                controller.close()
            } catch (err) {
                doWipe()
                if (err instanceof AttachmentError) {
                    controller.error(err)
                } else {
                    controller.error(new AttachmentError())
                }
            }
        },

        cancel () {
            cancelled = true
            doWipe()
        },
    })
}

/**
 * Helper to drain a ReadableStream to bytes.
 */
async function drainStream (
    stream:ReadableStream<Uint8Array>,
):Promise<Uint8Array> {
    const reader = stream.getReader()
    const chunks:Uint8Array[] = []
    let result = await reader.read()
    while (!result.done) {
        if (result.value) chunks.push(result.value)
        result = await reader.read()
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
    }
    return out
}

/**
 * Group wrapper: derive the CEK via attachmentCek and
 * delegate to openAttachmentRange.
 *
 * LIFETIME: a ref is only decryptable within the epoch it was created
 * in. The CEK is derived from the current epoch's
 * `applicationExportSecret` and the ref carries no epoch, so after the
 * group commits this derives a different key and the read fails the
 * commitment gate with a bare `AttachmentError` -- the same failure a
 * tampered object produces. A post-commit read is indistinguishable
 * from tampering; do not report one as the other.
 *
 * The derived CEK is owned by the returned read, so `close()` zeroes
 * it. See `AttachmentRangeRead` above for what that makes single-use.
 */
export async function openAttachmentRangeForGroup (
    keySchedule:Pick<KeySchedule, 'applicationExportSecret'>,
    ref:AttachmentRef,
    range:{ offset:number, length:number },
    cs:CiphersuiteImpl,
):Promise<AttachmentRangeRead> {
    const cek = await attachmentCek(
        keySchedule, ref.objectId, cs,
    )
    try {
        const crypto = sealCryptoFromCiphersuite(cs)
        return await openAttachmentRange(
            cek, ref, range, crypto, { ownedCek: cek },
        )
    } catch (err) {
        cek.fill(0)
        throw err
    }
}
