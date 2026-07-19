import { encodeUint64, decodeUint64 } from './codec/number.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'

export interface Lifetime {
    notBefore:bigint
    notAfter:bigint
}

export const encodeLifetime:Encoder<Lifetime> = contramapEncoders(
    [encodeUint64, encodeUint64],
    (lt) => [lt.notBefore, lt.notAfter] as const,
)

export const decodeLifetime:Decoder<Lifetime> = mapDecoders([decodeUint64, decodeUint64], (notBefore, notAfter) => ({
    notBefore,
    notAfter,
}))

export const defaultLifetime:Lifetime = {
    notBefore: BigInt(Math.floor(Date.now() / 1000)) - 3600n,
    notAfter: BigInt(Math.floor(Date.now() / 1000)) + 2592000n, // 30 days
}
