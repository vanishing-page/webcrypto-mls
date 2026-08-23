import {
    concatAll, constantTimeEqual, encode, sealKdf,
    uint16be, uint32be, uint64be,
} from './kdf.js'
import type { SealCrypto } from './crypto.js'
import { AttachmentError } from './error.js'

// Profile constants. protocol_id doubles as the profile name in
// draft-sullivan-seal-concrete-00.
// NOTE: PROTOCOL_RO + SNAP_EPOCH_TREE is the conformant pairing.
// draft-02 defines SEAL-attachment as a named instantiation over
// SEAL-RO-v1 with snap_id 0x0003. The vendored spec HTML's profile
// table predates that generalisation and reads as forbidding it; see
// "SEAL Profile and snap_id Conformance" in
// docs/design-plans/2026-08-19-random-access-attachments.md
export const PROTOCOL_RO = 'SEAL-RO-v1'
// PROTOCOL_RW and NONCE_RANDOM distinguish read-only from read-write
// modes, which determine epoch boundaries and rewrite mechanics in
// phases 2-4.
export const PROTOCOL_RW = 'SEAL-RW-v1'
export const AAD_LABEL = 'SEAL-DATA'
export const NONCE_RANDOM = 0x00
export const NONCE_DERIVED = 0x01
// Snapshot ID profile constants for phases 2-4 (object/stream layers)
export const SNAP_NONE = 0x0000
export const SNAP_MULTISET = 0x0001
// NOTE: see the PROTOCOL_RO note above. swift-raae rejects 0x0003 as
// unsupportedSnapID before it evaluates the profile tuple, so its
// rejection says nothing about this pairing.
export const SNAP_EPOCH_TREE = 0x0003
// Segment sizing and epoch profile constants for phases 2-4
export const SEGMENT_MAX = 65536
export const ATTACHMENT_EPOCH_LENGTH = 10
export const SALT_LENGTH = 32

export interface SealParams {
    protocolId:string
    aeadId:number
    kdfId:number
    segmentMax:number
    snapId:number
    nonceMode:number
    epochLength:number
    salt:Uint8Array
}

/**
 * Validate numeric ranges for all SealParams fields. Rejects out-of-range
 * values that would silently truncate or wrap during encoding.
 */
function validateParams (p:SealParams):void {
    if (!Number.isInteger(p.aeadId) || p.aeadId < 0 ||
        p.aeadId > 0xFFFF) {
        throw new AttachmentError()
    }
    if (!Number.isInteger(p.kdfId) || p.kdfId < 0 ||
        p.kdfId > 0xFFFF) {
        throw new AttachmentError()
    }
    if (!Number.isInteger(p.snapId) || p.snapId < 0 ||
        p.snapId > 0xFFFF) {
        throw new AttachmentError()
    }
    if (!Number.isInteger(p.segmentMax) || p.segmentMax < 0 ||
        p.segmentMax > 0xFFFFFFFF) {
        throw new AttachmentError()
    }
    if (!Number.isInteger(p.nonceMode) || p.nonceMode < 0 ||
        p.nonceMode > 0xFF) {
        throw new AttachmentError()
    }
    if (!Number.isInteger(p.epochLength) || p.epochLength < 0 ||
        p.epochLength > 0xFF) {
        throw new AttachmentError()
    }
    if (p.salt.length !== SALT_LENGTH) throw new AttachmentError()
}

export interface SealState {
    params:SealParams
    commitment:Uint8Array
    payloadKey:Uint8Array
    snapKey:Uint8Array
    nonceBase:Uint8Array|null
    crypto:SealCrypto
    /**
     * Expanded epoch keys, keyed by epoch index. All 2^epochLength
     * segments of an epoch share one key, so this turns one HKDF
     * extract-and-expand per segment into one per epoch. The buffers
     * belong to the state: `segmentKey` hands out the cached array
     * rather than a copy, so callers must not mutate or zero it.
     * `wipeSealState` owns zeroizing them. Nothing serializes a
     * SealState, so a Map field costs nothing at the wire boundary.
     */
    epochKeys:Map<bigint, Uint8Array>
}

