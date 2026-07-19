import { test } from '@substrate-system/tapzero'
import type { Rng } from '../src/crypto/rng.js'
import { grease, greaseValues, defaultGreaseConfig } from '../src/grease.js'

function mockRng (byte:number):Rng {
    return {
        randomBytes (n) {
            return new Uint8Array(n).fill(byte)
        },
    }
}

test('grease - uses the given rng, not Math.random', (t) => {
    const originalRandom = Math.random
    let called = false
    Math.random = () => {
        called = true
        return 0
    }

    try {
        grease(defaultGreaseConfig, mockRng(0x00))
        t.equal(called, false, 'grease should not call Math.random')
    } finally {
        Math.random = originalRandom
    }
})

test('grease - low rng bytes select every value', (t) => {
    const result = grease(defaultGreaseConfig, mockRng(0x00))
    t.equal(result.length, greaseValues.length, 'a near-zero draw is below every threshold')
})

test('grease - high rng bytes select no value', (t) => {
    const result = grease(defaultGreaseConfig, mockRng(0xff))
    t.equal(result.length, 0, 'a near-one draw is above every threshold')
})

test('grease - is deterministic for a given rng', (t) => {
    const a = grease(defaultGreaseConfig, mockRng(0x05))
    const b = grease(defaultGreaseConfig, mockRng(0x05))
    t.deepEqual(a, b, 'same rng bytes should produce the same selection')
})
