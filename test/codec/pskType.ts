import { test } from '@substrate-system/tapzero'
import type { PSKTypeName } from '../../src/presharedkey.js'
import { encodePskType, decodePskType } from '../../src/presharedkey.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodePskType, decodePskType)

test('PSKTypeName roundtrip external', (t) => {
    roundtrip(t, 'external' as PSKTypeName, 'should roundtrip external')
})

test('PSKTypeName roundtrip resumption', (t) => {
    roundtrip(t, 'resumption' as PSKTypeName, 'should roundtrip resumption')
})
