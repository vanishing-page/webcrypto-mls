import { test } from '@substrate-system/tapzero'
import {
    createAttachmentState,
    type AttachmentAudioContext,
    type AttachmentGroup,
    type AttachmentStateOptions
} from '../../example/attachment-state.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import type { AttachmentRef } from '../../src/attachment/reference.js'
import type { AttachmentRangeRead } from '../../src/attachment/range.js'
import type { EncryptedAttachment } from '../../src/attachment/writer.js'
import type { CiphersuiteImpl } from '../../src/index.js'

type Deferred<T> = {
    promise:Promise<T>
    resolve:(value:T) => void
    reject:(reason:unknown) => void
}

type FakeReader = ReadableStreamDefaultReader<Uint8Array> & {
    cancelCount:number
}

type FakeAudioContext = AttachmentAudioContext & {
    closeCount:number
    resumeDeferred:Deferred<void>|null
}

type FakeRangeRead = AttachmentRangeRead & {
    closeCount:number
    decryptCount:number
    plain:ReadableStream<Uint8Array>
}

function deferred<T> ():Deferred<T> {
    let resolveResult:(value:T) => void = () => {}
    let rejectResult:(reason:unknown) => void = () => {}
    const promise = new Promise<T>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
    })
    return { promise, resolve: resolveResult, reject: rejectResult }
}

function attachmentRef (plaintextLength = SEGMENT_MAX * 2):AttachmentRef {
    return {
        version: 1,
        objectId: new Uint8Array([9]),
        plaintextLength: BigInt(plaintextLength),
        snapshot: new Uint8Array([1]),
        locator: new Uint8Array()
    }
}

function encryptedAttachment (length:number):EncryptedAttachment {
    const bytes = new Uint8Array(length)
    return {
        readable: new ReadableStream<Uint8Array>({
            start (controller) {
                controller.enqueue(bytes)
                controller.close()
            }
        }),
        bytes,
        reference: attachmentRef(length)
    }
}

function group (
    groupId:ReadonlyArray<number>,
    epoch:bigint
):AttachmentGroup {
    return {
        groupContext: {
            groupId: new Uint8Array(groupId),
            epoch
        },
        keySchedule: {}
    } as AttachmentGroup
}

function cipherSuite ():CiphersuiteImpl {
    return {
        rng: {
            randomBytes: (length:number) => new Uint8Array(length).fill(7)
        }
    } as CiphersuiteImpl
}

function reader ():FakeReader {
    let cancelCount = 0
    return {
        get cancelCount () {
            return cancelCount
        },
        cancel: async () => {
            cancelCount++
        }
    } as FakeReader
}

function streamWithReader (
    fakeReader:FakeReader
):ReadableStream<Uint8Array> {
    return {
        getReader: () => fakeReader,
        cancel: () => fakeReader.cancel()
    } as unknown as ReadableStream<Uint8Array>
}

function audioContext (
    resumeDeferred:Deferred<void>|null = null
):FakeAudioContext {
    let closeCount = 0
    return {
        get closeCount () {
            return closeCount
        },
        get currentTime () {
            return 0
        },
        destination: {},
        resumeDeferred,
        createBuffer: (_channels:number, length:number) => {
            return {
                getChannelData: () => new Float32Array(length)
            }
        },
        createBufferSource: () => {
            return {
                buffer: null,
                connect: () => undefined,
                start: () => undefined
            }
        },
        resume: () => resumeDeferred?.promise ?? Promise.resolve(),
        close: async () => {
            closeCount++
        }
    }
}

function rangeRead (
    fakeReader:FakeReader,
    ranges = [{ offset: 0, length: 16 }]
):FakeRangeRead {
    let closeCount = 0
    let decryptCount = 0
    const plain = streamWithReader(fakeReader)
    return {
        ranges,
        plain,
        get closeCount () {
            return closeCount
        },
        get decryptCount () {
            return decryptCount
        },
        decrypt: () => {
            decryptCount++
            return plain
        },
        close: () => {
            closeCount++
        }
    }
}

function readyOptions (
    fakeGroup = group([1, 2], 3n)
):AttachmentStateOptions {
    const cs = cipherSuite()
    return {
        getCipherSuite: async () => cs,
        createGroup: async () => fakeGroup,
        makeTonePcm: () => new Float32Array(8),
        getRandomValues: bytes => bytes.fill(4),
        createAudioContext: () => audioContext(),
        streamFromBytes: bytes => new ReadableStream<Uint8Array>({
            start (controller) {
                controller.enqueue(bytes)
                controller.close()
            }
        })
    }
}

test('Generate cannot overlap Generate, Play, or Seek', async t => {
    const generated = deferred<EncryptedAttachment>()
    let encryptCalls = 0
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => {
            encryptCalls++
            return generated.promise
        }
    })

    await state.setup()
    const first = state.generate()
    await state.generate()
    await state.play()
    await state.seek()

    t.equal(encryptCalls, 1, 'only the first Generate starts')
    t.equal(state.phase.value, 'generating',
        'the first Generate owns the state')

    generated.resolve(encryptedAttachment(32))
    await first
})

