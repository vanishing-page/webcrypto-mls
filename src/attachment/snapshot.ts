import type { SealState } from './schedule.js'
import { concatAll, lh, sealKdf, uint64be } from './kdf.js'
import { AttachmentError } from './error.js'

export function xorInto (acc:Uint8Array, x:Uint8Array):void {
    if (acc.length !== x.length) throw new AttachmentError()
    for (let i = 0; i < acc.length; i++) acc[i] ^= x[i]
}

// ---- masked multiset hash (snap_id 0x0001) ----

export async function multisetContrib (
    state:SealState,
    index:bigint,
    tag:Uint8Array,
):Promise<Uint8Array> {
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'acc_contrib',
        [state.snapKey], [uint64be(index), tag],
        state.crypto.kdf.size,
    )
}

export async function multisetSnapshot (
    state:SealState,
    nSeg:bigint,
    acc:Uint8Array,
):Promise<Uint8Array> {
    // Label pinned by test_vectors/seal/engine/F16.json and F17.json;
    // the draft's prose named this snap_acc, the vector is authoritative.
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'snapshot_tag',
        [state.snapKey], [uint64be(nSeg), acc],
        state.crypto.kdf.size,
    )
}

export async function multisetMask (
    state:SealState,
    nSeg:bigint,
    snapshot:Uint8Array,
):Promise<Uint8Array> {
    // Label pinned by test_vectors/seal/engine/F16.json and F17.json;
    // the draft's prose named this acc_mask, the vector is authoritative.
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'snapshot_mask',
        [state.snapKey], [uint64be(nSeg), snapshot],
        state.crypto.kdf.size,
    )
}

// ---- epoch digest tree (snap_id 0x0003) ----

export async function segmentLeaf (
    state:SealState,
    ciphertext:Uint8Array,
    tag:Uint8Array,
):Promise<Uint8Array> {
    const digest = await lh(ciphertext, state.crypto.kdf)
    return concatAll([digest, tag])
}

export async function epochHead (
    state:SealState,
    epochRun:Uint8Array,
):Promise<Uint8Array> {
    const digest = await lh(epochRun, state.crypto.kdf)
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'snap_epoch',
        [state.snapKey], [digest], state.crypto.kdf.size,
    )
}

export async function epochTreeRoot (
    state:SealState,
    nSeg:bigint,
    heads:Uint8Array,
):Promise<Uint8Array> {
    const digest = await lh(heads, state.crypto.kdf)
    return sealKdf(
        state.crypto.kdf, state.params.protocolId,
        'snap_epoch_root',
        [state.snapKey],
        [state.commitment, uint64be(nSeg), digest],
        state.crypto.kdf.size,
    )
}
