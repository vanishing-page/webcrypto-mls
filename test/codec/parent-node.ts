import { test } from '@substrate-system/tapzero'
import type { ParentNode } from '../../src/parent-node.js'
import { encodeParentNode, decodeParentNode } from '../../src/parent-node.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeParentNode, decodeParentNode)

test('ParentNode roundtrip minimal', (t) => {
    const node:ParentNode = {
        hpkePublicKey: new Uint8Array([]),
        parentHash: new Uint8Array([]),
        unmergedLeaves: [],
    }
    roundtrip(t, node, 'should roundtrip minimal')
})

test('ParentNode roundtrip nontrivial', (t) => {
    const node:ParentNode = {
        hpkePublicKey: new Uint8Array([1, 2, 3]),
        parentHash: new Uint8Array([4, 5, 6]),
        unmergedLeaves: [7, 8, 9],
    }
    roundtrip(t, node, 'should roundtrip nontrivial')
})
