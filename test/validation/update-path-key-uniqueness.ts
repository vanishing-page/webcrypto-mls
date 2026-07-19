import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { applyUpdatePath, createUpdatePath } from '../../src/update-path.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { toLeafIndex } from '../../src/treemath.js'

// RFC 9420 SS7.6: the HPKEPublicKey values in an UpdatePath's nodes MUST be
// distinct from every public key already present in the ratchet tree
// (leaves included, not just parent nodes) AND from each other within the
// UpdatePath itself. Reusing a key lets an attacker who controls that key
// decrypt path secrets meant for a different node.
for (const cs of Object.keys(ciphersuites)) {
    test('applyUpdatePath rejects a path key colliding with an existing ' +
        'leaf key - ' + cs, async (t) => {
        try {
            await rejectsLeafKeyCollision(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('applyUpdatePath rejects duplicate keys within the UpdatePath ' +
        'itself - ' + cs, async (t) => {
        try {
            await rejectsIntraPathDuplicate(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeMember (name:string, impl:any) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
}

async function rejectsLeafKeyCollision (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: bob.publicPackage } } satisfies ProposalAdd,
            ],
        },
    )

    aliceGroup = addBob.newState

    const aliceLeafIndex = toLeafIndex(aliceGroup.privatePath.leafIndex)

    const [, updatePath] = await createUpdatePath(
        aliceGroup.ratchetTree,
        aliceLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.signaturePrivateKey,
        impl,
    )

    const bobLeaf = aliceGroup.ratchetTree.find((n) => n?.nodeType === 'leaf' && n.leaf.credential.credentialType === 'basic' &&
        new TextDecoder().decode(n.leaf.credential.identity) === 'bob')

    if (bobLeaf === undefined || bobLeaf.nodeType !== 'leaf') throw new Error('expected to find bob leaf')

    const tamperedPath = {
        ...updatePath,
        nodes: [
            { ...updatePath.nodes[0]!, hpkePublicKey: bobLeaf.leaf.hpkePublicKey },
        ],
    }

    let caught:unknown
    try {
        await applyUpdatePath(aliceGroup.ratchetTree, aliceLeafIndex, tamperedPath, impl.hash)
    } catch (err) {
        caught = err
    }

    // assert the *specific* collision check fired, not merely that some
    // ValidationError was thrown -- tampering a path key also perturbs the
    // recomputed parent-hash chain, which throws its own (unrelated)
    // ValidationError further down applyUpdatePath and would otherwise mask
    // a missing collision check
    t.ok(
        caught instanceof ValidationError &&
            caught.message === 'Public keys in the UpdatePath may not appear ' +
                'in a node of the new ratchet tree',
        'should reject a path key that collides with an existing leaf key',
    )
}

async function rejectsIntraPathDuplicate (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const eve = await makeMember('eve', impl)
    const charlie = await makeMember('charlie', impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    const addAll = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: bob.publicPackage } } satisfies ProposalAdd,
                { proposalType: 'add', add: { keyPackage: eve.publicPackage } } satisfies ProposalAdd,
                { proposalType: 'add', add: { keyPackage: charlie.publicPackage } } satisfies ProposalAdd,
            ],
        },
    )

    aliceGroup = addAll.newState

    const aliceLeafIndex = toLeafIndex(aliceGroup.privatePath.leafIndex)

    const [, updatePath] = await createUpdatePath(
        aliceGroup.ratchetTree,
        aliceLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.signaturePrivateKey,
        impl,
    )

    t.ok(updatePath.nodes.length >= 2, 'a 4-leaf tree should have a multi-node direct path')

    const tamperedPath = {
        ...updatePath,
        nodes: updatePath.nodes.map((n, i) => i === 0 ? { ...n, hpkePublicKey: updatePath.nodes[1]!.hpkePublicKey } : n),
    }

    let caught:unknown
    try {
        await applyUpdatePath(aliceGroup.ratchetTree, aliceLeafIndex, tamperedPath, impl.hash)
    } catch (err) {
        caught = err
    }

    // assert the *specific* intra-path duplicate check fired -- see the
    // comment in rejectsLeafKeyCollision above for why checking merely
    // `instanceof ValidationError` would pass for the wrong reason
    t.ok(
        caught instanceof ValidationError &&
            caught.message === 'Public keys in the UpdatePath must be ' +
                'distinct from each other',
        'should reject duplicate keys within the same UpdatePath',
    )
}
