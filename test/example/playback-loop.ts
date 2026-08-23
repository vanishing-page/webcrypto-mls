import { test } from '@substrate-system/tapzero'
import {
    LEAD_SECONDS,
    schedulePlayback,
    type ChunkScheduler
} from '../../example/playback-loop.js'
import { SAMPLE_RATE } from '../../example/attachment-audio.js'

/**
 * A chunk of PCM bytes. Four octets per sample, so any multiple of
 * four is a legal chunk for `bytesToPcm`.
 */
function chunk (n:number, fill:number):Uint8Array {
    return new Uint8Array(n * 4).fill(fill)
}

function readerOf (
    chunks:Uint8Array[],
    opts:{ failAfter?:number } = {}
):ReadableStreamDefaultReader<Uint8Array> {
    let i = 0
    return new ReadableStream<Uint8Array>({
        async pull (controller) {
            // Yield to the microtask queue so a caller that forgets to
            // await the loop can observably run ahead of the stream.
            await Promise.resolve()
            if (opts.failAfter !== undefined && i === opts.failAfter) {
                controller.error(new Error('stream broke'))
                return
            }
            if (i >= chunks.length) {
                controller.close()
                return
            }
            controller.enqueue(chunks[i++])
        }
    }).getReader()
}

function recordingScheduler ():ChunkScheduler & {
    scheduled:{ samples:number, at:number }[]
} {
    const scheduled:{ samples:number, at:number }[] = []
    return {
        scheduled,
        now: () => 0,
        schedule (pcm, at) {
            scheduled.push({ samples: pcm.length, at })
        }
    }
}

test('schedulePlayback settles only when the stream is done', async t => {
    const chunks = [chunk(8, 1), chunk(8, 2), chunk(8, 3), chunk(8, 4)]
    const scheduler = recordingScheduler()
    const progress:number[] = []

    const outcome = await schedulePlayback(readerOf(chunks), scheduler, 0, {
        cancelled: () => false,
        progress: bytes => progress.push(bytes)
    })

    t.equal(outcome, 'done', 'the loop reports the stream finished')
    t.equal(scheduler.scheduled.length, chunks.length,
        'every chunk was scheduled before the promise settled')
    t.equal(progress.length, chunks.length,
        'progress was reported once per chunk before settling')
    t.equal(progress[progress.length - 1], chunks.length * 8 * 4,
        'the final progress report counts every byte read')
})

test('schedulePlayback places chunks end to end from the base clock',
    async t => {
        const scheduler = recordingScheduler()
        // 8 samples per chunk at SAMPLE_RATE, starting at now() + lead.
        await schedulePlayback(
            readerOf([chunk(8, 1), chunk(8, 2)]),
            scheduler,
            0,
            { cancelled: () => false, progress: () => undefined }
        )

        const [first, second] = scheduler.scheduled
        const gap = second.at - first.at
        t.ok(Math.abs(gap - (8 / SAMPLE_RATE)) < 1e-9,
            `chunks are laid end to end: gap ${gap}s for 8 samples`)
        t.equal(first.at, scheduler.now() + LEAD_SECONDS,
            'the first chunk is scheduled a lead time ahead of the clock')
    })

test('the key stays live for the whole stream, not just the first chunk',
    async t => {
        // The shape handlePlay uses: a try/finally that wipes the CEK.
        // If the loop is not awaited, the finally runs while chunks are
        // still being scheduled.
        const cek = new Uint8Array(32).fill(7)
        const cekAtSchedule:boolean[] = []
        const scheduler = recordingScheduler()
        const watching:ChunkScheduler = {
            now: scheduler.now,
            schedule (pcm, at) {
                cekAtSchedule.push(cek.some(b => b !== 0))
                scheduler.schedule(pcm, at)
            }
        }

        try {
            await schedulePlayback(
                readerOf([chunk(8, 1), chunk(8, 2), chunk(8, 3)]),
                watching,
                0,
                { cancelled: () => false, progress: () => undefined }
            )
        } finally {
            cek.fill(0)
        }

        t.equal(cekAtSchedule.length, 3, 'all three chunks were scheduled')
        t.ok(cekAtSchedule.every(live => live),
            'the CEK was still live at every scheduled chunk')
        t.ok(cek.every(b => b === 0), 'the CEK is zero once the loop is done')
    })

test('a mid-stream error rejects so the caller can clear playing',
    async t => {
        const scheduler = recordingScheduler()
        let playing = true
        let reported:string|null = null

        try {
            await schedulePlayback(
                readerOf([chunk(8, 1), chunk(8, 2)], { failAfter: 1 }),
                scheduler,
                0,
                { cancelled: () => false, progress: () => undefined }
            )
        } catch (err) {
            playing = false
            reported = err instanceof Error ? err.message : String(err)
        }

        t.equal(scheduler.scheduled.length, 1,
            'the chunk before the failure was scheduled')
        t.equal(playing, false, 'the caller cleared playing')
        t.equal(reported, 'stream broke',
            'the caller received the stream error to surface')
    })

test('a cancel mid-stream stops the loop without a done outcome',
    async t => {
        const scheduler = recordingScheduler()
        let cancelled = false

        const outcome = await schedulePlayback(
            readerOf([chunk(8, 1), chunk(8, 2), chunk(8, 3)]),
            scheduler,
            0,
            {
                cancelled: () => cancelled,
                progress: () => {
                    cancelled = true
                }
            }
        )

        t.equal(outcome, 'cancelled', 'the loop reports it was cancelled')
        t.equal(scheduler.scheduled.length, 1,
            'no chunk is scheduled after the cancel is observed')
    })

test('startOffset only shifts the timeline origin, not the base clock',
    async t => {
        const scheduler = recordingScheduler()
        const startOffset = 8 * SAMPLE_RATE * 4

        await schedulePlayback(
            readerOf([chunk(8, 1)]),
            scheduler,
            startOffset,
            { cancelled: () => false, progress: () => undefined }
        )

        t.equal(scheduler.scheduled[0].at, scheduler.now() + LEAD_SECONDS,
            'a seeked stream still starts at the lead time, not at 8s')
    })
