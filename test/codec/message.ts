import { test } from '@substrate-system/tapzero'
import { encodeMlsMessage, decodeMlsMessage } from '../../src/message.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeMlsMessage, decodeMlsMessage)

test('MLSMessage roundtrip public message', (t) => {
    roundtrip(t, {
        version: 'mls10',
        wireformat: 'mls_public_message',
        publicMessage: {
            content: {
                contentType: 'application',
                groupId: new Uint8Array([1]),
                epoch: 0n,
                sender: { senderType: 'member', leafIndex: 0 },
                authenticatedData: new Uint8Array([2]),
                applicationData: new Uint8Array([3]),
            },
            auth: { contentType: 'application', signature: new Uint8Array([4, 5, 6]) },
            senderType: 'member',
            membershipTag: new Uint8Array([7, 8, 9]),
        },
    }, 'should roundtrip public message')
})

test('MLSMessage roundtrip private message', (t) => {
    roundtrip(t, {
        version: 'mls10',
        wireformat: 'mls_private_message',
        privateMessage: {
            contentType: 'proposal',
            groupId: new Uint8Array([1]),
            epoch: 0n,
            authenticatedData: new Uint8Array([2, 3]),
            encryptedSenderData: new Uint8Array([4, 5, 6]),
            ciphertext: new Uint8Array([7, 8, 9]),
        },
    }, 'should roundtrip private message')
})

test('MLSMessage roundtrip key package message', (t) => {
    roundtrip(t, {
        version: 'mls10',
        wireformat: 'mls_key_package',
        keyPackage: {
            version: 'mls10',
            cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
            initKey: new Uint8Array([]),
            leafNode: {
                hpkePublicKey: new Uint8Array([]),
                signaturePublicKey: new Uint8Array([]),
                credential: { credentialType: 'basic', identity: new Uint8Array([]) },
                capabilities: {
                    versions: [],
                    ciphersuites: [],
                    extensions: [],
                    proposals: [],
                    credentials: [],
                },
                leafNodeSource: 'key_package',
                lifetime: { notBefore: 0n, notAfter: 0n },
                extensions: [],
                signature: new Uint8Array([]),
            },
            extensions: [],
            signature: new Uint8Array([]),
        },
    }, 'should roundtrip key package message')
})

test('MLSMessage roundtrip welcome', (t) => {
    roundtrip(t, {
        version: 'mls10',
        wireformat: 'mls_welcome',
        welcome: {
            cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
            secrets: [],
            encryptedGroupInfo: new Uint8Array([1]),
        },
    }, 'should roundtrip welcome')
})

test('decodeMlsMessage rejects trailing bytes after a complete message', (t) => {
    const encoded = encodeMlsMessage({
        version: 'mls10',
        wireformat: 'mls_welcome',
        welcome: {
            cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
            secrets: [],
            encryptedGroupInfo: new Uint8Array([1]),
        },
    })
    const withGarbage = new Uint8Array([...encoded, 0xff, 0xff])
    t.equal(
        decodeMlsMessage(withGarbage, 0),
        undefined,
        'should reject input with trailing garbage bytes',
    )
    t.notEqual(
        decodeMlsMessage(encoded, 0),
        undefined,
        'should still decode the exact-length message',
    )
})

test('MLSMessage roundtrip group info message', (t) => {
    roundtrip(t, {
        version: 'mls10',
        wireformat: 'mls_group_info',
        groupInfo: {
            groupContext: {
                version: 'mls10',
                cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
                groupId: new Uint8Array([1, 2, 3]),
                epoch: 0n,
                treeHash: new Uint8Array([4, 5]),
                confirmedTranscriptHash: new Uint8Array([6]),
                extensions: [],
            },
            extensions: [],
            confirmationTag: new Uint8Array([7, 8]),
            signer: 0,
            signature: new Uint8Array([9]),
        },
    }, 'should roundtrip group info message')
})

test('decodeMlsMessage refuses input over the 64 MiB cap', (t) => {
    // A PrivateMessage whose ciphertext fills the input to exactly the
    // cap. Both inputs below are well-formed messages, so the only thing
    // that can refuse the longer one is its length.
    const cap = 64 * 1024 * 1024
    const privateMessage = (ciphertext:Uint8Array) => encodeMlsMessage({
        version: 'mls10',
        wireformat: 'mls_private_message',
        privateMessage: {
            contentType: 'application',
            groupId: new Uint8Array([1]),
            epoch: 0n,
            authenticatedData: new Uint8Array([]),
            encryptedSenderData: new Uint8Array([2]),
            ciphertext,
        },
    })
    const overhead = privateMessage(new Uint8Array(16384)).length - 16384
    const atCap = privateMessage(new Uint8Array(cap - overhead))
    t.equal(atCap.length, cap, 'should build an input of exactly 64 MiB')
    t.ok(
        decodeMlsMessage(atCap, 0) !== undefined,
        'should decode a valid message at the cap',
    )

    const overCap = privateMessage(new Uint8Array(cap - overhead + 1))
    t.equal(overCap.length, cap + 1, 'should build an input one byte over')
    t.ok(
        decodeMlsMessage(overCap, 0) === undefined,
        'should refuse a valid message one byte over the cap',
    )
})

test('MLSMessage and KeyPackage version fields stay strict', (t) => {
    const bytes = encodeMlsMessage({
        version: 'mls10',
        wireformat: 'mls_key_package',
        keyPackage: {
            version: 'mls10',
            cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
            initKey: new Uint8Array([1]),
            leafNode: {
                hpkePublicKey: new Uint8Array([2]),
                signaturePublicKey: new Uint8Array([3]),
                credential: {
                    credentialType: 'basic',
                    identity: new Uint8Array([4]),
                },
                capabilities: {
                    // only the capabilities list is open
                    versions: ['mls10', '2'],
                    ciphersuites: [],
                    extensions: [],
                    proposals: [],
                    credentials: [],
                },
                leafNodeSource: 'key_package',
                lifetime: { notBefore: 0n, notAfter: 0n },
                extensions: [],
                signature: new Uint8Array([5]),
            },
            extensions: [],
            signature: new Uint8Array([6]),
        },
    })
    t.ok(decodeMlsMessage(bytes, 0), 'control: the message decodes')

    // MLSMessage.version is the first uint16
    const unknownTop = bytes.slice()
    unknownTop[1] = 2
    t.equal(decodeMlsMessage(unknownTop, 0), undefined,
        'an unknown MLSMessage version is refused')

    // KeyPackage.version follows the uint16 wire format
    const unknownKp = bytes.slice()
    unknownKp[5] = 2
    t.equal(decodeMlsMessage(unknownKp, 0), undefined,
        'an unknown KeyPackage version is refused')
})
