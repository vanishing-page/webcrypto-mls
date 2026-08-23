import { batch, useComputed, useSignal } from '@preact/signals'
import { type FunctionComponent } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { html } from 'htm/preact'
import { makeTonePcm, SAMPLE_RATE } from './attachment-audio.js'
import { schedulePlayback } from './playback-loop.js'
import { createDemoGroup } from './attachment-group.js'
import {
    errorStatus,
    formatRanges,
    releasePlayback,
    seekWindow,
    sliceRanges
} from './attachment-plan.js'
import { encryptAttachmentForGroup } from '../src/attachment/writer.js'
import {
    decryptAttachmentStreamForGroup
} from '../src/attachment/reader.js'
import { openAttachmentRangeForGroup } from '../src/attachment/range.js'
import { SEGMENT_MAX } from '../src/attachment/schedule.js'
import { getCipherSuite } from '../src/crypto/get-ciphersuite-impl.js'
import type { AttachmentRef } from '../src/attachment/reference.js'
import type { CiphersuiteImpl } from '../src/crypto/ciphersuite.js'
import type { ClientState } from '../src/index.js'

const CHUNK_SIZE_BYTES = 65536
const SEEK_TO_SECONDS = 8
const THROTTLE_DELAY_MS = 250

interface AttachmentDemoRefs {
    cipherSuite:CiphersuiteImpl | null
    group:ClientState | null
    encBytes:Uint8Array | null
    encRef:AttachmentRef | null
    audioContext:AudioContext | null
    streamReader:ReadableStreamDefaultReader<Uint8Array> | null
    cancelled:boolean
}

