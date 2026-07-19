import { test } from '@substrate-system/tapzero'
import type { PaddingConfig } from '../../src/padding-config.js'
import type { PrivateMessageContent } from '../../src/private-message.js'
import {
    encodePrivateMessageContent,
    decodePrivateMessageContent
} from '../../src/private-message.js'
import { createRoundtripTest } from './roundtrip.js'

const content:PrivateMessageContent = {
    contentType: 'application',
    applicationData: new Uint8Array(),
    auth: {
        signature: new Uint8Array(),
        contentType: 'application',
    },
}

test('PrivateMessageContent roundtrip with no padding', (t) => {
    const roundtrip = createRoundtripTest(
        encodePrivateMessageContent({ kind: 'alwaysPad', paddingLength: 0 }),
        decodePrivateMessageContent('application')
    )
    roundtrip(t, content, 'should roundtrip with no padding')
})

test('PrivateMessageContent roundtrip with 64 bytes of padding', (t) => {
    const roundtrip = createRoundtripTest(
        encodePrivateMessageContent({ kind: 'alwaysPad', paddingLength: 64 }),
        decodePrivateMessageContent('application')
    )
    roundtrip(t, content, 'should roundtrip with 64 bytes of padding')
})

test('PrivateMessageContent roundtrip with 256 bytes of padding', (t) => {
    const roundtrip = createRoundtripTest(
        encodePrivateMessageContent({ kind: 'alwaysPad', paddingLength: 256 }),
        decodePrivateMessageContent('application')
    )
    roundtrip(t, content, 'should roundtrip with 256 bytes of padding')
})

test('PrivateMessageContent roundtrip with 5000 bytes of padding', (t) => {
    const roundtrip = createRoundtripTest(
        encodePrivateMessageContent({ kind: 'alwaysPad', paddingLength: 5000 }),
        decodePrivateMessageContent('application')
    )
    roundtrip(t, content, 'should roundtrip with 5000 bytes of padding')
})

test('PrivateMessageContent roundtrip with 80000 bytes of padding', (t) => {
    const roundtrip = createRoundtripTest(
        encodePrivateMessageContent({ kind: 'alwaysPad', paddingLength: 80000 }),
        decodePrivateMessageContent('application')
    )
    roundtrip(t, content, 'should roundtrip with 80000 bytes of padding')
})

test('PrivateMessageContent roundtrip with padding until 4000 bytes', (t) => {
    const config:PaddingConfig = { kind: 'padUntilLength', padUntilLength: 4000 }
    const roundtrip = createRoundtripTest(
        encodePrivateMessageContent(config),
        decodePrivateMessageContent('application')
    )
    roundtrip(t, content, 'should roundtrip with padding until 4000 bytes')

    const encoded = encodePrivateMessageContent(config)(content)
    t.equal(encoded.length, 4000, 'encoded length should be 4000')
})

test('PrivateMessageContent fails to decode with non-zero padding', (t) => {
    const encoded = encodePrivateMessageContent({ kind: 'alwaysPad', paddingLength: 2048 })(content)

    t.ok(
        decodePrivateMessageContent('application')(encoded, 0),
        'should decode message with valid padding'
    )

    encoded[encoded.length - 1024] = 1

    t.equal(
        decodePrivateMessageContent('application')(encoded, 0),
        undefined,
        'should fail to decode message with non-zero padding'
    )
})
