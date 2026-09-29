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
