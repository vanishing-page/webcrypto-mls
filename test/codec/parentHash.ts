import { test } from '@substrate-system/tapzero'
import { encodeParentHashInput, decodeParentHashInput } from '../../src/parentHash.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeParentHashInput, decodeParentHashInput)

test('ParentHashInput roundtrip', (t) => {
    roundtrip(t, {
        encryptionKey: new Uint8Array([1]),
        parentHash: new Uint8Array([2]),
        originalSiblingTreeHash: new Uint8Array([3]),
    }, 'should roundtrip ParentHashInput')
})
