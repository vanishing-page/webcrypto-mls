import { decodeUint16, encodeUint16 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { enumNumberToKey } from './util/enum-helpers.js'

export const defaultExtensionTypes = {
    application_id: 1,
    ratchet_tree: 2,
    required_capabilities: 3,
    external_pub: 4,
    external_senders: 5,
} as const

export type DefaultExtensionTypeName = keyof typeof defaultExtensionTypes
export type DefaultExtensionTypeValue = (typeof defaultExtensionTypes)[DefaultExtensionTypeName]

export const encodeDefaultExtensionType:Encoder<DefaultExtensionTypeName> = contramapEncoder(
    encodeUint16,
    (n) => defaultExtensionTypes[n],
)

export const decodeDefaultExtensionType:Decoder<DefaultExtensionTypeName> = mapDecoderOption(
    decodeUint16,
    enumNumberToKey(defaultExtensionTypes),
)
