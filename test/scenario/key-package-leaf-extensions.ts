import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension } from '../../src/extension.js'
import type { LeafNode } from '../../src/leaf-node.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { ValidationError } from '../../src/mls-error.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Stands in for `last_resort`: a KeyPackage-only extension, which no
// leaf in this test lists in its capabilities.
const KEY_PACKAGE_ONLY_TYPE = 0xff0a
const LEAF_TYPE = 0xff0b

const keyPackageExtension:Extension = {
    extensionType: KEY_PACKAGE_ONLY_TYPE,
    extensionData: new Uint8Array(),
}
const leafExtension:Extension = {
    extensionType: LEAF_TYPE,
    extensionData: new TextEncoder().encode('leaf data'),
}

for (const cs of sampleCiphersuites()) {
    test(`KeyPackage and leaf extensions are separate ${cs}`, async (t) => {
        try {
            await separateExtensions(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

function credential (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
}

function leafAt (state:ClientState, leafIndex:number):LeafNode {
    const node = state.ratchetTree[leafToNodeIndex(toLeafIndex(leafIndex))]
    if (node?.nodeType !== 'leaf') throw new Error('expected a leaf')
    return node.leaf
}

async function separateExtensions (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const leafCaps:Capabilities = {
        ...defaultCapabilities(),
        extensions: [LEAF_TYPE],
    }

    const alice = await generateKeyPackage(
        credential('alice'),
        leafCaps,
        defaultLifetime(),
        [],
        impl
    )
    let aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const carol = await generateKeyPackage(
        credential('carol'),
        leafCaps,
        defaultLifetime(),
        [],
        impl
    )
    const addCarol = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: carol.publicPackage },
            }],
        },
    )
    aliceGroup = addCarol.newState
    let carolGroup = await joinGroup(
        addCarol.welcome!,
        carol.publicPackage,
        carol.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )

    // bob's KeyPackage carries an extension bob's leaf capabilities do
    // not list, and bob's leaf carries one they do.
    const bob = await generateKeyPackage(
        credential('bob'),
        leafCaps,
        defaultLifetime(),
        [keyPackageExtension],
        impl,
        { leafExtensions: [leafExtension] },
    )
    t.deepEqual(
        bob.publicPackage.extensions,
        [keyPackageExtension],
        'the KeyPackage carries the KeyPackage extension'
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }
    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal] },
    )
    aliceGroup = addBob.newState

    if (addBob.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }
    carolGroup = (await processPrivateMessage(
        carolGroup,
        addBob.commit.privateMessage,
        makePskIndex(carolGroup, {}),
        impl,
    )).newState

    const bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )

    for (const [name, state] of [
        ['alice', aliceGroup],
        ['carol', carolGroup],
        ['bob', bobGroup],
    ] as const) {
        t.deepEqual(
            leafAt(state, 2).extensions,
            [leafExtension],
            `${name} sees only the leaf extensions on bob's leaf`
        )
    }

    await testEveryoneCanMessageEveryone(
        [aliceGroup, carolGroup, bobGroup],
        impl,
        t
    )

    // with no leaf extensions passed, the leaf has none
    const dave = await generateKeyPackage(
        credential('dave'),
        leafCaps,
        defaultLifetime(),
        [keyPackageExtension],
        impl,
    )
    const addDave = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: dave.publicPackage },
            }],
        },
    )
    const daveGroup = await joinGroup(
        addDave.welcome!,
        dave.publicPackage,
        dave.privatePackage,
        emptyPskIndex,
        impl,
        addDave.newState.ratchetTree,
        undefined,
        testClientConfig
    )
    t.deepEqual(
        leafAt(addDave.newState, 3).extensions,
        [],
        'alice sees no extensions on dave\'s leaf'
    )
    t.deepEqual(
        leafAt(daveGroup, 3).extensions,
        [],
        'dave sees no extensions on dave\'s own leaf'
    )

    // a leaf extension the leaf capabilities do not list is still refused
    const erin = await generateKeyPackage(
        credential('erin'),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
        { leafExtensions: [leafExtension] },
    )
    try {
        await createCommit(
            { state: aliceGroup, cipherSuite: impl },
            {
                extraProposals: [{
                    proposalType: 'add',
                    add: { keyPackage: erin.publicPackage },
                }],
            },
        )
        t.fail('an unlisted leaf extension should be refused')
    } catch (error) {
        t.ok(
            error instanceof ValidationError,
            'an unlisted leaf extension is refused with ValidationError'
        )
    }
}
