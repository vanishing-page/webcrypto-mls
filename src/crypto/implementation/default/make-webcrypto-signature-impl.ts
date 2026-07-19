import type { Signature } from '../../signature.js'
import { ValidationError } from '../../../mls-error.js'

// WebCrypto subtle API requires BufferSource for key material,
// but Uint8Array has variance that requires casting to BufferSource.
const subtle = globalThis.crypto.subtle

// RFC 8410 PKCS8 prefix for a raw 32-byte Ed25519 private seed.
// SEQUENCE(46) { INTEGER 0, SEQUENCE { OID 1.3.101.112 },
//   OCTET STRING(34) { OCTET STRING(32) { <seed> } } }
const ED25519_PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

export function makeWebCryptoSignatureImpl ():Signature {
    return {
        async keygen () {
            const pair = await subtle.generateKey(
                { name: 'Ed25519' },
                false,
                ['sign', 'verify'],
            ) as CryptoKeyPair
            const publicKey = new Uint8Array(
                await subtle.exportKey('raw', pair.publicKey),
            )
            return { publicKey, signKey: pair.privateKey }
        },

        async sign (signKey, message) {
            const sig = await subtle.sign(
                { name: 'Ed25519' },
                // Safe: hybrid selector in make-signature-impl.ts guarantees
                // Ed25519 signKeys originate from keygen or importSignatureKey,
                // both of which always return CryptoKey (never Uint8Array).
                signKey as CryptoKey,
                message as BufferSource,
            )
            return new Uint8Array(sig)
        },

        async verify (publicKey, message, signature) {
            const key = await subtle.importKey(
                'raw',
                publicKey as BufferSource,
                { name: 'Ed25519' },
                false,
                ['verify'],
            )
            return subtle.verify(
                { name: 'Ed25519' },
                key,
                signature as BufferSource,
                message as BufferSource,
            )
        },

        async importSignatureKey (seed) {
            if (seed.length !== 32) {
                throw new ValidationError(
                    `Ed25519 seed must be exactly 32 bytes, got ${
                        seed.length
                    }`
                )
            }
            const pkcs8 = new Uint8Array(
                ED25519_PKCS8_PREFIX.length + seed.length,
            )
            pkcs8.set(ED25519_PKCS8_PREFIX, 0)
            pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
            return subtle.importKey(
                'pkcs8',
                pkcs8 as BufferSource,
                { name: 'Ed25519' },
                false,
                ['sign'],
            )
        },
    }
}
