import { decodeUint8, encodeUint8 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { enumNumberToKey } from './util/enum-helpers.js'

const nodeTypes = {
    leaf: 1,
    parent: 2,
} as const

export type NodeTypeName = keyof typeof nodeTypes
export type NodeTypeValue = (typeof nodeTypes)[NodeTypeName]

export const encodeNodeType:Encoder<NodeTypeName> = contramapEncoder(encodeUint8, (t) => nodeTypes[t])

export const decodeNodeType:Decoder<NodeTypeName> = mapDecoderOption(decodeUint8, enumNumberToKey(nodeTypes))