export const AttachmentsDemo:FunctionComponent = function () {
    const status = useSignal<string>('Ready')
    const segmentsTotal = useSignal<number>(0)
    const segmentsDone = useSignal<number>(0)
    const playing = useSignal<boolean>(false)

    const refs = useRef<AttachmentDemoRefs>({
        cipherSuite: null,
        group: null,
        encBytes: null,
        encRef: null,
        audioContext: null,
        streamReader: null,
        cancelled: false
    }).current

    // Initialize the ciphersuite and the group once
    useEffect(() => {
        async function init ():Promise<void> {
            const cs = await getCipherSuite()
            refs.cipherSuite = cs

            // A real MLS group, so every call below takes the same
            // `state.keySchedule` an application already holds after
            // createGroup or joinGroup. The attachment key is scoped to
            // that group's current epoch; nothing here invents one.
            refs.group = await createDemoGroup(cs)
        }

        init().catch(err => {
            status.value = errorStatus(err)
        })
    }, [])

    async function handleGenerate ():Promise<void> {
        if (!refs.cipherSuite || !refs.group) {
            status.value = 'Error: Ciphersuite not initialized'
            return
        }

        try {
            status.value = 'Generating attachment...'

            // Generate PCM audio (12 seconds = ~768 KiB)
            const pcm = makeTonePcm(12)
            const plaintext = new Uint8Array(pcm.buffer.slice(0))

            // Generate random objectId
            const objectId = new Uint8Array(16)
            globalThis.crypto.getRandomValues(objectId)

            // Encrypt. The wrapper derives the CEK from the group's
            // current epoch and wipes it before it returns, so the demo
            // never holds raw key material.
            const enc = await encryptAttachmentForGroup(
                refs.group.keySchedule,
                objectId,
                plaintext,
                refs.cipherSuite
            )

            // Store results
            refs.encBytes = enc.bytes
            refs.encRef = enc.reference

            // Calculate total segments
            const nSegs = Math.ceil(plaintext.length / SEGMENT_MAX)
            batch(() => {
                segmentsTotal.value = nSegs
                segmentsDone.value = 0
                status.value = 'Attachment generated'
            })
        } catch (err) {
            status.value = errorStatus(err)
        }
    }

    function throttledStream (
        bytes:Uint8Array
    ):ReadableStream<Uint8Array> {
        let streamCancelled = false
        return new ReadableStream<Uint8Array>({
            async start (controller) {
                for (let i = 0; i < bytes.length; i += CHUNK_SIZE_BYTES) {
                    if (streamCancelled) {
                        controller.close()
                        return
                    }
                    const chunk = bytes.slice(
                        i,
                        Math.min(i + CHUNK_SIZE_BYTES, bytes.length)
                    )
                    controller.enqueue(chunk)
                    // Throttle chunk delivery
                    await new Promise(resolve =>
                        setTimeout(resolve, THROTTLE_DELAY_MS)
                    )
                }
                controller.close()
            },
            cancel () {
                streamCancelled = true
            }
        })
    }

    async function scheduleFrom (
        ctx:AudioContext,
        reader:ReadableStreamDefaultReader<Uint8Array>,
        startOffset:number,
        doneMessage:string
    ):Promise<void> {
        const outcome = await schedulePlayback(reader, {
            now: () => ctx.currentTime,
            schedule (pcm, at) {
                const audioBuffer = ctx.createBuffer(
                    1,
                    pcm.length,
                    SAMPLE_RATE
                )
                audioBuffer.getChannelData(0).set(pcm)
                const source = ctx.createBufferSource()
                source.buffer = audioBuffer
                source.connect(ctx.destination)
                source.start(at)
            }
        }, startOffset, {
            cancelled: () => refs.cancelled,
            progress: bytesRead => {
                segmentsDone.value = Math.ceil(bytesRead / SEGMENT_MAX)
            }
        })

        if (outcome === 'cancelled') return

        batch(() => {
            status.value = doneMessage
            playing.value = false
        })
    }

    async function handlePlay ():Promise<void> {
        if (!refs.encBytes || !refs.encRef || !refs.cipherSuite ||
            !refs.group) {
            status.value = 'Error: No attachment generated'
            return
        }

        try {
            batch(() => {
                status.value = 'Playing...'
                playing.value = true
            })
            refs.cancelled = false

            // Create throttled stream and decrypt it. The reference
            // arrives in an authenticated MLS message, covered by the
            // sender's signature; the wrapper derives the CEK from the
            // objectId in that reference, and any other objectId derives
            // a key the commitment gate rejects.
            const throttled = throttledStream(refs.encBytes)
            const plainStream = await decryptAttachmentStreamForGroup(
                refs.group.keySchedule,
                refs.encRef,
                throttled,
                refs.cipherSuite
            )

            // The wrapper owns the derived CEK and zeroes it when the
            // stream ends, errors or is cancelled, so there is nothing
            // to wipe here. handleStop cancels the reader.
            refs.streamReader = plainStream.getReader()

            // Create AudioContext lazily on first gesture (fixes autoplay)
            if (!refs.audioContext) {
                refs.audioContext = new AudioContext()
            }

            const ctx = refs.audioContext
            await ctx.resume()

            await scheduleFrom(ctx, refs.streamReader, 0,
                'Playback complete')
        } catch (err) {
            // A stop cancels the reader, which can reject the pending
            // read. handleStop already owns the status in that case.
            if (refs.cancelled) return
            batch(() => {
                status.value = errorStatus(err)
                playing.value = false
            })
        }
    }

    async function handleSeek ():Promise<void> {
        if (!refs.encBytes || !refs.encRef || !refs.cipherSuite ||
            !refs.group) {
            status.value = 'Error: No attachment generated'
            return
        }

        try {
            // Stop any current playback
            if (playing.value) {
                await handleStop()
            }

            batch(() => {
                status.value = `Seeking to ${SEEK_TO_SECONDS}s...`
                playing.value = true
            })
            refs.cancelled = false

            // The window to read: from 8 seconds to the end.
            const seek = seekWindow(
                SEEK_TO_SECONDS,
                Number(refs.encRef.plaintextLength)
            )

            // Open range starting from 8 seconds. The reference is
            // delivered in an authenticated MLS message, covered by the
            // sender's signature; the wrapper derives the CEK from the
            // group's current epoch and owns it, so close() wipes it.
            const rangeResult = await openAttachmentRangeForGroup(
                refs.group.keySchedule,
                refs.encRef,
                seek,
                refs.cipherSuite
            )

            try {
                status.value = 'Seeking: fetched ranges ' +
                    formatRanges(rangeResult.ranges)

                // decrypt() takes one stream per range, in order, each
                // carrying exactly that range's bytes. The ranges are not
                // contiguous (header at 0, blocks far past it), so slice
                // individually; count must match or decrypt rejects.
                const rangeStreams = sliceRanges(
                    refs.encBytes!,
                    rangeResult.ranges
                ).map(throttledStream)

                const plainStream = rangeResult.decrypt(rangeStreams)
                refs.streamReader = plainStream.getReader()

                // Create AudioContext lazily on first gesture
                if (!refs.audioContext) {
                    refs.audioContext = new AudioContext()
                }

                const ctx = refs.audioContext
                await ctx.resume()

                await scheduleFrom(ctx, refs.streamReader, seek.offset,
                    'Seek playback complete')
            } finally {
                // Zeroize the CEK the read owns. Safe here because
                // scheduleFrom has already settled, so nothing still
                // needs the key.
                rangeResult.close()
            }
        } catch (err) {
            // A stop cancels the reader, which can reject the pending
            // read. handleStop already owns the status in that case.
            if (refs.cancelled) return
            batch(() => {
                status.value = errorStatus(err)
                playing.value = false
            })
        }
    }

    async function handleStop ():Promise<void> {
        refs.cancelled = true
        await releasePlayback(refs)
        batch(() => {
            playing.value = false
            segmentsDone.value = 0
            status.value = 'Stopped'
        })
    }

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            handleStop().catch(err => {
                console.error('Error during cleanup:', err)
            })
        }
    }, [])

    const canGenerate = useComputed(() => {
        return !playing.value
    })

    const canPlay = useComputed(() => {
        return segmentsTotal.value > 0 && !playing.value
    })

    const canSeek = useComputed(() => {
        return segmentsTotal.value > 0
    })

    const canStop = useComputed(() => {
        return playing.value
    })

    return html`
    <div class="container attachments">
        <h1>Attachments Demo</h1>

        <div class="card">
            <p>Encrypt and progressively decrypt an audio attachment</p>

            <div class="button-group">
                <button
                    onClick=${handleGenerate}
                    disabled=${!canGenerate.value}
                >
                    Generate
                </button>
                <button
                    onClick=${handlePlay}
                    disabled=${!canPlay.value}
                >
                    Play
                </button>
                <button
                    onClick=${handleSeek}
                    disabled=${!canSeek.value}
                >
                    Seek to 0:08
                </button>
                <button
                    onClick=${handleStop}
                    disabled=${!canStop.value}
                >
                    Stop
                </button>
            </div>

            <p class="status" aria-live="polite">
                ${status.value}
            </p>
            <p class="progress" aria-live="polite">
                ${`Decrypted ${segmentsDone.value} / ` +
                    `${segmentsTotal.value} segments`}
            </p>
        </div>
    </div>
    `
}
