// pattern: Imperative Shell

import {
    batch,
    computed,
    signal,
    type ReadonlySignal,
    type Signal
} from '@preact/signals'
import { makeTonePcm, SAMPLE_RATE } from './attachment-audio.js'
import {
    attachmentScope,
    errorStatus,
    formatRanges,
    releasePlayback,
    sameAttachmentScope,
    seekWindow,
    sliceRanges,
    type AttachmentScope
} from './attachment-plan.js'
import {
    schedulePlayback,
    type ChunkScheduler,
    type PlaybackHooks,
    type PlaybackOutcome
} from './playback-loop.js'
import {
    encryptAttachmentForGroup,
    type EncryptedAttachment
} from '../src/attachment/writer.js'
import {
    decryptAttachmentStreamForGroup
} from '../src/attachment/reader.js'
import {
    openAttachmentRangeForGroup,
    type AttachmentRangeRead
} from '../src/attachment/range.js'
import { SEGMENT_MAX } from '../src/attachment/schedule.js'
import type { AttachmentRef } from '../src/attachment/reference.js'
import type { CiphersuiteImpl, ClientState } from '../src/index.js'

export const ATTACHMENT_SECONDS = 12
export const CHUNK_SIZE_BYTES = 65536
export const SEEK_TO_SECONDS = 8
export const THROTTLE_DELAY_MS = 250

export type AttachmentPhase = 'idle'|'generating'|'playing'|'seeking'

export type AttachmentGroup = Pick<ClientState,
    'groupContext'|'keySchedule'>

type AttachmentReadStream = {
    getReader:() => ReadableStreamDefaultReader<Uint8Array>
    cancel?:(reason?:unknown) => Promise<unknown>
}

export type AttachmentAudioBuffer = {
    getChannelData:(channel:number) => Float32Array
}

export type AttachmentAudioSource = {
    buffer:AttachmentAudioBuffer|null
    connect:(destination:unknown) => void
    start:(at:number) => void
}

export type AttachmentAudioContext = {
    readonly currentTime:number
    readonly destination:unknown
    createBuffer:(
        channels:number,
        length:number,
        sampleRate:number
    ) => AttachmentAudioBuffer
    createBufferSource:() => AttachmentAudioSource
    resume:() => Promise<void>
    close:() => Promise<void>
}

export type AttachmentContext = {
    readonly cipherSuite:CiphersuiteImpl|null
    readonly group:AttachmentGroup|null
}

export type AttachmentSignals = {
    readonly status:Signal<string>
    readonly segmentsTotal:Signal<number>
    readonly segmentsDone:Signal<number>
    readonly phase:Signal<AttachmentPhase>
    readonly cipherSuite:Signal<CiphersuiteImpl|null>
    readonly group:Signal<AttachmentGroup|null>
    readonly scope:Signal<AttachmentScope|null>
    readonly hasAttachment:Signal<boolean>
}

export type AttachmentStateOptions = {
    readonly getCipherSuite?:() => Promise<CiphersuiteImpl>
    readonly createGroup?:(
        cipherSuite:CiphersuiteImpl
    ) => Promise<AttachmentGroup>
    readonly makeTonePcm?:(seconds:number) => Float32Array
    readonly getRandomValues?:(bytes:Uint8Array) => Uint8Array
    readonly encrypt?:(
        keySchedule:AttachmentGroup['keySchedule'],
        objectId:Uint8Array,
        plaintext:Uint8Array,
        cipherSuite:CiphersuiteImpl
    ) => Promise<EncryptedAttachment>
    readonly decryptStream?:(
        keySchedule:AttachmentGroup['keySchedule'],
        ref:AttachmentRef,
        ciphertext:ReadableStream<Uint8Array>,
        cipherSuite:CiphersuiteImpl
    ) => Promise<AttachmentReadStream>
    readonly openRange?:(
        keySchedule:AttachmentGroup['keySchedule'],
        ref:AttachmentRef,
        range:{ offset:number, length:number },
        cipherSuite:CiphersuiteImpl
    ) => Promise<AttachmentRangeRead>
    readonly streamFromBytes?:(bytes:Uint8Array) => ReadableStream<Uint8Array>
    readonly createAudioContext?:() => AttachmentAudioContext
    readonly playback?:(
        reader:ReadableStreamDefaultReader<Uint8Array>,
        scheduler:ChunkScheduler,
        startOffset:number,
        hooks:PlaybackHooks
    ) => Promise<PlaybackOutcome>
    readonly signals?:AttachmentSignals
}

