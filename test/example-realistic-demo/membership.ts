import { test } from '@substrate-system/tapzero'
import {
    membersFromTree,
    leafIndexOf
} from '../../example-realistic-demo/client/membership.js'
import { bytesToBase64url, defaultCapabilities } from '../../src/index.js'
import type { RatchetTree, Node } from '../../src/ratchet-tree.js'

/**
 * The minimum a leaf node needs for these two functions. Everything
 * else the `LeafNode` type requires is filled with empty bytes; nothing
 * here is signed or verified, which is the point of keeping the
 * derivation pure.
 */
function leaf (name:string, signatureKey:number[]):Node {
    return {
        nodeType: 'leaf',
        leaf: {
            hpkePublicKey: new Uint8Array(),
            signaturePublicKey: new Uint8Array(signatureKey),
            credential: {
                credentialType: 'basic',
                identity: new TextEncoder().encode(name)
            },
            capabilities: defaultCapabilities(),
            leafNodeSource: 'update',
            extensions: [],
            signature: new Uint8Array()
        }
    }
}

function x509Leaf (signatureKey:number[]):Node {
    return {
        nodeType: 'leaf',
        leaf: {
            hpkePublicKey: new Uint8Array(),
            signaturePublicKey: new Uint8Array(signatureKey),
            credential: {
                credentialType: 'x509',
                certificates: []
            },
            capabilities: defaultCapabilities(),
            leafNodeSource: 'update',
            extensions: [],
            signature: new Uint8Array()
        }
    }
}

function parentNode ():Node {
    return {
        nodeType: 'parent',
        parent: {
            hpkePublicKey: new Uint8Array([9, 9]),
            parentHash: new Uint8Array(),
            unmergedLeaves: []
        }
    }
}

// membersFromTree -- realistic-demo.AC5.1

test('membersFromTree - an empty tree has no members', (t) => {
    t.deepEqual(membersFromTree([]), [])
})

test('membersFromTree - a single leaf is leaf index 0', (t) => {
    const tree:RatchetTree = [leaf('alice', [1, 2, 3])]
    const members = membersFromTree(tree)

    t.equal(members.length, 1, 'one member')
    t.equal(members[0]!.leafIndex, 0, 'leaf index 0')
    t.equal(members[0]!.name, 'alice', 'name from the credential')
})

test('membersFromTree - leaves come from even node indices', (t) => {
    const tree:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        leaf('bob', [2]),
        parentNode(),
        leaf('carol', [3])
    ]
    const members = membersFromTree(tree)

    t.deepEqual(
        members.map(m => m.leafIndex),
        [0, 1, 2],
        'node indices 0, 2, 4 are leaf indices 0, 1, 2'
    )
    t.deepEqual(
        members.map(m => m.name),
        ['alice', 'bob', 'carol'],
        'in leaf order'
    )
})

test('membersFromTree - parent nodes are not members', (t) => {
    const tree:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        leaf('bob', [2])
    ]
    const members = membersFromTree(tree)

    t.equal(members.length, 2, 'only the two leaves')
    t.ok(
        members.every(m => m.name === 'alice' || m.name === 'bob'),
        'no member came from the parent node'
    )
})

test('membersFromTree - a non-leaf at an even index is not a member', (t) => {
    // A well-formed tree never puts a parent at an even index, so the
    // even-index stride alone would let this through. Only members come
    // from leaves, whatever the array happens to hold.
    const tree:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        parentNode(),
        parentNode(),
        leaf('carol', [3])
    ]
    const members = membersFromTree(tree)

    t.deepEqual(
        members.map(m => m.name),
        ['alice', 'carol'],
        'the parent at node index 2 produced no member'
    )
    t.deepEqual(
        members.map(m => m.leafIndex),
        [0, 2],
        'and the leaves either side keep their indices'
    )
})

// realistic-demo.AC5.4 -- the blanked leaf

test('membersFromTree - a blanked leaf is skipped', (t) => {
    const tree:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        undefined,
        parentNode(),
        leaf('carol', [3])
    ]
    const members = membersFromTree(tree)

    t.deepEqual(
        members.map(m => m.name),
        ['alice', 'carol'],
        'the blanked member is gone'
    )
    t.deepEqual(
        members.map(m => m.leafIndex),
        [0, 2],
        'the survivors keep their original leaf indices'
    )
})

test('membersFromTree - a blanked leaf 0 does not renumber', (t) => {
    const tree:RatchetTree = [
        undefined,
        parentNode(),
        leaf('bob', [2])
    ]
    const members = membersFromTree(tree)

    t.equal(members.length, 1, 'one survivor')
    t.equal(members[0]!.leafIndex, 1, 'bob is still leaf 1, not leaf 0')
    t.equal(members[0]!.name, 'bob', 'and it is bob')
})

test('membersFromTree - identity is the signature key, base64url', (t) => {
    const key = [200, 201, 202, 63, 62]
    const tree:RatchetTree = [leaf('alice', key)]
    const members = membersFromTree(tree)

    t.equal(
        members[0]!.identity,
        bytesToBase64url(new Uint8Array(key)),
        'matches what the room uses on the wire'
    )
    t.ok(
        members[0]!.identity !== 'alice',
        'identity is not the credential name'
    )
})

test('membersFromTree - a non-basic credential is labelled', (t) => {
    const tree:RatchetTree = [x509Leaf([7])]
    const members = membersFromTree(tree)

    t.equal(members[0]!.name, '(non-basic credential)')
    t.equal(
        members[0]!.identity,
        bytesToBase64url(new Uint8Array([7])),
        'the identity still comes from the signature key'
    )
})

// leafIndexOf

test('leafIndexOf - finds a present identity', (t) => {
    const tree:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        leaf('bob', [2]),
        parentNode(),
        leaf('carol', [3])
    ]

    t.equal(leafIndexOf(tree, bytesToBase64url(new Uint8Array([1]))), 0)
    t.equal(leafIndexOf(tree, bytesToBase64url(new Uint8Array([2]))), 1)
    t.equal(leafIndexOf(tree, bytesToBase64url(new Uint8Array([3]))), 2)
})

test('leafIndexOf - null for an identity that is not there', (t) => {
    const tree:RatchetTree = [leaf('alice', [1])]

    t.equal(leafIndexOf(tree, bytesToBase64url(new Uint8Array([9]))), null)
    t.equal(leafIndexOf(tree, 'alice'), null, 'not the name either')
    t.equal(leafIndexOf([], 'anything'), null, 'nor in an empty tree')
})

test('leafIndexOf - null once that leaf has been blanked', (t) => {
    const identity = bytesToBase64url(new Uint8Array([2]))
    const before:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        leaf('bob', [2])
    ]
    const after:RatchetTree = [
        leaf('alice', [1]),
        parentNode(),
        undefined
    ]

    t.equal(leafIndexOf(before, identity), 1, 'found before the removal')
    t.equal(leafIndexOf(after, identity), null, 'gone after it')
})
