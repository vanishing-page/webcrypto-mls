import { DependencyError } from '../../../mls-error.js'
import type { SignatureAlgorithm, Signature } from '../../signature.js'

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
                        return ed25519.verify(signature, message, publicKey)
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
                        return ed448.verify(signature, message, publicKey)
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
                        return p256.sign(message, signKey as Uint8Array, { prehash: true, format: 'der', lowS: false })
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
                        return p384.sign(message, signKey as Uint8Array, { prehash: true, format: 'der', lowS: false })
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
                        return p521.sign(
                            message,
                            normalizeP521PrivateKey(signKey as Uint8Array),
                            { prehash: true, format: 'der', lowS: false }
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

function normalizeP521PrivateKey (key:Uint8Array):Uint8Array {
    if (key.length >= 66) return key

    const normalized = new Uint8Array(66)
    normalized.set(key, normalized.length - key.length)
    return normalized
}
