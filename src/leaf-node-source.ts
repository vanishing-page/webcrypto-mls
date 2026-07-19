import { decodeUint8, encodeUint8 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { enumNumberToKey } from './util/enum-helpers.js'

const leafNodeSources = {
    key_package: 1,
    update: 2,
    commit: 3,
} as const

export type LeafNodeSourceName = keyof typeof leafNodeSources
export type LeafNodeSourceValue = (typeof leafNodeSources)[LeafNodeSourceName]

export const encodeLeafNodeSource:Encoder<LeafNodeSourceName> = contramapEncoder(
    encodeUint8,
    (t) => leafNodeSources[t],
)

export const decodeLeafNodeSource:Decoder<LeafNodeSourceName> = mapDecoderOption(
    decodeUint8,
    enumNumberToKey(leafNodeSources),
)