export type AttachmentState = {
    readonly status:Signal<string>
    readonly segmentsTotal:Signal<number>
    readonly segmentsDone:Signal<number>
    readonly phase:Signal<AttachmentPhase>
    readonly cipherSuite:Signal<CiphersuiteImpl|null>
    readonly group:Signal<AttachmentGroup|null>
    readonly scope:Signal<AttachmentScope|null>
    readonly hasAttachment:Signal<boolean>
    readonly playing:ReadonlySignal<boolean>
    readonly canGenerate:ReadonlySignal<boolean>
    readonly canPlay:ReadonlySignal<boolean>
    readonly canSeek:ReadonlySignal<boolean>
    readonly canStop:ReadonlySignal<boolean>
    setup:() => Promise<void>
    setContext:(context:AttachmentContext) => Promise<void>
    resetScope:(group:AttachmentGroup|null) => Promise<void>
    generate:() => Promise<void>
    play:() => Promise<void>
    seek:() => Promise<void>
    stop:() => Promise<void>
    cleanup:() => Promise<void>
}

type GeneratedAttachment = {
    readonly bytes:Uint8Array
    readonly ref:AttachmentRef
    readonly scope:AttachmentScope
}

type PlaybackSlot = {
    readonly token:number
    streamReader:ReadableStreamDefaultReader<Uint8Array>|null
    audioContext:AttachmentAudioContext|null
}

type ActiveAttachment = {
    readonly token:number
    readonly scope:AttachmentScope
    readonly group:AttachmentGroup
    readonly cipherSuite:CiphersuiteImpl
    readonly bytes:Uint8Array
    readonly ref:AttachmentRef
}

