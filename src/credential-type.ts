import { decodeUint16, encodeUint16 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { openEnumNumberEncoder, openEnumNumberToKey } from './util/enum-helpers.js'

const credentialTypes = {
    basic: 1,
    x509: 2,
} as const

export type CredentialTypeName = keyof typeof credentialTypes
export type CredentialTypeValue = (typeof credentialTypes)[CredentialTypeName]

export const encodeCredentialType:Encoder<CredentialTypeName> = contramapEncoder(
    encodeUint16,
    openEnumNumberEncoder(credentialTypes),
)

export const decodeCredentialType:Decoder<CredentialTypeName> = mapDecoderOption(
    decodeUint16,
    openEnumNumberToKey(credentialTypes),
)
