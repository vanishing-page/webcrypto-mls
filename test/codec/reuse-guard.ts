import { test } from '@substrate-system/tapzero'
import type { ReuseGuard } from '../../src/sender.js'
import { encodeReuseGuard, decodeReuseGuard } from '../../src/sender.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeReuseGuard, decodeReuseGuard)

test('ReuseGuard roundtrip', (t) => {
    roundtrip(t, new Uint8Array([1, 2, 3, 4]) as ReuseGuard, 'should roundtrip')
})
