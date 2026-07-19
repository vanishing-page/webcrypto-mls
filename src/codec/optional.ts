import { concatUint8Arrays } from '../util/byte-array.js'
import { decodeUint8, encodeUint8 } from './number.js'
import type { Decoder } from './tls-decoder.js'
import type { Encoder } from './tls-encoder.js'

export function encodeOptional<T> (encodeT:Encoder<T>):Encoder<T | undefined> {
    return (t) => (t !== undefined ? prependPresenceOctet(encodeT(t)) : new Uint8Array([0x0]))
}

export function decodeOptional<T> (decodeT:Decoder<T>):Decoder<T | undefined> {
    return (b, offset) => {
        const presence = decodeUint8(b, offset)
        if (presence === undefined) return undefined
        const presenceOctet = presence[0]
        if (presenceOctet === 1) {
            const result = decodeT(b, offset + 1)
            return result === undefined ? undefined : [result[0], result[1] + 1]
        } else if (presenceOctet === 0) {
            return [undefined, 1]
        } else {
            return undefined
        }
    }
}

function prependPresenceOctet (v:Uint8Array):Uint8Array {
    return concatUint8Arrays(encodeUint8(0x1), v)
}
