import { test } from '@substrate-system/tapzero'
import { encodePskId, decodePskId } from '../../src/presharedkey.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodePskId, decodePskId)

test('PreSharedKeyID roundtrip external', (t) => {
    roundtrip(t, { psktype: 'external', pskId: new Uint8Array([1, 2, 3]), pskNonce: new Uint8Array([4, 5, 6, 7]) }, 'should roundtrip external')
})

test('PreSharedKeyID roundtrip resumption', (t) => {
    roundtrip(t, {
        psktype: 'resumption',
        usage: 'application',
        pskGroupId: new Uint8Array([8, 9, 10]),
        pskEpoch: 123n,
        pskNonce: new Uint8Array([11, 12, 13, 14]),
    }, 'should roundtrip resumption')
})
