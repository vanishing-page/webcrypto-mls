import type { CredentialTypeName } from './credential-type.js'
import { decodeCredentialType, encodeCredentialType } from './credential-type.js'
import type { CiphersuiteName } from './crypto/ciphersuite.js'
import { decodeCiphersuite, encodeCiphersuite } from './crypto/ciphersuite.js'
import type { CapabilityProtocolVersion } from './protocol-version.js'
import {
    decodeCapabilityProtocolVersion,
    encodeCapabilityProtocolVersion
} from './protocol-version.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import { decodeVarLenType, encodeVarLenType } from './codec/variable-length.js'
import { decodeUint16, encodeUint16 } from './codec/number.js'

export interface Capabilities {
    versions:CapabilityProtocolVersion[]
    ciphersuites:CiphersuiteName[]
    extensions:number[]
    proposals:number[]
    credentials:CredentialTypeName[]
}

export const encodeCapabilities:Encoder<Capabilities> = contramapEncoders(
    [
        encodeVarLenType(encodeCapabilityProtocolVersion),
        encodeVarLenType(encodeCiphersuite),
        encodeVarLenType(encodeUint16),
        encodeVarLenType(encodeUint16),
        encodeVarLenType(encodeCredentialType),
    ],
    (cap) => [cap.versions, cap.ciphersuites, cap.extensions, cap.proposals, cap.credentials] as const,
)

export const decodeCapabilities:Decoder<Capabilities> = mapDecoders(
    [
        decodeVarLenType(decodeCapabilityProtocolVersion),
        decodeVarLenType(decodeCiphersuite),
        decodeVarLenType(decodeUint16),
        decodeVarLenType(decodeUint16),
        decodeVarLenType(decodeCredentialType),
    ],
    (versions, ciphersuites, extensions, proposals, credentials) => ({
        versions,
        ciphersuites,
        extensions,
        proposals,
        credentials,
    }),
)
