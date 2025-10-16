import { encodeUint64, decodeUint64 } from './codec/number.js'
import type { Encoder } from './codec/tlsEncoder.js'
import { contramapEncoders } from './codec/tlsEncoder.js'
import type { Decoder } from './codec/tlsDecoder.js'
import { mapDecoders } from './codec/tlsDecoder.js'

export interface Lifetime {
  notBefore: bigint
  notAfter: bigint
}

export const encodeLifetime: Encoder<Lifetime> = contramapEncoders(
    [encodeUint64, encodeUint64],
    (lt) => [lt.notBefore, lt.notAfter] as const,
)

export const decodeLifetime: Decoder<Lifetime> = mapDecoders([decodeUint64, decodeUint64], (notBefore, notAfter) => ({
    notBefore,
    notAfter,
}))

export const defaultLifetime: Lifetime = {
    notBefore: 0n,
    notAfter: 9223372036854775807n,
}
