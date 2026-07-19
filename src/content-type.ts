import { decodeUint8, encodeUint8 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder } from './codec/tls-encoder.js'
import { enumNumberToKey } from './util/enum-helpers.js'

const contentTypes = {
    application: 1,
    proposal: 2,
    commit: 3,
} as const

export type ContentTypeName = keyof typeof contentTypes
export type ContentTypeValue = (typeof contentTypes)[ContentTypeName]

export const encodeContentType:Encoder<ContentTypeName> = contramapEncoder(encodeUint8, (t) => contentTypes[t])

export const decodeContentType:Decoder<ContentTypeName> = mapDecoderOption(decodeUint8, enumNumberToKey(contentTypes))
