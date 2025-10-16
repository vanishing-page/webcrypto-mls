import type { CredentialTypeName } from './credentialType.js'
import { decodeCredentialType, encodeCredentialType } from './credentialType.js'
import type { CiphersuiteName } from './crypto/ciphersuite.js'
import { decodeCiphersuite, encodeCiphersuite } from './crypto/ciphersuite.js'
import type { ProtocolVersionName } from './protocolVersion.js'
import { decodeProtocolVersion, encodeProtocolVersion } from './protocolVersion.js'
import type { Encoder } from './codec/tlsEncoder.js'
import { contramapEncoders } from './codec/tlsEncoder.js'
import type { Decoder } from './codec/tlsDecoder.js'
import { mapDecoders } from './codec/tlsDecoder.js'
import { decodeVarLenType, encodeVarLenType } from './codec/variableLength.js'
import { decodeUint16, encodeUint16 } from './codec/number.js'

export interface Capabilities {
  versions: ProtocolVersionName[]
  ciphersuites: CiphersuiteName[]
  extensions: number[]
  proposals: number[]
  credentials: CredentialTypeName[]
}

export const encodeCapabilities: Encoder<Capabilities> = contramapEncoders(
    [
        encodeVarLenType(encodeProtocolVersion),
        encodeVarLenType(encodeCiphersuite),
        encodeVarLenType(encodeUint16),
        encodeVarLenType(encodeUint16),
        encodeVarLenType(encodeCredentialType),
    ],
    (cap) => [cap.versions, cap.ciphersuites, cap.extensions, cap.proposals, cap.credentials] as const,
)

export const decodeCapabilities: Decoder<Capabilities> = mapDecoders(
    [
        decodeVarLenType(decodeProtocolVersion),
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
