import type { Signature, SignatureAlgorithm } from './signature.js'
import type { Hash, HashAlgorithm } from './hash.js'
import type { Kdf } from './kdf.js'
import type { Hpke, HpkeAlgorithm } from './hpke.js'
import type { Encoder } from '../codec/tls-encoder.js'
import { contramapEncoder } from '../codec/tls-encoder.js'
import { decodeUint16, encodeUint16 } from '../codec/number.js'
import type { Decoder } from '../codec/tls-decoder.js'
import { mapDecoderOption } from '../codec/tls-decoder.js'
import {
    openEnumNumberEncoder,
    openEnumNumberToKey,
    reverseMap
} from '../util/enum-helpers.js'
import type { Rng } from './rng.js'

export const ciphersuites = {
    MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519: 1,
    MLS_128_DHKEMP256_AES128GCM_SHA256_P256: 2,
    MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519: 3,
    MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448: 4,
    MLS_256_DHKEMP521_AES256GCM_SHA512_P521: 5,
    MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448: 6,
    MLS_256_DHKEMP384_AES256GCM_SHA384_P384: 7,
    // Experimental/non-standard suites. These are not IANA-registered and
    // use the private-use range (0xF000-0xFFFF) so they can never collide
    // with a future standard allocation.
    MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519: 0xF001,
    MLS_128_MLKEM512_CHACHA20POLY1305_SHA256_Ed25519: 0xF002,
    MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519: 0xF003,
    MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519: 0xF004,
    MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519: 0xF005,
    MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519: 0xF006,
    MLS_256_XWING_AES256GCM_SHA512_Ed25519: 0xF007,
    MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519: 0xF008,
    MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87: 0xF009,
    MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87: 0xF00A,
    MLS_256_XWING_AES256GCM_SHA512_MLDSA87: 0xF00B,
    MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87: 0xF00C,
} as const

export type CiphersuiteName = keyof typeof ciphersuites
export type CiphersuiteId = (typeof ciphersuites)[CiphersuiteName]

export type Ciphersuite = {
    hash:HashAlgorithm
    hpke:HpkeAlgorithm
    signature:SignatureAlgorithm
    name:CiphersuiteName
}

export interface CiphersuiteImpl {
    hash:Hash
    hpke:Hpke
    signature:Signature
    kdf:Kdf
    rng:Rng
    name:CiphersuiteName
}

export const encodeCiphersuite:Encoder<CiphersuiteName> = contramapEncoder(
    encodeUint16,
    openEnumNumberEncoder(ciphersuites),
)

export const decodeCiphersuite:Decoder<CiphersuiteName> = mapDecoderOption(
    decodeUint16,
    openEnumNumberToKey(ciphersuites),
)

export function getCiphersuiteNameFromId (id:CiphersuiteId):CiphersuiteName {
    return reverseMap(ciphersuites)[id] as CiphersuiteName
}

export function getCiphersuiteFromId (id:CiphersuiteId):Ciphersuite {
    return ciphersuiteValues[id]
}

export function getCiphersuiteFromName (name:CiphersuiteName):Ciphersuite {
    return ciphersuiteValues[ciphersuites[name]]
}

const ciphersuiteValues:Record<CiphersuiteId, Ciphersuite> = {
    1: {
        hash: 'SHA-256',
        hpke: {
            kem: 'DHKEM-X25519-HKDF-SHA256',
            aead: 'AES128GCM',
            kdf: 'HKDF-SHA256',
        },
        signature: 'Ed25519',
        name: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    },
    2: {
        hash: 'SHA-256',
        hpke: {
            kem: 'DHKEM-P256-HKDF-SHA256',
            aead: 'AES128GCM',
            kdf: 'HKDF-SHA256',
        },
        signature: 'P256',
        name: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256',
    },
    3: {
        hash: 'SHA-256',
        hpke: {
            kem: 'DHKEM-X25519-HKDF-SHA256',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA256',
        },
        signature: 'Ed25519',
        name: 'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519',
    },
    4: {
        hash: 'SHA-512',
        hpke: {
            kem: 'DHKEM-X448-HKDF-SHA512',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed448',
        name: 'MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448',
    },
    5: {
        hash: 'SHA-512',
        hpke: {
            kem: 'DHKEM-P521-HKDF-SHA512',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'P521',
        name: 'MLS_256_DHKEMP521_AES256GCM_SHA512_P521',
    },
    6: {
        hash: 'SHA-512',
        hpke: {
            kem: 'DHKEM-X448-HKDF-SHA512',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed448',
        name: 'MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448',
    },
    7: {
        hash: 'SHA-384',
        hpke: {
            kem: 'DHKEM-P384-HKDF-SHA384',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA384',
        },
        signature: 'P384',
        name: 'MLS_256_DHKEMP384_AES256GCM_SHA384_P384',
    },

    // ML-KEM's DeriveKeyPair (all of ML-KEM-512/768/1024) requires
    // exactly a 64-byte seed regardless of security level (FIPS 203's
    // d || z encoding), and this codebase feeds the raw KDF-derived
    // secret straight into it. So the kdf -- and, for internal
    // consistency, the suite's hash -- must be HKDF-SHA512/SHA-512 for
    // every ML-KEM-based suite, even where the suite's name references
    // a shorter digest.
    0xF001: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-512',
            aead: 'AES128GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519',
    },
    0xF002: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-512',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_128_MLKEM512_CHACHA20POLY1305_SHA256_Ed25519',
    },
    0xF003: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-768',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519',
    },
    0xF004: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-768',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519',
    },
    0xF005: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-1024',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519',
    },
    0xF006: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-1024',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519',
    },
    0xF007: {
        hash: 'SHA-512',
        hpke: {
            kem: 'X-Wing',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
    },
    0xF008: {
        hash: 'SHA-512',
        hpke: {
            kem: 'X-Wing',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'Ed25519',
        name: 'MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519',
    },
    0xF009: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-1024',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'ML-DSA-87',
        name: 'MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87',
    },
    0xF00A: {
        hash: 'SHA-512',
        hpke: {
            kem: 'ML-KEM-1024',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'ML-DSA-87',
        name: 'MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87',
    },
    0xF00B: {
        hash: 'SHA-512',
        hpke: {
            kem: 'X-Wing',
            aead: 'AES256GCM',
            kdf: 'HKDF-SHA512',
        },
        signature: 'ML-DSA-87',
        name: 'MLS_256_XWING_AES256GCM_SHA512_MLDSA87',
    },
    0xF00C: {
        hash: 'SHA-512',
        hpke: {
            kem: 'X-Wing',
            aead: 'CHACHA20POLY1305',
            kdf: 'HKDF-SHA512',
        },
        signature: 'ML-DSA-87',
        name: 'MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87',
    },
} as const
