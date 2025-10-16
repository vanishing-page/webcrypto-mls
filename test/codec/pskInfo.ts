import { test } from '@substrate-system/tapzero'
import { encodePskInfo, decodePskInfo } from '../../src/presharedkey.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodePskInfo, decodePskInfo)

test('PSKInfo roundtrip external', (t) => {
    roundtrip(t, { psktype: 'external', pskId: new Uint8Array([1, 2, 3]) }, 'should roundtrip external')
})

test('PSKInfo roundtrip resumption', (t) => {
    roundtrip(t, { psktype: 'resumption', usage: 'application', pskGroupId: new Uint8Array([4, 5, 6]), pskEpoch: 123n }, 'should roundtrip resumption')
})
