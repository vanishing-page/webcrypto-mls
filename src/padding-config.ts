/**
 * How much padding to add to a `PrivateMessage` before it is encrypted.
 *
 * Padding is the only length-hiding mechanism MLS offers, and it is a weak
 * one. Neither mode hides *anything* other than length: the epoch, the
 * content type, the sender data nonce, and the fact that a message was
 * sent at all travel in the clear, so message timing and rate are always
 * observable.
 *
 * `padUntilLength` pads the encoded content up to a floor. Every message
 * whose encoding is shorter than the floor comes out at exactly the floor,
 * so all of them look alike; a message at or above the floor is not padded
 * at all, so its length is visible to a passive observer up to a constant
 * framing overhead. It hides length only *below* the threshold.
 *
 * `alwaysPad` adds a fixed number of bytes to every message regardless of
 * content. The ciphertext length stays an exact affine function of the
 * plaintext length, so an observer subtracts the constant and recovers the
 * original length: it hides no length information whatsoever. It is a way
 * to buy a fixed overhead, not a privacy control. If you want lengths
 * hidden, use `padUntilLength` with a floor above your typical message.
 */
export type PaddingConfig =
  | { kind:'padUntilLength'; padUntilLength:number }
  | { kind:'alwaysPad'; paddingLength:number }

/**
 * Pad every message shorter than 256 bytes out to 256 bytes.
 *
 * So messages under 256 bytes are mutually indistinguishable by length,
 * and messages of 256 bytes or more leak their length as usual. Raise the
 * floor if your application's messages are typically longer than that; the
 * cost is a constant per-message overhead paid by every short message.
 */
export const defaultPaddingConfig:PaddingConfig = {
    kind: 'padUntilLength',
    padUntilLength: 256
}

/**
 * The number of zero bytes to append to an encoding of `encodedLength`
 * bytes. For `alwaysPad` this is `paddingLength`, always, whatever the
 * input length. For `padUntilLength` it is whatever brings the message up
 * to the floor, and zero once the message reaches it.
 */
export function byteLengthToPad (
    encodedLength:number,
    config:PaddingConfig
):number {
    if (config.kind === 'alwaysPad') return config.paddingLength
    return encodedLength >= config.padUntilLength ?
        0 :
        config.padUntilLength - encodedLength
}