async function deriveSchedule (
    cek:Uint8Array,
    params:SealParams,
    g:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    validateParams(params)

    const { kdf } = crypto
    const pid = params.protocolId
    // Framing pinned by test_vectors/seal/core/F1.json: use seven raw
    // fields rather than encoded payload_info
    const rawFields = [
        uint16be(params.aeadId),
        uint32be(params.segmentMax),
        uint16be(params.kdfId),
        uint16be(params.snapId),
        Uint8Array.of(params.nonceMode),
        Uint8Array.of(params.epochLength),
        params.salt,
    ]
    const nh = kdf.size
    const commitment = await sealKdf(
        kdf, pid, 'commit', [cek], [...rawFields, g], nh,
    )
    const payloadKey = await sealKdf(
        kdf, pid, 'payload_key', [cek], rawFields, crypto.keyLength,
    )
    const snapKey = await sealKdf(
        kdf, pid, 'acc_key', [cek], rawFields, nh,
    )
    const nonceBase = params.nonceMode === NONCE_DERIVED ?
        await sealKdf(
            kdf, pid, 'nonce_base', [cek], rawFields, crypto.nonceLength,
        ) :
        null
    return {
        params,
        commitment,
        payloadKey,
        snapKey,
        nonceBase,
        crypto,
        epochKeys: new Map(),
    }
}

export async function startSeal (
    cek:Uint8Array,
    params:SealParams,
    g:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    return deriveSchedule(cek, params, g, crypto)
}

/**
 * Key-commitment gate: recompute the commitment and compare in
 * constant time BEFORE any AEAD operation. raae-02 section 4.5.1.
 */
export async function startOpen (
    cek:Uint8Array,
    params:SealParams,
    g:Uint8Array,
    storedCommitment:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    const state = await deriveSchedule(cek, params, g, crypto)
    if (!constantTimeEqual(state.commitment, storedCommitment)) {
        // The schedule is complete by the time the gate can run, so a
        // rejected open has already derived payloadKey, snapKey and
        // nonceBase. Nothing may outlive the rejection. The error is
        // unchanged: still a bare AttachmentError that says nothing
        // about why the open failed.
        wipeSealState(state)
        throw new AttachmentError()
    }
    return state
}

/**
 * Derive per-segment key for a given index. The key is derived from
 * the payload key and epoch index: index >> epochLength determines
 * which epoch the segment belongs to, and KDF(payloadKey, epochIndex)
 * produces the key used for both encryption and decryption.
 *
 * The derivation depends only on the epoch, so the result is cached on
 * `state.epochKeys` and every later segment of that epoch is a map
 * lookup. OWNERSHIP: the returned array is the cached one, not a copy.
 * Callers must treat it as read-only -- zeroing it would poison every
 * remaining segment of the epoch. `wipeSealState` zeroizes the cache.
 */
export async function segmentKey (
    state:SealState,
    index:bigint,
):Promise<Uint8Array> {
    // Guard segment index to prevent uint64be overflow.
    // Maximum index before (index << 1n) | finality reaches 2^64.
    if (index < 0n || index >= (1n << 63n)) {
        throw new AttachmentError()
    }
    const epochIndex = index >> BigInt(state.params.epochLength)
    const cached = state.epochKeys.get(epochIndex)
    if (cached) return cached
    const key = await sealKdf(
        state.crypto.kdf,
        state.params.protocolId,
        'epoch_key',
        [state.payloadKey],
        [uint64be(epochIndex)],
        state.crypto.keyLength,
    )
    state.epochKeys.set(epochIndex, key)
    return key
}

/**
 * Derived nonce. raae-02 section 4.5.3.2:
 * nonce_base[0:Nn-8] || (nonce_base[Nn-8:] XOR uint64((i<<1)|f)).
 * nonceBase must be at least 8 bytes to support XOR of final 8 octets.
 * Index must fit in the range [0, 2^63) because (index << 1) | finality
 * must fit in a u64 (max value 2^64 - 1). Silently truncating via uint64be
 * would cause nonce collisions, so we reject out-of-range indices.
 */
export function derivedNonce (
    nonceBase:Uint8Array,
    index:bigint,
    isFinal:boolean,
):Uint8Array {
    if (nonceBase.length < 8) throw new AttachmentError()
    if (index < 0n || index >= (1n << 63n)) throw new AttachmentError()
    const nonce = nonceBase.slice()
    const mixed = (index << 1n) | (isFinal ? 1n : 0n)
    const tail = uint64be(mixed)
    const start = nonce.length - 8
    for (let i = 0; i < 8; i++) nonce[start + i] ^= tail[i]
    return nonce
}

