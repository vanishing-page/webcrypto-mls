import type { SealParams, SealState } from
    '../../src/attachment/schedule.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import { sealCryptoFromIds } from
    '../../src/attachment/crypto.js'
import { segmentKey } from '../../src/attachment/schedule.js'
import { AttachmentError } from '../../src/attachment/error.js'
import type { KdfAlgorithm } from '../../src/crypto/kdf.js'
import {
    makeKdf,
    makeKdfImpl,
} from '../../src/crypto/implementation/default/make-kdf-impl.js'
import type { HashAlgorithm } from '../../src/crypto/hash.js'
import {
    makeHashImpl,
} from '../../src/crypto/implementation/default/make-hash-impl.js'
import type { Aead } from '../../src/crypto/aead.js'
import { defaultRng } from
    '../../src/crypto/implementation/default/rng.js'

export function fromHex (hex:string):Uint8Array {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return out
}

export function toHex (bytes:Uint8Array):string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

/**
 * The printable ASCII in an expand's `info`. sealKdf encodes its label
 * there, so this is enough to tell one derivation step from another
 * without depending on how many expands precede it.
 */
export function labelOf (info:Uint8Array):string {
    let s = ''
    for (const b of info) {
        s += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ' '
    }
    return s
}

export type CoreVector = {
    name:string
    protocol_id:string
    cek_hex:string
    payload_info:{
        aead_id:number
        segment_max:number
        kdf_id:number
        snap_id:number
        nonce_mode:number
        epoch_length:number
        salt_hex:string
    }
    schedule:{
        commitment_hex:string
        payload_key_hex:string
        acc_key_hex?:string
        nonce_base_hex?:string
    }
    segment_0?:{
        is_final:number
        nonce_hex:string
        segment_aad_hex:string
        segment_key_hex?:string
        ciphertext_hex:string
        tag_hex:string
    }
    segments?:Array<{
        index:number
        is_final:number
        nonce_hex:string
        segment_aad_hex:string
        segment_key_hex?:string
        ciphertext_hex:string
        tag_hex:string
    }>
}

export function paramsFromVector (json:{
    protocol_id:string
    payload_info:{
        aead_id:number
        segment_max:number
        kdf_id:number
        snap_id:number
        nonce_mode:number
        epoch_length:number
        salt_hex:string
    }
}):SealParams {
    return {
        protocolId: json.protocol_id,
        aeadId: json.payload_info.aead_id,
        kdfId: json.payload_info.kdf_id,
        segmentMax: json.payload_info.segment_max,
        snapId: json.payload_info.snap_id,
        nonceMode: json.payload_info.nonce_mode,
        epochLength: json.payload_info.epoch_length,
        salt: fromHex(json.payload_info.salt_hex),
    }
}

// AEAD IDs that sealCryptoFromIds supports
export const SUPPORTED_AEAD_IDS = new Set([0x0001, 0x0002, 0x001D])

// Lookup table for KDF algorithms
const KDF_BY_ID:Record<number, {
    alg:KdfAlgorithm
    hash:HashAlgorithm
}> = {
    0x0001: { alg: 'HKDF-SHA256', hash: 'SHA-256' },
    0x0002: { alg: 'HKDF-SHA384', hash: 'SHA-384' },
    0x0003: { alg: 'HKDF-SHA512', hash: 'SHA-512' },
}

export async function sealCryptoFromVector (
    json:{
        payload_info:{
            aead_id:number
            kdf_id:number
        }
    }
):Promise<SealCrypto> {
    // F17 has aead_id 31 (AES-256-GCM-SIV), unsupported for seal/open.
    // Use KDF-only bundle so schedule tests (which need no AEAD) work.
    if (!SUPPORTED_AEAD_IDS.has(json.payload_info.aead_id)) {
        return sealCryptoKdfOnly(json.payload_info.kdf_id)
    }
    return sealCryptoFromIds(
        json.payload_info.aead_id,
        json.payload_info.kdf_id,
    )
}

/**
 * Get segment key for a vector's segment. Used to verify epoch-key
 * derivation by comparing derived keys against the vector's
 * segment_key_hex values.
 */
export async function getSegmentKeyFromVector (
    state:SealState,
    index:number,
):Promise<string> {
    const key = await segmentKey(state, BigInt(index))
    return toHex(key)
}

/**
 * KDF-only bundle for test vectors with unsupported AEAD ids (e.g., F17's
 * AES-256-GCM-SIV, aead_id 31). The AEAD stub throws if called; KDF
 * operations (schedule derivation, epoch keys) work normally. Used by
 * phase 1 tests which verify schedule correctness for all vectors.
 */
export async function sealCryptoKdfOnly (
    kdfId:number,
    keyLength?:number,
    nonceLength?:number,
):Promise<SealCrypto> {
    const k = KDF_BY_ID[kdfId]
    if (!k) throw new AttachmentError()
    const kdf = makeKdfImpl(makeKdf(k.alg))
    const hash = makeHashImpl(globalThis.crypto.subtle, k.hash)
    const throwingAead:Aead = {
        encrypt: () => Promise.reject(
            new AttachmentError(),
        ),
        decrypt: () => Promise.reject(
            new AttachmentError(),
        ),
    }
    // Default to AES256GCM dimensions if not provided
    const finalKeyLength = keyLength ?? 32
    const finalNonceLength = nonceLength ?? 12
    return {
        aead: throwingAead,
        kdf,
        hash,
        rng: defaultRng,
        aeadId: 0,
        kdfId,
        keyLength: finalKeyLength,
        nonceLength: finalNonceLength,
        tagLength: 16,
    }
}
