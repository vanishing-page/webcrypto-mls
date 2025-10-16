import { test } from '@substrate-system/tapzero'
import type { RatchetTree } from '../../src/ratchetTree.js'
import { encodeRatchetTree, decodeRatchetTree } from '../../src/ratchetTree.js'

test('RatchetTree roundtrip single leaf', (t) => {
    const data: RatchetTree = [
        {
            nodeType: 'leaf',
            leaf: {
                hpkePublicKey: new Uint8Array([1]),
                signaturePublicKey: new Uint8Array([2]),
                credential: { credentialType: 'basic', identity: new Uint8Array([3]) },
                capabilities: {
                    versions: ['mls10'],
                    ciphersuites: ['MLS_256_XWING_AES256GCM_SHA512_Ed25519'],
                    extensions: [],
                    proposals: [],
                    credentials: [],
                },
                leafNodeSource: 'key_package',
                lifetime: { notBefore: 0n, notAfter: 0n },
                extensions: [],
                signature: new Uint8Array([4]),
            },
        },
    ]
    const encoded = encodeRatchetTree(data)
    const decoded = decodeRatchetTree(encoded, 0)?.[0] as RatchetTree
    t.deepEqual(decoded, data, 'should roundtrip single leaf')
})

test('RatchetTree roundtrip tree', (t) => {
    const data: RatchetTree = [
        {
            nodeType: 'leaf',
            leaf: {
                hpkePublicKey: new Uint8Array([1]),
                signaturePublicKey: new Uint8Array([2]),
                credential: { credentialType: 'basic', identity: new Uint8Array([3]) },
                capabilities: {
                    versions: ['mls10'],
                    ciphersuites: ['MLS_256_XWING_AES256GCM_SHA512_Ed25519'],
                    extensions: [],
                    proposals: [],
                    credentials: [],
                },
                leafNodeSource: 'key_package',
                lifetime: { notBefore: 0n, notAfter: 0n },
                extensions: [],
                signature: new Uint8Array([4]),
            },
        },
        {
            nodeType: 'parent',
            parent: {
                hpkePublicKey: new Uint8Array([1, 2]),
                parentHash: new Uint8Array([3, 4]),
                unmergedLeaves: [0],
            },
        },
        {
            nodeType: 'leaf',
            leaf: {
                hpkePublicKey: new Uint8Array([5]),
                signaturePublicKey: new Uint8Array([6]),
                credential: { credentialType: 'basic', identity: new Uint8Array([7]) },
                capabilities: {
                    versions: ['mls10'],
                    ciphersuites: ['MLS_256_XWING_AES256GCM_SHA512_Ed25519'],
                    extensions: [],
                    proposals: [],
                    credentials: [],
                },
                leafNodeSource: 'key_package',
                lifetime: { notBefore: 0n, notAfter: 0n },
                extensions: [],
                signature: new Uint8Array([4]),
            },
        },
    ]
    const encoded = encodeRatchetTree(data)
    const decoded = decodeRatchetTree(encoded, 0)?.[0] as RatchetTree
    t.deepEqual(decoded, data, 'should roundtrip tree')
})
