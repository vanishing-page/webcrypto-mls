import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import {
    decodeVarLenData,
    decodeVarLenType,
    encodeVarLenData,
    encodeVarLenType,
} from './codec/variable-length.js'
import type { Credential } from './credential.js'
import { decodeCredential, encodeCredential } from './credential.js'

export interface ExternalSender {
    signaturePublicKey:Uint8Array
    credential:Credential
}

export const encodeExternalSender:Encoder<ExternalSender> = contramapEncoders(
    [encodeVarLenData, encodeCredential],
    (e) => [e.signaturePublicKey, e.credential] as const,
)

export const decodeExternalSender:Decoder<ExternalSender> = mapDecoders(
    [decodeVarLenData, decodeCredential],
    (signaturePublicKey, credential) => ({ signaturePublicKey, credential }),
)

// RFC 9420 section 12.1.8.2: the `external_senders` GroupContext extension
// carries a single `ExternalSendersExtension`, whose `external_senders`
// field is a variable-length vector of `ExternalSender` entries.
// `SenderIndex` indexes into that vector, not into the list of extensions.
export const encodeExternalSenders:Encoder<ExternalSender[]> =
    encodeVarLenType(encodeExternalSender)

export const decodeExternalSenders:Decoder<ExternalSender[]> =
    decodeVarLenType(decodeExternalSender)
