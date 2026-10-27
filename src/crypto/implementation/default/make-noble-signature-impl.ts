import { DependencyError, UsageError } from '../../../mls-error.js'
import type { SignatureAlgorithm, Signature } from '../../signature.js'
import {
    isSmallOrderEd25519,
    isSmallOrderEd448,
} from '../../small-order.js'

export async function makeNobleSignatureImpl (alg:SignatureAlgorithm):Promise<Signature> {
    switch (alg) {
        case 'Ed25519':
            try {
                const { ed25519 } = await import('@noble/curves/ed25519.js')
                return {
                    async sign (signKey, message) {
                        return ed25519.sign(message, signKey as Uint8Array)
                    },
                    async verify (publicKey, message, signature) {
                        // strict RFC 8032, matching WebCrypto (M4)
                        if (isSmallOrderEd25519(publicKey)) return false
                        return ed25519.verify(signature, message, publicKey,
                            { zip215: false })
                    },
                    async keygen () {
                        const signKey = ed25519.utils.randomSecretKey()
                        return { signKey, publicKey: ed25519.getPublicKey(signKey) }
                    },
                    async importSignatureKey (seed) {
                        return seed
                    },
                }
            } catch (_err) {
                throw new DependencyError(
                    "Optional dependency '@noble/curves' is not installed. Please install it to use this feature.",
                )
            }

        case 'Ed448':
            try {
                const { ed448 } = await import('@noble/curves/ed448.js')
                return {
                    async sign (signKey, message) {
                        return ed448.sign(message, signKey as Uint8Array)
                    },
                    async verify (publicKey, message, signature) {
                        if (isSmallOrderEd448(publicKey)) return false
                        return ed448.verify(signature, message, publicKey,
                            { zip215: false })
                    },
                    async keygen () {
                        const signKey = ed448.utils.randomSecretKey()
                        return { signKey, publicKey: ed448.getPublicKey(signKey) }
                    },
                    async importSignatureKey (seed) {
                        return seed
                    },
                }
            } catch (_err) {
                throw new DependencyError(
                    "Optional dependency '@noble/curves' is not installed. Please install it to use this feature.",
                )
            }

        case 'P256':
            try {
                const { p256 } = await import('@noble/curves/nist.js')
                return {
                    async sign (signKey, message) {
                        return withFieldLengthKey(
                            signKey as Uint8Array,
                            32,
                            (key) => p256.sign(message, key, {
                                prehash: true, format: 'der', lowS: false
                            })
                        )
                    },
                    async verify (publicKey, message, signature) {
                        return p256.verify(signature, message, publicKey, { prehash: true, format: 'der', lowS: false })
                    },
                    async keygen () {
                        const signKey = p256.utils.randomSecretKey()
                        return { signKey, publicKey: p256.getPublicKey(signKey) }
                    },
                    async importSignatureKey (seed) {
                        return seed
                    },
                }
            } catch (_err) {
                throw new DependencyError(
                    "Optional dependency '@noble/curves' is not installed. Please install it to use this feature.",
                )
            }
        case 'P384':
            try {
                const { p384 } = await import('@noble/curves/nist.js')
                return {
                    async sign (signKey, message) {
                        return withFieldLengthKey(
                            signKey as Uint8Array,
                            48,
                            (key) => p384.sign(message, key, {
                                prehash: true, format: 'der', lowS: false
                            })
                        )
                    },
                    async verify (publicKey, message, signature) {
                        return p384.verify(signature, message, publicKey, { prehash: true, format: 'der', lowS: false })
                    },
                    async keygen () {
                        const signKey = p384.utils.randomSecretKey()
                        return { signKey, publicKey: p384.getPublicKey(signKey) }
                    },
                    async importSignatureKey (seed) {
                        return seed
                    },
                }
            } catch (_err) {
                throw new DependencyError(
                    "Optional dependency '@noble/curves' is not installed. Please install it to use this feature.",
                )
            }
        case 'P521':
            try {
                const { p521 } = await import('@noble/curves/nist.js')
                return {
                    async sign (signKey, message) {
                        return withFieldLengthKey(
                            signKey as Uint8Array,
                            66,
                            (key) => p521.sign(message, key, {
                                prehash: true, format: 'der', lowS: false
                            })
                        )
                    },
                    async verify (publicKey, message, signature) {
                        return p521.verify(signature, message, publicKey, { prehash: true, format: 'der', lowS: false })
                    },
                    async keygen () {
                        const signKey = p521.utils.randomSecretKey()
                        return { signKey, publicKey: p521.getPublicKey(signKey) }
                    },
                    async importSignatureKey (seed) {
                        return seed
                    },
                }
            } catch (_err) {
                throw new DependencyError(
                    "Optional dependency '@noble/curves' is not installed. Please install it to use this feature.",
                )
            }
        case 'ML-DSA-87':
            try {
                const { ml_dsa87: mlDsa87 } = await import('@noble/post-quantum/ml-dsa.js')
                return {
                    async sign (signKey, message) {
                        return mlDsa87.sign(message, signKey as Uint8Array)
                    },
                    async verify (publicKey, message, signature) {
                        return mlDsa87.verify(signature, message, publicKey)
                    },
                    async keygen () {
                        const keys = mlDsa87.keygen(crypto.getRandomValues(new Uint8Array(32)))
                        return { signKey: keys.secretKey, publicKey: keys.publicKey }
                    },
                    async importSignatureKey (seed) {
                        return seed
                    },
                }
            } catch (_err) {
                throw new DependencyError(
                    "Optional dependency '@noble/post-quantum' is not installed. Please install it to use this feature.",
                )
            }
    }
}

/**
 * Run `sign` with a P-curve private key at exactly the field length. A
 * source that trims leading zero bytes yields a shorter key, which noble
 * rejects, so it is left-padded into a copy this call owns and wipes. The
 * caller's key is never written to.
 */
function withFieldLengthKey (
    key:Uint8Array,
    fieldLength:number,
    sign:(key:Uint8Array) => Uint8Array
):Uint8Array {
    if (key.length > fieldLength) {
        throw new UsageError(
            `Private key is ${key.length} bytes, longer than the ` +
            `${fieldLength}-byte field length`
        )
    }
    if (key.length === fieldLength) return sign(key)

    const padded = new Uint8Array(fieldLength)
    try {
        padded.set(key, fieldLength - key.length)
        return sign(padded)
    } finally {
        padded.fill(0)
    }
}
