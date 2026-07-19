import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { encodeVarLenData, decodeVarLenData } from './codec/variable-length.js'

export interface HPKECiphertext {
    kemOutput:Uint8Array
    ciphertext:Uint8Array
}

export const encodeHpkeCiphertext:Encoder<HPKECiphertext> = contramapEncoders(
    [encodeVarLenData, encodeVarLenData],
    (egs) => [egs.kemOutput, egs.ciphertext] as const,
)

export const decodeHpkeCiphertext:Decoder<HPKECiphertext> = mapDecoders(
    [decodeVarLenData, decodeVarLenData],
    (kemOutput, ciphertext) => ({ kemOutput, ciphertext }),
)
