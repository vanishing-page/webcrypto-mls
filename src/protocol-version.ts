import { decodeUint16, encodeUint16 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import {
    enumNumberToKey,
    openEnumNumberEncoder,
    openEnumNumberToKey
} from './util/enum-helpers.js'

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

/**
 * A protocol version as advertised in a leaf's `Capabilities`. Unlike
 * the version field of an MLSMessage, KeyPackage or GroupContext, this
 * list is open: a peer may advertise a version this package does not
 * know, carried as its decimal code point (`'2'`), so that it decodes
 * and re-encodes to the same bytes.
 */
export type CapabilityProtocolVersion = ProtocolVersionName | `${number}`

const openProtocolVersions:Record<CapabilityProtocolVersion, number> =
    protocolVersions

export const encodeCapabilityProtocolVersion:
    Encoder<CapabilityProtocolVersion> = contramapEncoder(
        encodeUint16,
        openEnumNumberEncoder(openProtocolVersions),
    )

export const decodeCapabilityProtocolVersion:
    Decoder<CapabilityProtocolVersion> = mapDecoderOption(
        decodeUint16,
        openEnumNumberToKey(openProtocolVersions),
    )
