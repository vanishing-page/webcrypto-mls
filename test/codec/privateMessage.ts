import { test } from '@substrate-system/tapzero'
import { encodePrivateMessage, decodePrivateMessage } from '../../src/privateMessage.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodePrivateMessage, decodePrivateMessage)

test('PrivateMessage roundtrip application', (t) => {
    roundtrip(t, {
        groupId: new Uint8Array([1]),
        epoch: 0n,
        contentType: 'application',
        authenticatedData: new Uint8Array([2]),
        encryptedSenderData: new Uint8Array([3]),
        ciphertext: new Uint8Array([4]),
    }, 'should roundtrip application')
})

test('PrivateMessage roundtrip commit', (t) => {
    roundtrip(t, {
        groupId: new Uint8Array([5, 6]),
        epoch: 123n,
        contentType: 'commit',
        authenticatedData: new Uint8Array([7, 8]),
        encryptedSenderData: new Uint8Array([9, 10]),
        ciphertext: new Uint8Array([11, 12, 13]),
    }, 'should roundtrip commit')
})

test('PrivateMessage roundtrip proposal', (t) => {
    roundtrip(t, {
        groupId: new Uint8Array([5, 6]),
        epoch: 123n,
        contentType: 'proposal',
        authenticatedData: new Uint8Array([7, 8]),
        encryptedSenderData: new Uint8Array([9, 10]),
        ciphertext: new Uint8Array([11, 12, 13]),
    }, 'should roundtrip proposal')
})
