import { AttachmentError } from '../src/attachment/error.js'
import type { ByteRange } from '../src/attachment/layout.js'
import { SAMPLE_RATE } from './attachment-audio.js'

/** The group and epoch that own an encrypted attachment. */
export interface AttachmentScope {
    groupId:Uint8Array
    epoch:bigint
}

/** Build a usable attachment scope, or null when no group is available. */
export function attachmentScope (
    groupId:Uint8Array|null|undefined,
    epoch:bigint|null|undefined
):AttachmentScope|null {
    if (!groupId || epoch === null || epoch === undefined) return null
    return { groupId, epoch }
}

/** Compare attachment scopes without relying on object or array identity. */
export function sameAttachmentScope (
    left:AttachmentScope|null|undefined,
    right:AttachmentScope|null|undefined
):boolean {
    if (!left || !right || left.epoch !== right.epoch) return false
    if (left.groupId.length !== right.groupId.length) return false
    return left.groupId.every((byte, index) => {
        return byte === right.groupId[index]
    })
}

/**
 * The attachments demo's own wiring, minus preact: what a seek asks
 * for, how the stored object is cut into the streams `decrypt` wants,
 * how a failure reads, and how playback is torn down.
 *
 * Pure or hook-injected -- no signals, no DOM, no AudioContext -- so
 * the demo's real logic runs under node.
 */

/** Four octets per Float32 sample. */
export const BYTES_PER_SAMPLE = 4

/**
 * The plaintext window a seek to `startSeconds` asks for: from that
 * second to the end of the attachment.
 *
 * The offset is floored to a whole sample, because `bytesToPcm`
 * reinterprets the decrypted bytes as Float32 and a mid-sample offset
 * would shear every sample after it. An empty or negative window is
 * rejected here with the same error `rangesFor` raises for it, so a
 * caller sees one error type whichever check fires first.
 */
export function seekWindow (
    startSeconds:number,
    plaintextLength:number
):ByteRange {
    const offset = Math.floor(startSeconds * SAMPLE_RATE) *
        BYTES_PER_SAMPLE
    if (offset < 0 || offset >= plaintextLength) {
        throw new AttachmentError()
    }
    return { offset, length: plaintextLength - offset }
}

/** Human-readable summary of the byte ranges a read fetched. */
export function formatRanges (ranges:ByteRange[]):string {
    return ranges.map(r => {
        const from = r.offset
        const to = r.offset + r.length
        if (r.length >= 1024) {
            return `${Math.floor(from / 1024)}-` +
                `${Math.floor(to / 1024)} KB`
        }
        return `${r.length} bytes`
    }).join(', ')
}

/**
 * Cut the stored object into one buffer per range, in order.
 *
 * `decrypt` takes one stream per range, each carrying exactly that
 * range's bytes, so the count and the lengths both have to match. The
 * bounds check is the demo standing in for storage: `slice` would
 * silently return a short buffer for a range past the end, and the
 * failure would surface later as a length mismatch inside `decrypt`.
 * Called on its own, this guard is the only thing that throws.
 */
export function sliceRanges (
    bytes:Uint8Array,
    ranges:ByteRange[]
):Uint8Array[] {
    return ranges.map(r => {
        if (r.offset < 0 || r.offset + r.length > bytes.length) {
            throw new AttachmentError()
        }
        return bytes.slice(r.offset, r.offset + r.length)
    })
}

/** The status line for a failed step. */
export function errorStatus (err:unknown):string {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * What playback holds open. Structural rather than the DOM types, so
 * the teardown runs without an AudioContext.
 */
export interface PlaybackResources {
    streamReader:{ cancel:() => Promise<unknown> }|null
    audioContext:{ close:() => Promise<unknown> }|null
}

/**
 * Release everything a playback holds: cancel the read first, then
 * close the audio clock.
 *
 * That order matters -- cancelling the reader is what makes the
 * decrypt wrapper zeroize the CEK it owns, and it should happen while
 * the rest of the pipeline is still intact. Both calls tolerate an
 * already-released resource, since stop can race a stream that ended
 * on its own.
 */
export async function releasePlayback (
    refs:PlaybackResources
):Promise<void> {
    const reader = refs.streamReader
    refs.streamReader = null
    if (reader) {
        await reader.cancel().catch(() => {})
    }

    const ctx = refs.audioContext
    refs.audioContext = null
    if (ctx) {
        await ctx.close().catch(() => {})
    }
}
