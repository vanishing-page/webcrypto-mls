import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    acceptAll,
    createGroup,
    getGroupMembers,
    getOwnLeafNode,
    joinGroup,
    makePskIndex,
    processMessage,
    type ClientState,
} from '../../src/index.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const decoder = new TextDecoder()

for (const cs of sampleCiphersuites()) {
    test('member helpers after a removal ' + cs, async (t) => {
        try {
            await memberHelpers(t, cs)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

function credentialFor (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
}

function identityOf (state:ClientState):string {
    const leaf = getOwnLeafNode(state)
    if (leaf.credential.credentialType !== 'basic') {
        throw new Error('expected a basic credential')
    }
    return decoder.decode(leaf.credential.identity)
}

function membersOf (state:ClientState):[number, string][] {
    return getGroupMembers(state).map(({ leafIndex, leafNode }) => {
        if (leafNode.credential.credentialType !== 'basic') {
            throw new Error('expected a basic credential')
        }
        return [leafIndex, decoder.decode(leafNode.credential.identity)]
    })
}

async function memberHelpers (t:any, cipherSuite:CiphersuiteName) {
    const impl:CiphersuiteImpl =
        await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const kp = (name:string) => generateKeyPackage(
        credentialFor(name),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
    const alice = await kp('alice')
    const bob = await kp('bob')
    const charlie = await kp('charlie')

    let aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const addBoth = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                {
                    proposalType: 'add',
                    add: { keyPackage: bob.publicPackage },
                },
                {
                    proposalType: 'add',
                    add: { keyPackage: charlie.publicPackage },
                },
            ],
        },
    )
    aliceGroup = addBoth.newState

    const join = (pkg:typeof bob) => joinGroup(
        addBoth.welcome!,
        pkg.publicPackage,
        pkg.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig,
    )
    const bobGroup = await join(bob)
    let charlieGroup = await join(charlie)

    t.deepEqual(
        [aliceGroup, bobGroup, charlieGroup].map(identityOf),
        ['alice', 'bob', 'charlie'],
        'getOwnLeafNode carries each member\'s own credential',
    )
    t.deepEqual(
        membersOf(aliceGroup),
        [[0, 'alice'], [1, 'bob'], [2, 'charlie']],
        'all three members are listed before the removal',
    )

    const removeBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'remove', remove: { removed: 1 } },
            ],
        },
    )
    aliceGroup = removeBob.newState
    if (removeBob.commit.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message')
    }

    const processed = await processMessage(
        removeBob.commit,
        charlieGroup,
        makePskIndex(charlieGroup, {}),
        acceptAll,
        impl,
    )
    if (processed.kind !== 'newState') throw new Error('expected newState')
    charlieGroup = processed.newState

    t.deepEqual(
        membersOf(aliceGroup),
        [[0, 'alice'], [2, 'charlie']],
        'alice sees alice and charlie, without bob',
    )
    t.deepEqual(
        membersOf(charlieGroup),
        [[0, 'alice'], [2, 'charlie']],
        'charlie sees the same members',
    )
    t.deepEqual(
        [aliceGroup, charlieGroup].map(identityOf),
        ['alice', 'charlie'],
        'getOwnLeafNode is unchanged by the removal',
    )
}
