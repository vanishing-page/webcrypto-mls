import type { Decoder } from './codec/tls-decoder.js'
import { mapDecodersOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, encodeVarLenData } from './codec/variable-length.js'
import type { Hash } from './crypto/hash.js'
import type { FramedContentCommit } from './framed-content.js'
import { decodeFramedContent, encodeFramedContent } from './framed-content.js'
import { concatUint8Arrays } from './util/byte-array.js'
import type { WireformatName } from './wireformat.js'
import { decodeWireformat, encodeWireformat } from './wireformat.js'

export interface ConfirmedTranscriptHashInput {
    wireformat:WireformatName
    content:FramedContentCommit
    signature:Uint8Array
}

export const encodeConfirmedTranscriptHashInput:Encoder<ConfirmedTranscriptHashInput> = contramapEncoders(
    [encodeWireformat, encodeFramedContent, encodeVarLenData],
    (input) => [input.wireformat, input.content, input.signature] as const,
)

export const decodeConfirmedTranscriptHashInput:Decoder<ConfirmedTranscriptHashInput> = mapDecodersOption(
    [decodeWireformat, decodeFramedContent, decodeVarLenData],
    (wireformat, content, signature) => {
        if (content.contentType === 'commit') {
            return {
                wireformat,
                content,
                signature,
            }
        } else return undefined
    },
)

export function createConfirmedHash (
    interimTranscriptHash:Uint8Array,
    input:ConfirmedTranscriptHashInput,
    hash:Hash,
):Promise<Uint8Array> {
    return hash.digest(concatUint8Arrays(interimTranscriptHash, encodeConfirmedTranscriptHashInput(input)))
}

export function createInterimHash (
    confirmedHash:Uint8Array,
    confirmationTag:Uint8Array,
    hash:Hash,
):Promise<Uint8Array> {
    return hash.digest(concatUint8Arrays(confirmedHash, encodeVarLenData(confirmationTag)))
}
