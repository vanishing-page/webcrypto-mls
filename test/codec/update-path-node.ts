import { test } from '@substrate-system/tapzero'
import type { UpdatePathNode } from '../../src/update-path.js'
import {
    encodeUpdatePathNode,
    decodeUpdatePathNode
} from '../../src/update-path.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(
    encodeUpdatePathNode,
    decodeUpdatePathNode
)

test('UpdatePathNode roundtrip minimal', (t) => {
    const node:UpdatePathNode = {
        hpkePublicKey: new Uint8Array([1, 2, 3]),
        encryptedPathSecret: [],
    }
    roundtrip(t, node, 'should roundtrip minimal')
})

test('UpdatePathNode roundtrip nontrivial', (t) => {
    const node:UpdatePathNode = {
        hpkePublicKey: new Uint8Array([4, 5, 6, 7, 8]),
        encryptedPathSecret: [
            { ciphertext: new Uint8Array([9, 10, 11]), kemOutput: new Uint8Array([12, 13]) },
            { ciphertext: new Uint8Array([14, 15, 16, 17]), kemOutput: new Uint8Array([18, 19, 20]) },
        ],
    }
    roundtrip(t, node, 'should roundtrip nontrivial')
})