/**
 * Per-segment AAD. raae-02 section 4.4.2. In derived mode index
 * and finality live in the nonce, so empty extra AAD means an
 * empty AAD pass.
 */
export async function segmentAad (
    state:SealState,
    index:bigint,
    isFinal:boolean,
    extra:Uint8Array,
):Promise<Uint8Array> {
    // Guard segment index to prevent uint64be overflow and colliding AAD.
    if (index < 0n || index >= (1n << 63n)) {
        throw new AttachmentError()
    }
    const { kdf } = state.crypto
    if (state.params.nonceMode === NONCE_DERIVED) {
        if (extra.length === 0) return new Uint8Array()
        return encode(kdf, AAD_LABEL, extra)
    }
    const finalByte = Uint8Array.of(isFinal ? 1 : 0)
    if (extra.length === 0) {
        return encode(kdf, AAD_LABEL, uint64be(index), finalByte)
    }
    return encode(kdf, AAD_LABEL, uint64be(index), finalByte, extra)
}

export interface SealedSegment {
    ciphertext:Uint8Array
    tag:Uint8Array
    nonce:Uint8Array
}

export async function sealSegment (
    state:SealState,
    opts:{
        index:bigint
        isFinal:boolean
        plaintext:Uint8Array
        nonce?:Uint8Array
        aad?:Uint8Array
    },
):Promise<SealedSegment> {
    const { index, isFinal, plaintext } = opts
    const extra = opts.aad ?? new Uint8Array()
    let nonce:Uint8Array
    if (state.params.nonceMode === NONCE_DERIVED) {
        if (!state.nonceBase) throw new AttachmentError()
        nonce = derivedNonce(state.nonceBase, index, isFinal)
    } else {
        if (!opts.nonce) throw new AttachmentError()
        nonce = opts.nonce
    }
    if (nonce.length !== state.crypto.nonceLength) {
        throw new AttachmentError()
    }
    const key = await segmentKey(state, index)
    const aad = await segmentAad(state, index, isFinal, extra)
    const sealed = await state.crypto.aead.encrypt(
        key, nonce, aad, plaintext,
    )
    const split = sealed.length - state.crypto.tagLength
    return {
        ciphertext: sealed.slice(0, split),
        tag: sealed.slice(split),
        nonce,
    }
}

export async function openSegment (
    state:SealState,
    opts:{
        index:bigint
        isFinal:boolean
        ciphertext:Uint8Array
        tag:Uint8Array
        nonce?:Uint8Array
        aad?:Uint8Array
    },
):Promise<Uint8Array> {
    const { index, isFinal } = opts
    const extra = opts.aad ?? new Uint8Array()
    let nonce:Uint8Array
    if (state.params.nonceMode === NONCE_DERIVED) {
        if (!state.nonceBase) throw new AttachmentError()
        nonce = derivedNonce(state.nonceBase, index, isFinal)
    } else {
        if (!opts.nonce) throw new AttachmentError()
        nonce = opts.nonce
    }
    if (nonce.length !== state.crypto.nonceLength) {
        throw new AttachmentError()
    }
    if (opts.tag.length !== state.crypto.tagLength) {
        throw new AttachmentError()
    }
    const key = await segmentKey(state, index)
    const aad = await segmentAad(state, index, isFinal, extra)
    const joined = concatAll([opts.ciphertext, opts.tag])
    try {
        return await state.crypto.aead.decrypt(key, nonce, aad, joined)
    } catch (_err) {
        throw new AttachmentError()
    }
}

/**
 * Best-effort zeroization of derived key material. The CEK is the
 * wrapper's to wipe: decryptAttachmentStream and openAttachmentRange
 * take an optional ownedCek parameter and wipe it on exit. The
 * commitment is not secret and survives for error reporting.
 */
export function wipeSealState (state:SealState):void {
    state.payloadKey.fill(0)
    state.snapKey.fill(0)
    state.nonceBase?.fill(0)
    // Zero the buffers before dropping the references. Clearing the map
    // alone would leave live epoch keys to the garbage collector.
    for (const key of state.epochKeys.values()) key.fill(0)
    state.epochKeys.clear()
}
