import type { Aead, AeadAlgorithm } from '../crypto/aead.js'
import type { Kdf, KdfAlgorithm } from '../crypto/kdf.js'
import type { Hash, HashAlgorithm } from '../crypto/hash.js'
import type { Rng } from '../crypto/rng.js'
import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../crypto/ciphersuite.js'
import { makeAead } from '../crypto/implementation/default/make-aead.js'
import {
    makeKdf,
    makeKdfImpl,
} from '../crypto/implementation/default/make-kdf-impl.js'
import {
    makeHashImpl,
} from '../crypto/implementation/default/make-hash-impl.js'
import { defaultRng } from '../crypto/implementation/default/rng.js'
import { AttachmentError } from './error.js'

// RFC 5116 AEAD registry and RFC 9180 KDF registry code points.
export const AEAD_IDS:Record<AeadAlgorithm, number> = {
    AES128GCM: 0x0001,
    AES256GCM: 0x0002,
    CHACHA20POLY1305: 0x001D,
}

export const KDF_IDS:Record<KdfAlgorithm, number> = {
    'HKDF-SHA256': 0x0001,
    'HKDF-SHA384': 0x0002,
    'HKDF-SHA512': 0x0003,
}

// AEAD algorithm key lengths for phases 2-4
export const AEAD_KEY_LENGTHS:Record<AeadAlgorithm, number> = {
    AES128GCM: 16,
    AES256GCM: 32,
    CHACHA20POLY1305: 32,
}

/**
 * The primitive bundle every attachment entry point takes. It is a
 * plain record of the caller's own crypto, not a class: build it once
 * with `sealCryptoFromCiphersuite` (the normal path, which reuses the
 * primitives the caller's `CryptoProvider` already made) or with
 * `sealCryptoFromIds` (vectors and interop, which need
 * `(aead_id, kdf_id)` pairs no MLS ciphersuite offers).
 *
 * - `aead`, `kdf`, `hash`, `rng`: the primitives themselves. `rng` is
 *   what a seal draws its 32-octet salt from when the caller pins
 *   none.
 * - `aeadId`, `kdfId`: RFC 5116 and RFC 9180 registry code points.
 *   They are bound into the key schedule, so an object sealed under
 *   one pair will not open under another.
 * - `keyLength`, `nonceLength`, `tagLength`: octet lengths of the AEAD
 *   key, nonce and tag. `kdf.size` (the KDF output length) sets the
 *   size of every commitment, leaf, epoch head and snapshot, and so
 *   the size of an object's header.
 *
 * Owns no secrets and wipes nothing. The bundle holds long-lived
 * primitives, and the per-object key material lives in the
 * `SealState` that `startSeal` and `startOpen` build and their
 * callers wipe.
 */
export interface SealCrypto {
    aead:Aead
    kdf:Kdf
    hash:Hash
    rng:Rng
    aeadId:number
    kdfId:number
    keyLength:number
    nonceLength:number
    tagLength:number
}

/**
 * Wrap a caller-provided CiphersuiteImpl. Reuses the caller's own
 * primitives (whatever CryptoProvider built them); only the
 * registry code points come from the suite table.
 */
export function sealCryptoFromCiphersuite (
    cs:CiphersuiteImpl,
):SealCrypto {
    const suite = getCiphersuiteFromName(cs.name)
    const aeadAlg = suite.hpke.aead
    const kdfAlg = suite.hpke.kdf
    return {
        aead: {
            encrypt: (key, nonce, aad, pt) =>
                cs.hpke.encryptAead(key, nonce, aad, pt),
            decrypt: (key, nonce, aad, ct) =>
                cs.hpke.decryptAead(key, nonce, aad, ct),
        },
        kdf: cs.kdf,
        hash: cs.hash,
        rng: cs.rng,
        aeadId: AEAD_IDS[aeadAlg],
        kdfId: KDF_IDS[kdfAlg],
        keyLength: cs.hpke.keyLength,
        nonceLength: cs.hpke.nonceLength,
        // All AEAD algorithms (AES-GCM, ChaCha20-Poly1305) produce a
        // 16-byte authentication tag in this phase's implementations.
        tagLength: 16,
    }
}

const AEAD_BY_ID:Record<number, AeadAlgorithm> = {
    0x0001: 'AES128GCM',
    0x0002: 'AES256GCM',
    0x001D: 'CHACHA20POLY1305',
}

const KDF_BY_ID:Record<number, {
    alg:KdfAlgorithm
    hash:HashAlgorithm
}> = {
    0x0001: { alg: 'HKDF-SHA256', hash: 'SHA-256' },
    0x0002: { alg: 'HKDF-SHA384', hash: 'SHA-384' },
    0x0003: { alg: 'HKDF-SHA512', hash: 'SHA-512' },
}

/**
 * Standalone constructor for arbitrary (aead_id, kdf_id) pairs;
 * used by vector tests, which need combinations no MLS ciphersuite
 * offers. Uses the default provider's primitives.
 */
export async function sealCryptoFromIds (
    aeadId:number,
    kdfId:number,
    rng:Rng = defaultRng,
):Promise<SealCrypto> {
    const aeadAlg = AEAD_BY_ID[aeadId]
    const k = KDF_BY_ID[kdfId]
    if (!aeadAlg || !k) throw new AttachmentError()
    const [aead] = await makeAead(aeadAlg)
    const kdf = makeKdfImpl(makeKdf(k.alg))
    const hash = makeHashImpl(globalThis.crypto.subtle, k.hash)
    return {
        aead,
        kdf,
        hash,
        rng,
        aeadId,
        kdfId,
        keyLength: AEAD_KEY_LENGTHS[aeadAlg],
        nonceLength: 12,
        tagLength: 16,
    }
}

