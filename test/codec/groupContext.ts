import { test } from '@substrate-system/tapzero'
import type { GroupContext } from '../../src/groupContext.js'
import { encodeGroupContext, decodeGroupContext } from '../../src/groupContext.js'
import { createRoundtripTest } from './roundtrip.js'

const minimalGroupContext: GroupContext = {
    version: 'mls10',
    cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
    groupId: new Uint8Array([]),
    epoch: 0n,
    treeHash: new Uint8Array([]),
    confirmedTranscriptHash: new Uint8Array([]),
    extensions: [],
}

const nontrivialGroupContext: GroupContext = {
    version: 'mls10',
    cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
    groupId: new Uint8Array([1, 2, 3]),
    epoch: 42n,
    treeHash: new Uint8Array([4, 5]),
    confirmedTranscriptHash: new Uint8Array([6, 7]),
    extensions: [{ extensionType: 'ratchet_tree', extensionData: new Uint8Array([8, 9]) }],
}

const roundtrip = createRoundtripTest(encodeGroupContext, decodeGroupContext)

test('groupContext roundtrip minimal', (t) => {
    roundtrip(t, minimalGroupContext, 'should roundtrip minimal group context')
})

test('groupContext roundtrip nontrivial', (t) => {
    roundtrip(t, nontrivialGroupContext, 'should roundtrip nontrivial group context')
})
