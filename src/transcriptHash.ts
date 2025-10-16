import type { Decoder } from './codec/tlsDecoder.js'
import { mapDecodersOption } from './codec/tlsDecoder.js'
import type { Encoder } from './codec/tlsEncoder.js'
import { contramapEncoders } from './codec/tlsEncoder.js'
import { decodeVarLenData, encodeVarLenData } from './codec/variableLength.js'
import type { Hash } from './crypto/hash.js'
import type { FramedContentCommit } from './framedContent.js'
import { decodeFramedContent, encodeFramedContent } from './framedContent.js'
import { concatUint8Arrays } from './util/byteArray.js'
import type { WireformatName } from './wireformat.js'
import { decodeWireformat, encodeWireformat } from './wireformat.js'

export interface ConfirmedTranscriptHashInput {
  wireformat: WireformatName
  content: FramedContentCommit
  signature: Uint8Array
}

export const encodeConfirmedTranscriptHashInput: Encoder<ConfirmedTranscriptHashInput> = contramapEncoders(
    [encodeWireformat, encodeFramedContent, encodeVarLenData],
    (input) => [input.wireformat, input.content, input.signature] as const,
)

export const decodeConfirmedTranscriptHashInput: Decoder<ConfirmedTranscriptHashInput> = mapDecodersOption(
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
    interimTranscriptHash: Uint8Array,
    input: ConfirmedTranscriptHashInput,
    hash: Hash,
): Promise<Uint8Array> {
    return hash.digest(concatUint8Arrays(interimTranscriptHash, encodeConfirmedTranscriptHashInput(input)))
}

export function createInterimHash (
    confirmedHash: Uint8Array,
    confirmationTag: Uint8Array,
    hash: Hash,
): Promise<Uint8Array> {
    return hash.digest(concatUint8Arrays(confirmedHash, encodeVarLenData(confirmationTag)))
}