export function createAttachmentState (
    options:AttachmentStateOptions = {}
):AttachmentState {
    const getCs = options.getCipherSuite
    const makeGroup = options.createGroup
    const makePcm = options.makeTonePcm ?? makeTonePcm
    const randomValues = options.getRandomValues ??
        ((bytes:Uint8Array) => globalThis.crypto.getRandomValues(bytes))
    const encrypt = options.encrypt ?? encryptAttachmentForGroup
    const decryptStream = options.decryptStream ??
        decryptAttachmentStreamForGroup
    const openRange = options.openRange ?? openAttachmentRangeForGroup
    const streamFromBytes = options.streamFromBytes ?? throttledStream
    const makeAudioContext = options.createAudioContext ??
        (() => new AudioContext() as AttachmentAudioContext)
    const playback = options.playback ?? schedulePlayback

    const ownedSignals = options.signals
    const status = ownedSignals?.status ?? signal<string>('Ready')
    const segmentsTotal = ownedSignals?.segmentsTotal ?? signal<number>(0)
    const segmentsDone = ownedSignals?.segmentsDone ?? signal<number>(0)
    const phase = ownedSignals?.phase ?? signal<AttachmentPhase>('idle')
    const cipherSuite = ownedSignals?.cipherSuite ??
        signal<CiphersuiteImpl|null>(null)
    const group = ownedSignals?.group ?? signal<AttachmentGroup|null>(null)
    const scope = ownedSignals?.scope ?? signal<AttachmentScope|null>(null)
    const hasAttachment = ownedSignals?.hasAttachment ??
        signal<boolean>(false)
    const resetting = signal<boolean>(false)

    let currentToken = 0
    let generated:GeneratedAttachment|null = null
    let playbackSlot:PlaybackSlot|null = null

    const playing = computed(() => {
        return phase.value === 'playing' || phase.value === 'seeking'
    })
    const canGenerate = computed(() => {
        return phase.value === 'idle' &&
            !resetting.value &&
            cipherSuite.value !== null &&
            group.value !== null
    })
    const canPlay = computed(() => {
        return phase.value === 'idle' &&
            !resetting.value &&
            currentAttachment() !== null
    })
    const canSeek = computed(() => {
        return phase.value === 'idle' &&
            !resetting.value &&
            currentAttachment() !== null
    })
    const canStop = computed(() => {
        return phase.value === 'playing' || phase.value === 'seeking'
    })

    async function setup ():Promise<void> {
        if (!getCs || !makeGroup) return
        const token = invalidate()
        try {
            const cs = await getCs()
            if (token !== currentToken) return
            const newGroup = await makeGroup(cs)
            if (token !== currentToken) return
            await setContext({ cipherSuite: cs, group: newGroup })
        } catch (err) {
            if (token !== currentToken) return
            status.value = errorStatus(err)
        }
    }

    async function setContext (
        context:AttachmentContext
    ):Promise<void> {
        const nextScope = scopeForGroup(context.group)
        const sameScope = sameAttachmentScope(scope.value, nextScope)

        if (sameScope) {
            batch(() => {
                cipherSuite.value = context.cipherSuite
                group.value = context.group
                scope.value = nextScope
            })
            return
        }

        const token = invalidate()
        resetting.value = true
        await releasePlaybackToken(null)
        if (token !== currentToken) return
        generated = null
        batch(() => {
            cipherSuite.value = context.cipherSuite
            group.value = context.group
            scope.value = nextScope
            hasAttachment.value = false
            segmentsTotal.value = 0
            segmentsDone.value = 0
            phase.value = 'idle'
            status.value = nextScope ?
                'Ready' :
                'create a group to generate an attachment'
            resetting.value = false
        })
    }

    async function resetScope (
        nextGroup:AttachmentGroup|null
    ):Promise<void> {
        await setContext({
            cipherSuite: cipherSuite.value,
            group: nextGroup
        })
    }

    async function generate ():Promise<void> {
        if (phase.value !== 'idle' || resetting.value) return

        const cs = cipherSuite.value
        const currentGroup = group.value
        const currentScope = scopeForGroup(currentGroup)
        if (!cs || !currentGroup || !currentScope) {
            status.value = 'Error: Ciphersuite not initialized'
            return
        }

        const token = invalidate()
        generated = null
        batch(() => {
            phase.value = 'generating'
            status.value = 'Generating attachment...'
            hasAttachment.value = false
            segmentsTotal.value = 0
            segmentsDone.value = 0
        })

        try {
            const pcm = makePcm(ATTACHMENT_SECONDS)
            const plaintext = new Uint8Array(pcm.buffer.slice(0))
            const objectId = new Uint8Array(16)
            randomValues(objectId)

            const encrypted = await encrypt(
                currentGroup.keySchedule,
                objectId,
                plaintext,
                cs
            )
            if (!isCurrent(token, currentScope)) return

            generated = {
                bytes: encrypted.bytes,
                ref: encrypted.reference,
                scope: currentScope
            }
            batch(() => {
                segmentsTotal.value = Math.ceil(
                    plaintext.length / SEGMENT_MAX
                )
                segmentsDone.value = 0
                hasAttachment.value = true
                phase.value = 'idle'
                status.value = 'Attachment generated'
            })
        } catch (err) {
            if (!isCurrent(token, currentScope)) return
            batch(() => {
                phase.value = 'idle'
                status.value = errorStatus(err)
            })
        }
    }

    async function play ():Promise<void> {
        const active = beginPlayback('playing', 'Playing...')
        if (!active) return

        let plainStream:AttachmentReadStream|null = null
        let localReader:ReadableStreamDefaultReader<Uint8Array>|null = null
        try {
            plainStream = await decryptStream(
                active.group.keySchedule,
                active.ref,
                streamFromBytes(active.bytes),
                active.cipherSuite
            )
            if (!isCurrent(active.token, active.scope)) {
                await cancelPlainStream(plainStream)
                return
            }

            localReader = plainStream.getReader()
            await runPlayback(active, localReader, 0,
                'Playback complete')
        } catch (err) {
            if (!localReader && plainStream) {
                await cancelPlainStream(plainStream)
            }
            await handlePlaybackError(active, localReader, err)
        }
    }

    async function seek ():Promise<void> {
        const active = beginPlayback(
            'seeking',
            `Seeking to ${SEEK_TO_SECONDS}s...`
        )
        if (!active) return

        let read:AttachmentRangeRead|null = null
        let readClosed = false
        let localReader:ReadableStreamDefaultReader<Uint8Array>|null = null

        const closeRead = () => {
            if (!readClosed && read) {
                readClosed = true
                read.close()
            }
        }

        try {
            const window = seekWindow(
                SEEK_TO_SECONDS,
                Number(active.ref.plaintextLength)
            )
            read = await openRange(
                active.group.keySchedule,
                active.ref,
                window,
                active.cipherSuite
            )
            if (!isCurrent(active.token, active.scope)) {
                closeRead()
                return
            }

            status.value = 'Seeking: fetched ranges ' +
                formatRanges(read.ranges)
            const rangeStreams = sliceRanges(active.bytes, read.ranges)
                .map(streamFromBytes)
            const plainStream = read.decrypt(rangeStreams)
            localReader = plainStream.getReader()
            await runPlayback(active, localReader, window.offset,
                'Seek playback complete')
        } catch (err) {
            await handlePlaybackError(active, localReader, err)
        } finally {
            closeRead()
        }
    }

    async function stop ():Promise<void> {
        if (!canStop.value) return
        const token = currentToken
        invalidate()
        await releasePlaybackToken(token)
        batch(() => {
            phase.value = 'idle'
            segmentsDone.value = 0
            status.value = 'Stopped'
        })
    }

    async function cleanup ():Promise<void> {
        invalidate()
        await releasePlaybackToken(null)
        batch(() => {
            phase.value = 'idle'
            segmentsDone.value = 0
        })
    }

    function beginPlayback (
        nextPhase:'playing'|'seeking',
        nextStatus:string
    ):ActiveAttachment|null {
        if (phase.value !== 'idle' || resetting.value) return null

        const cs = cipherSuite.value
        const currentGroup = group.value
        const current = currentAttachment()
        const currentScope = scopeForGroup(currentGroup)
        if (!cs || !currentGroup || !current || !currentScope) {
            status.value = 'Error: No attachment generated'
            return null
        }

        const token = invalidate()
        batch(() => {
            phase.value = nextPhase
            status.value = nextStatus
        })

        return {
            token,
            scope: currentScope,
            group: currentGroup,
            cipherSuite: cs,
            bytes: current.bytes,
            ref: current.ref
        }
    }

    async function runPlayback (
        active:ActiveAttachment,
        reader:ReadableStreamDefaultReader<Uint8Array>,
        startOffset:number,
        doneMessage:string
    ):Promise<void> {
        if (!isCurrent(active.token, active.scope)) {
            await reader.cancel().catch(() => {})
            return
        }

        const ctx = takeAudioContext(active.token)
        transferPlayback(active.token, reader, ctx)
        await ctx.resume()
        if (!isCurrent(active.token, active.scope)) return

        const outcome = await playback(
            reader,
            schedulerFor(ctx),
            startOffset,
            {
                cancelled: () => !isCurrent(active.token, active.scope),
                progress: bytesRead => {
                    if (!isCurrent(active.token, active.scope)) return
                    segmentsDone.value = Math.ceil(
                        bytesRead / SEGMENT_MAX
                    )
                }
            }
        )

        if (!isCurrent(active.token, active.scope)) return
        if (outcome === 'cancelled') return

        if (playbackSlot?.token === active.token) {
            playbackSlot.streamReader = null
        }
        batch(() => {
            phase.value = 'idle'
            status.value = doneMessage
        })
    }

    async function handlePlaybackError (
        active:ActiveAttachment,
        reader:ReadableStreamDefaultReader<Uint8Array>|null,
        err:unknown
    ):Promise<void> {
        if (!isCurrent(active.token, active.scope)) return
        if (playbackSlot?.token === active.token) {
            await releasePlaybackToken(active.token)
        } else if (reader) {
            await reader.cancel().catch(() => {})
        }
        if (!isCurrent(active.token, active.scope)) return
        batch(() => {
            phase.value = 'idle'
            status.value = errorStatus(err)
        })
    }

    function takeAudioContext (
        token:number
    ):AttachmentAudioContext {
        const existing = playbackSlot?.audioContext ?? null
        if (existing) {
            playbackSlot = {
                token,
                streamReader: playbackSlot?.streamReader ?? null,
                audioContext: existing
            }
            return existing
        }
        return makeAudioContext()
    }

    function transferPlayback (
        token:number,
        reader:ReadableStreamDefaultReader<Uint8Array>,
        ctx:AttachmentAudioContext
    ):void {
        playbackSlot = {
            token,
            streamReader: reader,
            audioContext: ctx
        }
    }

    async function releasePlaybackToken (
        token:number|null
    ):Promise<void> {
        const slot = playbackSlot
        if (!slot || (token !== null && slot.token !== token)) return
        playbackSlot = null
        await releasePlayback(slot)
    }

    function currentAttachment ():GeneratedAttachment|null {
        if (!generated) return null
        if (!sameAttachmentScope(generated.scope, scope.value)) return null
        return generated
    }

    function isCurrent (
        token:number,
        expectedScope:AttachmentScope
    ):boolean {
        return token === currentToken &&
            sameAttachmentScope(scope.value, expectedScope)
    }

    function invalidate ():number {
        currentToken++
        return currentToken
    }

    return {
        status,
        segmentsTotal,
        segmentsDone,
        phase,
        cipherSuite,
        group,
        scope,
        hasAttachment,
        playing,
        canGenerate,
        canPlay,
        canSeek,
        canStop,
        setup,
        setContext,
        resetScope,
        generate,
        play,
        seek,
        stop,
        cleanup
    }
}

function scopeForGroup (
    group:AttachmentGroup|null
):AttachmentScope|null {
    return attachmentScope(
        group?.groupContext.groupId,
        group?.groupContext.epoch
    )
}

function schedulerFor (ctx:AttachmentAudioContext):ChunkScheduler {
    return {
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

async function cancelPlainStream (
    stream:AttachmentReadStream
):Promise<void> {
    await stream.cancel?.().catch(() => {})
}
