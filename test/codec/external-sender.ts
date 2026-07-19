import { test } from '@substrate-system/tapzero'
import type { ExternalSender } from '../../src/external-sender.js'
import {
    encodeExternalSender,
    decodeExternalSender,
    encodeExternalSenders,
    decodeExternalSenders
} from '../../src/external-sender.js'
import { createRoundtripTest } from './roundtrip.js'

const basic:ExternalSender = {
    signaturePublicKey: new Uint8Array([1, 2, 3]),
    credential: { credentialType: 'basic', identity: new Uint8Array([4, 5, 6]) },
}

const x509:ExternalSender = {
    signaturePublicKey: new Uint8Array([7, 8, 9, 10, 11]),
    credential: { credentialType: 'x509', certificates: [new Uint8Array([12, 13]), new Uint8Array([14, 15, 16])] },
}

const roundtrip = createRoundtripTest(
    encodeExternalSender,
    decodeExternalSender
)

test('externalSender roundtrip basic', (t) => {
    roundtrip(t, basic, 'should roundtrip basic external sender')
})

test('externalSender roundtrip x509', (t) => {
    roundtrip(t, x509, 'should roundtrip x509 external sender')
})

const vectorRoundtrip = createRoundtripTest(
    encodeExternalSenders,
    decodeExternalSenders
)

test('externalSenders vector roundtrip with two entries', (t) => {
    vectorRoundtrip(
        t,
        [basic, x509],
        'should roundtrip a vector of two external senders as a single extension payload'
    )
})

test('externalSenders vector roundtrip preserves order/index', (t) => {
    const encoded = encodeExternalSenders([basic, x509])
    const decoded = decodeExternalSenders(encoded, 0)

    t.ok(decoded !== undefined, 'should decode')
    if (decoded === undefined) return

    const [senders] = decoded
    t.equal(senders.length, 2, 'should decode two senders')
    t.equal(
        senders[0]?.credential.credentialType,
        'basic',
        'SenderIndex 0 should resolve to the first entry in the vector'
    )
    t.equal(
        senders[1]?.credential.credentialType,
        'x509',
        'SenderIndex 1 should resolve to the second entry in the vector'
    )
})
