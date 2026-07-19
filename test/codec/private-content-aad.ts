import { test } from '@substrate-system/tapzero'
import {
    encodePrivateContentAAD,
    decodePrivateContentAAD
} from '../../src/private-message.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(
    encodePrivateContentAAD,
    decodePrivateContentAAD
)

test('PrivateContentAAD roundtrip application', (t) => {
    roundtrip(t, {
        groupId: new Uint8Array([1]),
        epoch: 0n,
        contentType: 'application',
        authenticatedData: new Uint8Array([2]),
    }, 'should roundtrip application')
})

test('PrivateContentAAD roundtrip commit', (t) => {
    roundtrip(t, {
        groupId: new Uint8Array([3, 4, 5]),
        epoch: 123n,
        contentType: 'commit',
        authenticatedData: new Uint8Array([6, 7, 8]),
    }, 'should roundtrip commit')
})

test('PrivateContentAAD roundtrip proposal', (t) => {
    roundtrip(t, {
        groupId: new Uint8Array([3, 4, 5]),
        epoch: 123n,
        contentType: 'proposal',
        authenticatedData: new Uint8Array([6, 7, 8]),
    }, 'should roundtrip proposal')
})
