import { test } from '@substrate-system/tapzero'
import { createGroupLock } from
    '../../example-realistic-demo/client/group-lock.js'
import { deferred } from './async-helpers.js'

test('groupLock - a job waits for the one before it to settle', async t => {
    const lock = createGroupLock()
    const order:string[] = []
    const first = deferred()

    const one = lock.run(async () => {
        order.push('one-in')
        await first.promise
        order.push('one-out')
    })

    const two = lock.run(async () => {
        order.push('two-in')
    })

    // The important assertion is the negative one: `two` has not started
    // even though nothing is stopping its own body from running.
    await Promise.resolve()
    t.deepEqual(order, ['one-in'], 'the second job has not begun')

    first.resolve()
    await Promise.all([one, two])

    t.deepEqual(
        order,
        ['one-in', 'one-out', 'two-in'],
        'and it begins only once the first has finished, not merely started'
    )
})

test('groupLock - the second job reads what the first wrote', async t => {
    // The rule the lock exists for. Two read-modify-writes of the same
    // value with an await in between lose one of the two updates unless
    // something orders them.
    const lock = createGroupLock()
    let value = 0

    const bump = () => lock.run(async () => {
        const read = value
        await new Promise<void>(resolve => { setTimeout(resolve, 0) })
        value = read + 1
    })

    await Promise.all([bump(), bump(), bump()])

    t.equal(value, 3, 'every update landed')
})

test('groupLock - a job that throws does not stop the ones behind it',
    async t => {
        const lock = createGroupLock()
        const ran:string[] = []

        const failed = lock.run(async () => {
            ran.push('failing')
            throw new Error('no')
        })

        const after = lock.run(async () => { ran.push('after') })

        let caught:unknown = null
        await failed.catch(err => { caught = err })
        await after

        t.equal(
            (caught as Error | null)?.message,
            'no',
            'the rejection reaches the caller that queued it'
        )
        t.deepEqual(
            ran,
            ['failing', 'after'],
            'and the next job still runs'
        )
    })

test('groupLock - a job\'s result is returned to its own caller', async t => {
    const lock = createGroupLock()

    const [a, b] = await Promise.all([
        lock.run(async () => 'first'),
        lock.run(async () => 'second')
    ])

    t.equal(a, 'first', 'each caller gets its own job\'s value')
    t.equal(b, 'second', 'and not the other\'s')
})
