import { decodeOptional, encodeOptional } from './codec/optional.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, decodeVarLenType, encodeVarLenData, encodeVarLenType } from './codec/variable-length.js'
import type { PreSharedKeyID } from './presharedkey.js'
import { decodePskId, encodePskId } from './presharedkey.js'

export interface GroupSecrets {
    joinerSecret:Uint8Array
    pathSecret:Uint8Array | undefined
    psks:PreSharedKeyID[]
}

export const encodeGroupSecrets:Encoder<GroupSecrets> = contramapEncoders(
    [encodeVarLenData, encodeOptional(encodeVarLenData), encodeVarLenType(encodePskId)],
    (gs) => [gs.joinerSecret, gs.pathSecret, gs.psks] as const,
)

export const decodeGroupSecrets:Decoder<GroupSecrets> = mapDecoders(
    [decodeVarLenData, decodeOptional(decodeVarLenData), decodeVarLenType(decodePskId)],
    (joinerSecret, pathSecret, psks) => ({ joinerSecret, pathSecret, psks }),
)
