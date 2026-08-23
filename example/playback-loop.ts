import { bytesToPcm, chunkStartSeconds } from './attachment-audio.js'

/**
 * How far ahead of the audio clock the first chunk is scheduled. Enough
 * slack that decrypting the second chunk does not race the first one's
 * start time.
 */
export const LEAD_SECONDS = 0.3

/** The part of an AudioContext the playback loop needs. */
export interface ChunkScheduler {
    /** The audio clock, in seconds. */
    now ():number
    /** Play `pcm` starting at `at` seconds on that clock. */
    schedule (pcm:Float32Array, at:number):void
}

export interface PlaybackHooks {
    /** True once the caller has stopped playback. */
    cancelled ():boolean
    /** Plaintext bytes read so far, relative to the start offset. */
    progress (bytesRead:number):void
}

export type PlaybackOutcome = 'done'|'cancelled'

/**
 * Pull a decrypted plaintext stream to its end, scheduling each chunk
 * for playback as it arrives.
 *
 * The returned promise settles only once the reader is done or the
 * caller has cancelled, so a caller can hold key material live for the
 * whole read and wipe it in a finally. A stream error rejects rather
 * than being swallowed, so the caller can clear its playing state and
 * surface the failure.
 *
 * @param reader Reader over the decrypted plaintext.
 * @param scheduler Sink for the decoded PCM.
 * @param startOffset Plaintext offset the stream begins at, so a seeked
 * read still lays its chunks out from the lead time.
 * @param hooks Cancellation check and progress reporting.
 */
export async function schedulePlayback (
    reader:ReadableStreamDefaultReader<Uint8Array>,
    scheduler:ChunkScheduler,
    startOffset:number,
    hooks:PlaybackHooks
):Promise<PlaybackOutcome> {
    let baseTime:number|null = null
    let byteOffset = startOffset

    for (;;) {
        const { done, value } = await reader.read()

        // Check cancellation before handling done, so a stopped loop
        // does not report completion.
        if (hooks.cancelled()) return 'cancelled'
        if (done) return 'done'

        // Capture baseTime when the FIRST chunk arrives, not before.
        if (baseTime === null) baseTime = scheduler.now() + LEAD_SECONDS

        scheduler.schedule(
            bytesToPcm(value),
            baseTime + chunkStartSeconds(byteOffset - startOffset)
        )

        byteOffset += value.byteLength
        hooks.progress(byteOffset - startOffset)
    }
}