test('Play and Seek cannot overlap each other', async t => {
    const playback = deferred<'done'|'cancelled'>()
    let playbackCalls = 0
    let openRangeCalls = 0
    const fakeReader = reader()
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encryptedAttachment(32),
        decryptStream: async () => streamWithReader(fakeReader),
        openRange: async () => {
            openRangeCalls++
            return rangeRead(reader())
        },
        playback: async () => {
            playbackCalls++
            return playback.promise
        }
    })

    await state.setup()
    await state.generate()
    const playing = state.play()
    await Promise.resolve()
    await state.seek()

    t.equal(playbackCalls, 1, 'Seek does not start during Play')
    t.equal(openRangeCalls, 0, 'Seek does not open a range during Play')
    t.equal(state.phase.value, 'playing', 'Play remains current')

    playback.resolve('done')
    await playing
})

test('Seek prevents Play from starting', async t => {
    const playback = deferred<'done'|'cancelled'>()
    let decryptCalls = 0
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encryptedAttachment(SEGMENT_MAX * 16),
        decryptStream: async () => {
            decryptCalls++
            return streamWithReader(reader())
        },
        openRange: async () => rangeRead(reader()),
        playback: async () => playback.promise
    })

    await state.setup()
    await state.generate()
    const seeking = state.seek()
    await Promise.resolve()
    await state.play()

    t.equal(decryptCalls, 0, 'Play does not decrypt during Seek')
    t.equal(state.phase.value, 'seeking', 'Seek remains current')

    playback.resolve('done')
    await seeking
})

test('reset during encryption prevents stale generated state', async t => {
    const encrypted = deferred<EncryptedAttachment>()
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encrypted.promise
    })

    await state.setup()
    const generating = state.generate()
    await state.resetScope(null)
    encrypted.resolve(encryptedAttachment(16))
    await generating

    t.equal(state.hasAttachment.value, false,
        'stale encryption does not publish bytes')
    t.equal(state.segmentsTotal.value, 0,
        'stale encryption does not publish progress totals')
    t.equal(state.status.value, 'create a group to generate an attachment',
        'reset owns the final status')
})

test('stale setup cannot publish a group or ready status', async t => {
    const csReady = deferred<CiphersuiteImpl>()
    const demoGroup = group([1, 2], 3n)
    const state = createAttachmentState({
        ...readyOptions(demoGroup),
        getCipherSuite: async () => csReady.promise
    })

    const setup = state.setup()
    await state.resetScope(null)
    csReady.resolve(cipherSuite())
    await setup

    t.equal(state.group.value, null, 'stale setup does not publish group')
    t.equal(state.cipherSuite.value, null,
        'stale setup does not publish ciphersuite')
    t.equal(state.status.value, 'create a group to generate an attachment',
        'reset owns the final status')
})

test('reset clears a generated attachment but Stop keeps it', async t => {
    const playback = deferred<'done'|'cancelled'>()
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encryptedAttachment(32),
        decryptStream: async () => streamWithReader(reader()),
        playback: async () => playback.promise
    })

    await state.setup()
    await state.generate()
    const playing = state.play()
    await state.stop()
    playback.resolve('cancelled')
    await playing

    t.equal(state.hasAttachment.value, true,
        'Stop retains generated attachment state')
    await state.resetScope(null)
    t.equal(state.hasAttachment.value, false,
        'reset clears generated attachment state')
})

test('Stop during stream setup prevents playback from starting', async t => {
    const streamReady = deferred<ReadableStream<Uint8Array>>()
    let playbackCalls = 0
    const fakeReader = reader()
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encryptedAttachment(32),
        decryptStream: async () => streamReady.promise,
        playback: async () => {
            playbackCalls++
            return 'done'
        }
    })

    await state.setup()
    await state.generate()
    const playing = state.play()
    await state.stop()
    streamReady.resolve(streamWithReader(fakeReader))
    await playing

    t.equal(playbackCalls, 0, 'playback never starts')
    t.equal(fakeReader.cancelCount, 1,
        'the stale stream reader is cancelled once')
    t.equal(state.hasAttachment.value, true,
        'Stop leaves the generated attachment available')
    t.equal(state.status.value, 'Stopped', 'Stop owns the status')
})

test('Stop during range setup prevents playback from starting', async t => {
    const rangeReady = deferred<AttachmentRangeRead>()
    let playbackCalls = 0
    const fakeReader = reader()
    const read = rangeRead(fakeReader)
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encryptedAttachment(SEGMENT_MAX * 16),
        openRange: async () => rangeReady.promise,
        playback: async () => {
            playbackCalls++
            return 'done'
        }
    })

    await state.setup()
    await state.generate()
    const seeking = state.seek()
    await state.stop()
    rangeReady.resolve(read)
    await seeking

    t.equal(playbackCalls, 0, 'range playback never starts')
    t.equal(read.closeCount, 1, 'the stale range read is closed once')
    t.equal(read.decryptCount, 0, 'stale range setup does not decrypt')
    t.equal(state.status.value, 'Stopped', 'Stop owns the status')
})

