import { test } from '@substrate-system/tapzero'
import { encodeTreeHashInput, decodeTreeHashInput } from '../../src/tree-hash.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeTreeHashInput, decodeTreeHashInput)

test('TreeHashInput roundtrip leaf', (t) => {
    roundtrip(t, { nodeType: 'leaf', leafIndex: 0, leafNode: undefined }, 'should roundtrip leaf')
})

test('TreeHashInput roundtrip parent', (t) => {
    roundtrip(t, {
        nodeType: 'parent',
        parentNode: undefined,
        leftHash: new Uint8Array([1, 2]),
        rightHash: new Uint8Array([3, 4]),
    }, 'should roundtrip parent')
})
