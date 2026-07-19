import { test } from '@substrate-system/tapzero'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import { encodeRatchetTree, decodeRatchetTree } from '../../src/ratchet-tree.js'
import { directPath, toNodeIndex } from '../../src/treemath.js'
import { ValidationError } from '../../src/mls-error.js'

test('RatchetTree roundtrip single leaf', (t) => {
    const data:RatchetTree = [
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
    const data:RatchetTree = [
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

test('RatchetTree rejects an out-of-range unmergedLeaves entry on decode', (t) => {
    const leafNode = {
        hpkePublicKey: new Uint8Array([1]),
        signaturePublicKey: new Uint8Array([2]),
        credential: { credentialType: 'basic' as const, identity: new Uint8Array([3]) },
        capabilities: {
            versions: ['mls10' as const],
            ciphersuites: ['MLS_256_XWING_AES256GCM_SHA512_Ed25519' as const],
            extensions: [],
            proposals: [],
            credentials: [],
        },
        leafNodeSource: 'key_package' as const,
        lifetime: { notBefore: 0n, notAfter: 0n },
        extensions: [],
        signature: new Uint8Array([4]),
    }

    const data:RatchetTree = [
        { nodeType: 'leaf', leaf: leafNode },
        {
            nodeType: 'parent',
            parent: {
                hpkePublicKey: new Uint8Array([1, 2]),
                parentHash: new Uint8Array([3, 4]),
                // Only leaf index 0 exists in this 1-leaf tree; 0xFFFFFFFF
                // is a malformed/malicious out-of-range leaf index.
                unmergedLeaves: [0xFFFFFFFF],
            },
        },
        { nodeType: 'leaf', leaf: leafNode },
    ]

    const encoded = encodeRatchetTree(data)
    const decoded = decodeRatchetTree(encoded, 0)
    t.equal(decoded, undefined, 'should reject a tree with an out-of-range unmergedLeaves entry')
})

test('treemath rejects an out-of-range node index instead of hanging', (t) => {
    t.throws(
        () => directPath(toNodeIndex(0xFFFFFFFF), 4),
        'directPath should throw for an out-of-range node index',
    )
    try {
        directPath(toNodeIndex(0xFFFFFFFF), 4)
        t.fail('should have thrown')
    } catch (err) {
        t.ok(err instanceof ValidationError, 'should throw a ValidationError')
    }
})
