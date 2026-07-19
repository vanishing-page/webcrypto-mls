import { decodeUint16, encodeUint16 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { enumNumberToKey } from './util/enum-helpers.js'

export const wireformats = {
    mls_public_message: 1,
    mls_private_message: 2,
    mls_welcome: 3,
    mls_group_info: 4,
    mls_key_package: 5,
} as const

export type WireformatName = keyof typeof wireformats
export type WireformatValue = (typeof wireformats)[WireformatName]

export const encodeWireformat:Encoder<WireformatName> = (s) =>
    contramapEncoder(encodeUint16, (t:WireformatName) => wireformats[t])(s)

export const decodeWireformat:Decoder<WireformatName> = mapDecoderOption(decodeUint16, enumNumberToKey(wireformats))
