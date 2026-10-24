import type { KemAlgorithm } from './kem.js'
import type { SignatureAlgorithm } from './signature.js'

// An EdDSA public key of small order (the identity among them) lets
// R = identity, S = 0 verify for every message: a universal forgery.
// Every small-order point is determined by its y coordinate up to the
// sign of x, so each check reads y, reduces it mod p to catch
// non-canonical encodings, and compares it to the curve's short list.

const P25519 = (1n << 255n) - 19n
// y of the order-8 points
const Y8_25519 = BigInt('0x7a03ac9277fdc74ec6cc392cfa53202a' +
    '0f67100d760b3cba4fd84d3d706a17c7')
const SMALL_ORDER_Y_25519 = new Set([
    0n, 1n, P25519 - 1n, Y8_25519, P25519 - Y8_25519,
])

const P448 = (1n << 448n) - (1n << 224n) - 1n
// Ed448 has cofactor 4: (0, 1), (0, -1) and (+-1, 0).
const SMALL_ORDER_Y_448 = new Set([0n, 1n, P448 - 1n])

function littleEndian (bytes:Uint8Array):bigint {
    let n = 0n
    for (let i = bytes.length - 1; i >= 0; i--) {
        n = (n << 8n) | BigInt(bytes[i]!)
    }
    return n
}

export function isSmallOrderEd25519 (key:Uint8Array):boolean {
    if (key.length !== 32) return false
    const y = littleEndian(key) & ((1n << 255n) - 1n)
    return SMALL_ORDER_Y_25519.has(y % P25519)
}

export function isSmallOrderEd448 (key:Uint8Array):boolean {
    if (key.length !== 57) return false
    const y = littleEndian(key.subarray(0, 56))
    return SMALL_ORDER_Y_448.has(y % P448)
}

/**
 * True when `key` is an EdDSA signature key of small order for `alg`.
 * Always false for non-EdDSA algorithms.
 */
export function isSmallOrderSignatureKey (
    alg:SignatureAlgorithm,
    key:Uint8Array,
):boolean {
    if (alg === 'Ed25519') return isSmallOrderEd25519(key)
    if (alg === 'Ed448') return isSmallOrderEd448(key)
    return false
}

// An X25519 or X448 public key of low order makes the DH output a
// fixed, publicly known value, so HPKE either fails at seal time or
// encrypts under a key anyone can compute. The u coordinate alone
// identifies these points, so each check reduces u mod p (catching
// non-canonical encodings) and compares it to the curve's short list.

// u of the two order-8 points
const U8_25519_A = BigInt('0x00b8495f16056286fdb1329ceb8d09da' +
    '6ac49ff1fae35616aeb8413b7c7aebe0')
const U8_25519_B = BigInt('0x57119fd0dd4e22d8868e1c58c45c4404' +
    '5bef839c55b1d0b1248c50a3bc959c5f')
const LOW_ORDER_U_25519 = new Set([
    0n, 1n, P25519 - 1n, U8_25519_A, U8_25519_B,
])

/**
 * True when `key` is an X25519 public key of low order. RFC 7748
 * section 5 masks the top bit of the last byte before decoding u.
 * A key of the wrong length answers false; import decides that case.
 */
export function isLowOrderX25519 (key:Uint8Array):boolean {
    if (key.length !== 32) return false
    const u = littleEndian(key) & ((1n << 255n) - 1n)
    return LOW_ORDER_U_25519.has(u % P25519)
}

// X448 has cofactor 4; its low-order u values are 0, 1 and p - 1.
const LOW_ORDER_U_448 = new Set([0n, 1n, P448 - 1n])

/**
 * True when `key` is an X448 public key of low order. All 56 bytes are
 * read; RFC 7748 masks no bit for X448. A key of the wrong length
 * answers false.
 */
export function isLowOrderX448 (key:Uint8Array):boolean {
    if (key.length !== 56) return false
    return LOW_ORDER_U_448.has(littleEndian(key) % P448)
}

/**
 * True when `key` is a low-order public key for the KEM `alg`. Always
 * false for the NIST curve KEMs, ML-KEM and X-Wing, where the HPKE
 * provider's import is the whole check.
 */
export function isLowOrderKemPublicKey (
    alg:KemAlgorithm,
    key:Uint8Array,
):boolean {
    if (alg === 'DHKEM-X25519-HKDF-SHA256') return isLowOrderX25519(key)
    if (alg === 'DHKEM-X448-HKDF-SHA512') return isLowOrderX448(key)
    return false
}
