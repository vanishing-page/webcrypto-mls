import { AttachmentError } from '../src/attachment/error.js'

export const SAMPLE_RATE = 16000

/**
 * A synthesized "voice note": a slow sine sweep with a gentle
 * tremolo so progress is audible. Length in seconds.
 */
export function makeTonePcm (seconds:number):Float32Array {
    const n = Math.floor(seconds * SAMPLE_RATE)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE
        const freq = 220 + (110 * Math.sin(t * 0.5))
        const tremolo = 0.75 + (0.25 * Math.sin(t * 3))
        out[i] = 0.25 * tremolo * Math.sin(2 * Math.PI * freq * t)
    }
    return out
}

/** Reinterpret decrypted plaintext bytes as PCM samples. */
export function bytesToPcm (bytes:Uint8Array):Float32Array {
    // A plaintext chunk that is not a whole number of samples is not
    // the audio the reference described, so it fails the same way any
    // other mismatch between an object and its reference does.
    if (bytes.byteLength % 4 !== 0) {
        throw new AttachmentError()
    }
    const copy = bytes.slice()
    // Note: this reinterprets in host byte order. Safe here since seal
    // and open happen in the same browser, but in cross-device pipelines
    // bytes should be normalized to a known byte order (e.g. little-endian)
    // before reinterpreting.
    return new Float32Array(
        copy.buffer, copy.byteOffset, copy.byteLength / 4,
    )
}

/** Start time in seconds for the chunk beginning at byteOffset. */
export function chunkStartSeconds (byteOffset:number):number {
    return (byteOffset / 4) / SAMPLE_RATE
}
