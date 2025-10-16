import { test } from '@substrate-system/tapzero'
import type { ReuseGuard } from '../../src/sender.js'
import { encodeSenderData, decodeSenderData } from '../../src/sender.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeSenderData, decodeSenderData)

test('SenderData roundtrip minimal', (t) => {
    roundtrip(t, { leafIndex: 0, generation: 0, reuseGuard: new Uint8Array([1, 2, 3, 4]) as ReuseGuard }, 'should roundtrip minimal')
})

test('SenderData roundtrip nonzero', (t) => {
    roundtrip(t, { leafIndex: 123, generation: 456, reuseGuard: new Uint8Array([5, 6, 7, 8]) as ReuseGuard }, 'should roundtrip nonzero')
})
