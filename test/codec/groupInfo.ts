import { test } from '@substrate-system/tapzero'
import type {
    GroupInfoTBS,
    GroupInfo
} from '../../src/groupInfo.js'
import {
    encodeGroupInfoTBS,
    decodeGroupInfoTBS,
    encodeGroupInfo,
    decodeGroupInfo
} from '../../src/groupInfo.js'
import { createRoundtripTest } from './roundtrip.js'
import type { GroupContext } from '../../src/groupContext.js'

const dummyGroupContext: GroupContext = {
    version: 'mls10',
    cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
    groupId: new Uint8Array([1, 2, 3]),
    epoch: 0n,
    treeHash: new Uint8Array([4, 5]),
    confirmedTranscriptHash: new Uint8Array([6]),
    extensions: [],
}
const dummyExtension = { extensionType: 'ratchet_tree', extensionData: new Uint8Array([8, 9]) } as const

const minimalTBS: GroupInfoTBS = {
    groupContext: dummyGroupContext,
    extensions: [],
    confirmationTag: new Uint8Array([]),
    signer: 0,
}

const nontrivialTBS: GroupInfoTBS = {
    groupContext: dummyGroupContext,
    extensions: [dummyExtension],
    confirmationTag: new Uint8Array([1, 2, 3]),
    signer: 42,
}

const roundtripTBS = createRoundtripTest(encodeGroupInfoTBS, decodeGroupInfoTBS)
const roundtripGroupInfo = createRoundtripTest(encodeGroupInfo, decodeGroupInfo)

test('groupInfoTBS roundtrip minimal', (t) => {
    roundtripTBS(t, minimalTBS, 'should roundtrip minimal group info TBS')
})

test('groupInfoTBS roundtrip nontrivial', (t) => {
    roundtripTBS(t, nontrivialTBS, 'should roundtrip nontrivial group info TBS')
})

test('groupInfo roundtrip minimal', (t) => {
    const g: GroupInfo = { ...minimalTBS, signature: new Uint8Array([]) }
    roundtripGroupInfo(t, g, 'should roundtrip minimal group info')
})

test('groupInfo roundtrip nontrivial', (t) => {
    const g: GroupInfo = { ...nontrivialTBS, signature: new Uint8Array([9, 8, 7]) }
    roundtripGroupInfo(t, g, 'should roundtrip nontrivial group info')
})
