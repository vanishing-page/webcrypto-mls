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
