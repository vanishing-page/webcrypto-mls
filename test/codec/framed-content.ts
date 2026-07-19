import { test } from '@substrate-system/tapzero'
import {
    encodeFramedContent,
    decodeFramedContent
} from '../../src/framed-content.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeFramedContent, decodeFramedContent)

test('framedContent roundtrip application', (t) => {
    roundtrip(t, {
        contentType: 'application',
        groupId: new Uint8Array([1]),
        epoch: 0n,
        sender: { senderType: 'member', leafIndex: 0 },
        authenticatedData: new Uint8Array([2]),
        applicationData: new Uint8Array([3]),
    }, 'should roundtrip application framed content')
})

test('framedContent roundtrip commit', (t) => {
    roundtrip(t, {
        contentType: 'commit',
        groupId: new Uint8Array([4, 5]),
        epoch: 1n,
        sender: { senderType: 'external', senderIndex: 1 },
        authenticatedData: new Uint8Array([6, 7]),
        commit: { proposals: [], path: undefined },
    }, 'should roundtrip commit framed content')
})