test('stale progress and completion callbacks do not update state',
    async t => {
        let progress:(bytes:number) => void = () => {}
        const playback = deferred<'done'|'cancelled'>()
        const state = createAttachmentState({
            ...readyOptions(),
            encrypt: async () => encryptedAttachment(SEGMENT_MAX * 2),
            decryptStream: async () => streamWithReader(reader()),
            playback: async (_reader, _scheduler, _startOffset, hooks) => {
                progress = hooks.progress
                return playback.promise
            }
        })

        await state.setup()
        await state.generate()
        const playing = state.play()
        progress(SEGMENT_MAX)
        await state.stop()
        progress(SEGMENT_MAX * 2)
        playback.resolve('done')
        await playing

        t.equal(state.segmentsDone.value, 0,
            'stale progress does not publish after Stop')
        t.equal(state.status.value, 'Stopped',
            'stale completion does not replace Stop status')
    })

test('a stale sequential reader is cancelled exactly once', async t => {
    const resume = deferred<void>()
    const ctx = audioContext(resume)
    const fakeReader = reader()
    const state = createAttachmentState({
        ...readyOptions(),
        createAudioContext: () => ctx,
        encrypt: async () => encryptedAttachment(32),
        decryptStream: async () => streamWithReader(fakeReader),
        playback: async () => 'done'
    })

    await state.setup()
    await state.generate()
    const playing = state.play()
    await Promise.resolve()
    await Promise.resolve()
    await state.stop()
    resume.resolve()
    await playing

    t.equal(fakeReader.cancelCount, 1,
        'Stop cancels the transferred reader once')
    t.equal(ctx.closeCount, 1,
        'Stop closes the transferred audio context once')
})

test('a failed sequential playback releases reader and context', async t => {
    const fakeReader = reader()
    const ctx = audioContext()
    const state = createAttachmentState({
        ...readyOptions(),
        createAudioContext: () => ctx,
        encrypt: async () => encryptedAttachment(32),
        decryptStream: async () => streamWithReader(fakeReader),
        playback: async () => {
            throw new Error('stream broke')
        }
    })

    await state.setup()
    await state.generate()
    await state.play()

    t.equal(fakeReader.cancelCount, 1,
        'the failed playback reader is cancelled once')
    t.equal(ctx.closeCount, 1,
        'the failed playback context is closed once')
    t.equal(state.phase.value, 'idle',
        'the failed action returns controls to idle')
    t.equal(state.status.value, 'Error: stream broke',
        'the failed action publishes the user-facing error')
})

test('a stale range read closes exactly once before decrypt', async t => {
    const read = rangeRead(reader())
    const state = createAttachmentState({
        ...readyOptions(),
        encrypt: async () => encryptedAttachment(SEGMENT_MAX * 16),
        openRange: async () => read,
        playback: async () => 'done'
    })

    await state.setup()
    await state.generate()
    const seeking = state.seek()
    await state.stop()
    await seeking

    t.equal(read.closeCount, 1, 'the range read is closed once')
    t.equal(read.decryptCount, 0, 'decrypt is never called')
})

test('old-token cleanup cannot release newer resources', async t => {
    const firstPlayback = deferred<'done'|'cancelled'>()
    const firstReader = reader()
    const secondReader = reader()
    const contexts:Array<FakeAudioContext> = [
        audioContext(),
        audioContext()
    ]
    let contextIndex = 0
    let playCount = 0
    const firstPlaybackStarted = deferred<void>()
    const state = createAttachmentState({
        ...readyOptions(),
        createAudioContext: () => contexts[contextIndex++],
        encrypt: async () => encryptedAttachment(32),
        decryptStream: async () => {
            return streamWithReader(playCount === 0 ?
                firstReader : secondReader)
        },
        playback: async () => {
            playCount++
            if (playCount === 1) firstPlaybackStarted.resolve()
            return playCount === 1 ? firstPlayback.promise : 'done'
        }
    })

    await state.setup()
    await state.generate()
    const first = state.play()
    await firstPlaybackStarted.promise
    await state.stop()
    const second = state.play()
    firstPlayback.reject(new Error('old failure'))
    await Promise.allSettled([first, second])

    t.equal(firstReader.cancelCount, 1,
        'the old reader was cancelled by Stop')
    t.equal(secondReader.cancelCount, 0,
        'old cleanup did not cancel the new reader')
    t.equal(contexts[0].closeCount, 1,
        'the old context was closed by Stop')
    t.equal(contexts[1].closeCount, 0,
        'old cleanup did not close the new context')
})
