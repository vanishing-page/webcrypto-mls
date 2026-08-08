import { test } from '@substrate-system/tapzero'
import {
    advanceCursor,
    entryPosition,
    reconnectDelay,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
} from '../../example-realistic-demo/client/delivery-cursor.js'
import type { LogEntry } from '../../example-realistic-demo/protocol.js'

function entry (seq:number):LogEntry {
    return { seq, sender: 'k1', kind: 'application', payload: 'p' }
}

// advanceCursor -- realistic-demo.AC10.4

test('advanceCursor - advances by exactly one', (t) => {
    t.equal(advanceCursor(5, 6), 6)
})

test('advanceCursor - the first entry moves 0 to 1', (t) => {
    t.equal(advanceCursor(0, 1), 1)
})

test('advanceCursor - refuses to skip a gap', (t) => {
    t.equal(advanceCursor(5, 7), 5)
    t.equal(advanceCursor(0, 2), 0)
})

test('advanceCursor - an already-applied seq leaves it alone', (t) => {
    t.equal(advanceCursor(5, 5), 5)
    t.equal(advanceCursor(5, 1), 5)
    t.equal(advanceCursor(5, 0), 5)
})

test('advanceCursor - never moves backward, over a range', (t) => {
    for (let cursor = 0; cursor < 20; cursor++) {
        for (let seq = -3; seq < 25; seq++) {
            const next = advanceCursor(cursor, seq)
            t.ok(
                next >= cursor,
                `cursor ${cursor}, seq ${seq} gave ${next}`
            )
        }
    }
})

test('advanceCursor - never advances by more than one', (t) => {
    for (let cursor = 0; cursor < 20; cursor++) {
        for (let seq = -3; seq < 25; seq++) {
            const next = advanceCursor(cursor, seq)
            t.ok(
                next <= cursor + 1,
                `cursor ${cursor}, seq ${seq} gave ${next}`
            )
        }
    }
})

// entryPosition

test('entryPosition - the next expected entry', (t) => {
    t.equal(entryPosition(5, entry(6)), 'next')
    t.equal(entryPosition(0, entry(1)), 'next')
})

test('entryPosition - at or below the cursor is seen', (t) => {
    t.equal(entryPosition(5, entry(5)), 'seen')
    t.equal(entryPosition(5, entry(4)), 'seen')
    t.equal(entryPosition(5, entry(1)), 'seen')
})

test('entryPosition - above the next expected is a gap', (t) => {
    t.equal(entryPosition(5, entry(7)), 'gap')
    t.equal(entryPosition(0, entry(2)), 'gap')
})

test('entryPosition - agrees with advanceCursor', (t) => {
    for (let cursor = 0; cursor < 12; cursor++) {
        for (let seq = 1; seq < 15; seq++) {
            const position = entryPosition(cursor, entry(seq))
            const moved = advanceCursor(cursor, seq) !== cursor
            t.equal(
                moved,
                position === 'next',
                `cursor ${cursor}, seq ${seq} was ${position}`
            )
        }
    }
})

// reconnectDelay -- realistic-demo.AC10.5

test('reconnectDelay - the first attempt waits the base delay', (t) => {
    t.equal(reconnectDelay(0), RECONNECT_BASE_MS)
})

test('reconnectDelay - grows strictly until the cap', (t) => {
    let grew = 0
    for (let n = 0; n < 20; n++) {
        const here = reconnectDelay(n)
        const next = reconnectDelay(n + 1)
        if (here < RECONNECT_MAX_MS) {
            t.ok(next > here, `attempt ${n}: ${here} then ${next}`)
            grew++
        }
    }
    t.ok(grew >= 5, 'growth was actually exercised')
})

test('reconnectDelay - never exceeds the cap', (t) => {
    for (const n of [0, 1, 5, 10, 20, 50, 1000, 1e6]) {
        const delay = reconnectDelay(n)
        t.ok(
            delay <= RECONNECT_MAX_MS,
            `attempt ${n} gave ${delay}`
        )
        t.ok(Number.isFinite(delay), `attempt ${n} was finite`)
    }
})

test('reconnectDelay - reaches the cap and stays there', (t) => {
    t.equal(reconnectDelay(50), RECONNECT_MAX_MS)
    t.equal(reconnectDelay(51), RECONNECT_MAX_MS)
})

test('reconnectDelay - a negative attempt is the base delay', (t) => {
    t.equal(reconnectDelay(-1), RECONNECT_BASE_MS)
    t.equal(reconnectDelay(-100), RECONNECT_BASE_MS)
})

test('reconnectDelay - a fractional attempt does not give NaN', (t) => {
    t.equal(reconnectDelay(1.9), reconnectDelay(1))
    t.ok(Number.isFinite(reconnectDelay(0.5)))
})
