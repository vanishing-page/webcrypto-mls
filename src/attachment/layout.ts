import { AttachmentError } from './error.js'

export const META_TAG_LENGTH = 16

export interface LayoutParams {
    plaintextLength:number
    segmentMax:number
    epochLength:number
    nh:number
}

export interface Layout {
    nSeg:number
    nEp:number
    headerSize:number
    firstBlockOffset:number
    totalSize:number
    saltOffset:number
    commitmentOffset:number
    snapshotOffset:number
    epochHeadsOffset:number
    metaOffset:number
    metaLen:number
}

/**
 * Object-size ceiling. Per-key AEAD budgets are already satisfied
 * by construction (one epoch key covers 2^epoch_length = 1024
 * invocations, far under the drafts' 2^32 GCM bound); this cap
 * keeps every offset in safe-integer range and bounds a single
 * CEK's object far beyond the design's 128 GiB target. A larger
 * object is a new object with a new object_id.
 */
export const MAX_SEGMENTS = 2 ** 31

export function layout (p:LayoutParams):Layout {
    if (!Number.isSafeInteger(p.plaintextLength) ||
        p.plaintextLength <= 0) {
        throw new AttachmentError()
    }
    const nSeg = Math.ceil(p.plaintextLength / p.segmentMax)
    if (nSeg > MAX_SEGMENTS) throw new AttachmentError()
    const perEpoch = 2 ** p.epochLength
    const nEp = Math.ceil(nSeg / perEpoch)
    const metaLen = p.nh + META_TAG_LENGTH
    const headerSize = 32 + (2 * p.nh) + (nEp * p.nh) +
        (nSeg * metaLen)
    const firstBlockOffset =
        Math.ceil(headerSize / p.segmentMax) * p.segmentMax
    const lastLen = p.plaintextLength - ((nSeg - 1) * p.segmentMax)
    const totalSize = firstBlockOffset +
        ((nSeg - 1) * p.segmentMax) + lastLen
    return {
        nSeg,
        nEp,
        headerSize,
        firstBlockOffset,
        totalSize,
        saltOffset: 0,
        commitmentOffset: 32,
        snapshotOffset: 32 + p.nh,
        epochHeadsOffset: 32 + (2 * p.nh),
        metaOffset: 32 + (2 * p.nh) + (nEp * p.nh),
        metaLen,
    }
}

export function segmentLength (
    l:Layout,
    p:LayoutParams,
    i:number,
):number {
    if (i < 0 || i >= l.nSeg) throw new AttachmentError()
    if (i < l.nSeg - 1) return p.segmentMax
    return p.plaintextLength - (i * p.segmentMax)
}

export function blockRange (
    l:Layout,
    p:LayoutParams,
    i:number,
):{ offset:number, length:number } {
    return {
        offset: l.firstBlockOffset + (i * p.segmentMax),
        length: segmentLength(l, p, i),
    }
}

export function metaRange (
    l:Layout,
    i:number,
):{ offset:number, length:number } {
    return { offset: l.metaOffset + (i * l.metaLen), length: l.metaLen }
}

export function epochOf (p:LayoutParams, i:number):number {
    return Math.floor(i / (2 ** p.epochLength))
}

/**
 * True when every byte in `bytes` from `from` (inclusive) to `to`
 * (exclusive) is zero. Used to check the alignment padding between the
 * header and the first segment, which the writer leaves zero and which
 * no authenticator covers.
 *
 * Not constant time, and does not need to be: the padding is a public
 * constant, not a secret, so an early exit reveals nothing.
 */
export function isZeroRegion (
    bytes:Uint8Array,
    from:number,
    to:number,
):boolean {
    if (from >= to) return true
    for (let i = from; i < to; i++) {
        if (bytes[i] !== 0) return false
    }
    return true
}

export interface ByteRange { offset:number, length:number }

/**
 * The encrypted byte ranges needed to read and verify plaintext
 * [offset, offset+length): the fixed prefix (salt, commitment,
 * snapshot), the epoch-heads region, the metadata runs of every
 * touched epoch, the alignment padding gap, and the touched segment
 * blocks. Adjacent ranges are coalesced.
 *
 * The gap [headerSize, firstBlockOffset) carries no data a range read
 * needs. It is fetched so the range path can hold the same
 * zero-padding invariant the whole-object paths hold: two
 * byte-different stored objects must not both verify as the same
 * attachment. The gap is empty only when headerSize lands exactly on
 * a segmentMax boundary, and then no range is emitted for it.
 */
export function rangesFor (
    p:LayoutParams,
    offset:number,
    length:number,
):{ segFirst:number, segLast:number, ranges:ByteRange[] } {
    // NaN compares false against everything, so the bounds test
    // below would let it through on its own.
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        length <= 0 || offset < 0 ||
        offset + length > p.plaintextLength) {
        throw new AttachmentError()
    }
    const l = layout(p)
    const segFirst = Math.floor(offset / p.segmentMax)
    const segLast = Math.floor((offset + length - 1) / p.segmentMax)
    const perEpoch = 2 ** p.epochLength
    const epFirst = epochOf(p, segFirst)
    const epLast = epochOf(p, segLast)
    const ranges:ByteRange[] = [{
        offset: 0,
        length: l.epochHeadsOffset + (l.nEp * p.nh),
    }]
    for (let e = epFirst; e <= epLast; e++) {
        const first = e * perEpoch
        const count = Math.min(perEpoch, l.nSeg - first)
        ranges.push({
            offset: l.metaOffset + (first * l.metaLen),
            length: count * l.metaLen,
        })
    }
    if (l.firstBlockOffset > l.headerSize) {
        ranges.push({
            offset: l.headerSize,
            length: l.firstBlockOffset - l.headerSize,
        })
    }
    for (let i = segFirst; i <= segLast; i++) {
        ranges.push(blockRange(l, p, i))
    }
    return { segFirst, segLast, ranges: coalesce(ranges) }
}

function coalesce (ranges:ByteRange[]):ByteRange[] {
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset)
    const out:ByteRange[] = []
    for (const r of sorted) {
        const last = out[out.length - 1]
        if (last && r.offset <= last.offset + last.length) {
            const end = Math.max(
                last.offset + last.length, r.offset + r.length,
            )
            last.length = end - last.offset
        } else {
            out.push({ ...r })
        }
    }
    return out
}
