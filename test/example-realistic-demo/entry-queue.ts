import { test } from '@substrate-system/tapzero'
import {
    createEntryQueue
} from '../../example-realistic-demo/client/entry-queue.js'

/**
 * A real yield, so a drain genuinely suspends between items and a push
 * arriving mid-drain has somewhere to land.
 */
function tick ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

// realistic-demo.AC9.3

test('entry-queue - a mid-drain push is applied after the batch',
    async (t) => {
        const applied:string[] = []
        const queue = createEntryQueue<string>({
            async apply (item) {
                await tick()
                applied.push(item)
            },
            onError () {
                return 'continue'
            }
        })

        queue.push(['a', 'b', 'c'])
        // land the late item while the first batch is still draining
        await tick()
        t.ok(queue.draining, 'the first batch is still in flight')
        queue.push(['late'])

        await queue.idle()
        t.deepEqual(applied, ['a', 'b', 'c', 'late'])
    })

test('entry-queue - a push during a drain starts no second drain',
    async (t) => {
        let inFlight = 0
        let overlaps = 0
        const queue = createEntryQueue<number>({
            async apply () {
                inFlight++
                if (inFlight > 1) overlaps++
                await tick()
                inFlight--
            },
            onError () {
                return 'continue'
            }
        })

        queue.push([1, 2, 3])
        await tick()
        queue.push([4])
        await tick()
        queue.push([5, 6])

        await queue.idle()
        t.equal(overlaps, 0, 'apply was never re-entered')
        t.equal(queue.size, 0)
        t.equal(queue.draining, false)
    })

test('entry-queue - applies a batch in order', async (t) => {
    const applied:number[] = []
    const queue = createEntryQueue<number>({
        async apply (item) {
            // a longer wait for the earlier items, so anything that
            // applied them concurrently would record them out of order
            await new Promise(resolve => setTimeout(resolve, 10 - item))
            applied.push(item)
        },
        onError () {
            return 'continue'
        }
    })

    queue.push([1, 2, 3, 4])
    await queue.idle()
    t.deepEqual(applied, [1, 2, 3, 4])
})

// the error policy

test('entry-queue - stop halts everything behind the failure',
    async (t) => {
        const applied:string[] = []
        const seen:string[] = []
        const queue = createEntryQueue<string>({
            async apply (item) {
                await tick()
                if (item === 'bad') throw new Error('nope')
                applied.push(item)
            },
            onError (_err, item) {
                seen.push(item)
                return 'stop'
            }
        })

        queue.push(['a', 'bad', 'b', 'c'])
        await queue.idle()

        t.deepEqual(applied, ['a'])
        t.deepEqual(seen, ['bad'])
        t.equal(queue.stopped, true)
        t.equal(queue.size, 0, 'the backlog was discarded')
    })

test('entry-queue - continue drops only the failing item', async (t) => {
    const applied:string[] = []
    const seen:string[] = []
    const queue = createEntryQueue<string>({
        async apply (item) {
            await tick()
            if (item === 'bad') throw new Error('nope')
            applied.push(item)
        },
        onError (_err, item) {
            seen.push(item)
            return 'continue'
        }
    })

    queue.push(['a', 'bad', 'b', 'c'])
    await queue.idle()

    t.deepEqual(applied, ['a', 'b', 'c'])
    t.deepEqual(seen, ['bad'], 'reported exactly once')
    t.equal(queue.stopped, false)
})

test('entry-queue - stopped latches against a later push', async (t) => {
    const applied:string[] = []
    const queue = createEntryQueue<string>({
        async apply (item) {
            await tick()
            if (item === 'bad') throw new Error('nope')
            applied.push(item)
        },
        onError () {
            return 'stop'
        }
    })

    queue.push(['bad'])
    await queue.idle()
    t.equal(queue.stopped, true)

    queue.push(['after'])
    await queue.idle()
    t.deepEqual(applied, [], 'nothing was applied while stopped')
})

test('entry-queue - reset clears the stop', async (t) => {
    const applied:string[] = []
    const queue = createEntryQueue<string>({
        async apply (item) {
            await tick()
            if (item === 'bad') throw new Error('nope')
            applied.push(item)
        },
        onError () {
            return 'stop'
        }
    })

    queue.push(['bad'])
    await queue.idle()

    queue.reset()
    t.equal(queue.stopped, false)

    queue.push(['after'])
    await queue.idle()
    t.deepEqual(applied, ['after'])
})

test('entry-queue - reset discards the backlog', async (t) => {
    const applied:string[] = []
    const queue = createEntryQueue<string>({
        async apply (item) {
            await tick()
            applied.push(item)
        },
        onError () {
            return 'continue'
        }
    })

    queue.push(['a', 'b', 'c'])
    await tick()
    queue.reset()
    await queue.idle()

    t.ok(applied.length < 3, 'the queued remainder was dropped')
    t.equal(queue.size, 0)
})

test('entry-queue - idle resolves immediately when empty', async (t) => {
    const queue = createEntryQueue<number>({
        async apply () {},
        onError () {
            return 'continue'
        }
    })

    let resolved = false
    const waiting = queue.idle().then(() => {
        resolved = true
    })
    await waiting
    t.equal(resolved, true)
    t.equal(queue.size, 0)
})

test('entry-queue - idle waits for the drain to finish', async (t) => {
    const applied:number[] = []
    const queue = createEntryQueue<number>({
        async apply (item) {
            await tick()
            applied.push(item)
        },
        onError () {
            return 'continue'
        }
    })

    queue.push([1, 2, 3])
    t.equal(applied.length, 0, 'nothing applied synchronously')
    await queue.idle()
    t.equal(applied.length, 3)
    t.equal(queue.draining, false)
})

test('entry-queue - a throwing onError stops rather than wedging',
    async (t) => {
        const applied:number[] = []
        const queue = createEntryQueue<number>({
            async apply (item) {
                await tick()
                if (item === 2) throw new Error('nope')
                applied.push(item)
            },
            onError ():'stop'|'continue' {
                // A handler that itself fails. Nothing in the client
                // does this on purpose, but `onError` writes signals,
                // and an exception escaping the drain would leave
                // `draining` set for the life of the page: every later
                // push would start no drain and be swallowed in
                // silence.
                throw new Error('the handler failed too')
            }
        })

        queue.push([1, 2, 3])
        await queue.idle()

        t.deepEqual(applied, [1], 'the drain stopped at the failure')
        t.equal(queue.draining, false,
            'the drain finished rather than hanging')
        t.equal(queue.stopped, true,
            'an unhandled failure stops the queue, it does not advance')

        // and the client is recoverable, exactly as it is after a
        // deliberate stop -- `onOpen` resets and the replay re-delivers
        queue.reset()
        queue.push([4])
        await queue.idle()
        t.deepEqual(applied, [1, 4], 'a reset makes it usable again')
    })
