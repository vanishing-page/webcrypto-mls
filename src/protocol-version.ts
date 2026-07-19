import { decodeUint16, encodeUint16 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { enumNumberToKey } from './util/enum-helpers.js'

export const protocolVersions = {
    mls10: 1,
} as const

export type ProtocolVersionName = keyof typeof protocolVersions
export type ProtocolVersionValue = (typeof protocolVersions)[ProtocolVersionName]

export const encodeProtocolVersion:Encoder<ProtocolVersionName> = contramapEncoder(
    encodeUint16,
    (t) => protocolVersions[t],
)

export const decodeProtocolVersion:Decoder<ProtocolVersionName> = mapDecoderOption(
    decodeUint16,
    enumNumberToKey(protocolVersions),
)
