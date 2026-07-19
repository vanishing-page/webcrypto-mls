import { test } from '@substrate-system/tapzero'
import type { NodeTypeName } from '../../src/node-type.js'
import { encodeNodeType, decodeNodeType } from '../../src/node-type.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeNodeType, decodeNodeType)

test('NodeTypeName roundtrip leaf', (t) => {
    roundtrip(t, 'leaf' as NodeTypeName, 'should roundtrip leaf')
})

test('NodeTypeName roundtrip parent', (t) => {
    roundtrip(t, 'parent' as NodeTypeName, 'should roundtrip parent')
})
