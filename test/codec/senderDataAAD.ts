import { test } from '@substrate-system/tapzero'
import { encodeSenderDataAAD, decodeSenderDataAAD } from '../../src/sender.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeSenderDataAAD, decodeSenderDataAAD)

test('SenderDataAAD roundtrip minimal', (t) => {
    roundtrip(t, { groupId: new Uint8Array([1]), epoch: 0n, contentType: 'application' }, 'should roundtrip minimal')
})

test('SenderDataAAD roundtrip nontrivial', (t) => {
    roundtrip(t, { groupId: new Uint8Array([2, 3, 4, 5]), epoch: 123456789n, contentType: 'commit' }, 'should roundtrip nontrivial')
})
