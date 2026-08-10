import { test } from '@substrate-system/tapzero'
import type { ReuseGuard } from '../../src/sender.js'
import {
    encodeSenderData,
    decodeSenderData,
    decodeReuseGuard,
} from '../../src/sender.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeSenderData, decodeSenderData)

test('SenderData roundtrip minimal', (t) => {
    roundtrip(t, { leafIndex: 0, generation: 0, reuseGuard: new Uint8Array([1, 2, 3, 4]) as ReuseGuard }, 'should roundtrip minimal')
})

test('SenderData roundtrip nonzero', (t) => {
    roundtrip(t, { leafIndex: 123, generation: 456, reuseGuard: new Uint8Array([5, 6, 7, 8]) as ReuseGuard }, 'should roundtrip nonzero')
})

test('decodeReuseGuard rejects a short buffer', (t) => {
    for (let n = 0; n < 4; n++) {
        t.equal(
            decodeReuseGuard(new Uint8Array(n), 0),
            undefined,
            `should fail to decode with ${n} bytes available`,
        )
    }
})

test('decodeReuseGuard respects the offset', (t) => {
    const b = new Uint8Array([9, 9, 1, 2, 3])
    t.equal(
        decodeReuseGuard(b, 2),
        undefined,
        'should fail when fewer than 4 bytes remain after the offset',
    )

    const ok = decodeReuseGuard(new Uint8Array([9, 9, 1, 2, 3, 4]), 2)
    t.ok(ok, 'should decode when exactly 4 bytes remain')
    t.equal(ok?.[1], 4, 'should report consuming 4 bytes')
    t.equal(ok?.[0].length, 4, 'should produce a 4 byte reuse guard')
})

test('SenderData truncated inside the reuse guard fails to decode', (t) => {
    const full = encodeSenderData({
        leafIndex: 7,
        generation: 3,
        reuseGuard: new Uint8Array([1, 2, 3, 4]) as ReuseGuard,
    })

    for (let n = 8; n < full.length; n++) {
        t.equal(
            decodeSenderData(full.subarray(0, n), 0),
            undefined,
            `should fail to decode ${n} of ${full.length} bytes`,
        )
    }
})
