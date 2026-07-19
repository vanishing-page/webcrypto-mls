import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/key-match.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { leafWidth, nodeToLeafIndex, toNodeIndex } from '../../src/treemath.js'

// Regression test for filteredDirectPath's leaf-width computation. At a
// 4-leaf tree, tree.length (7) is odd, so the buggy
// `nodeToLeafIndex(toNodeIndex(tree.length))` (7 / 2 = 3.5) diverges from
// the correct `leafWidth(tree.length)` (4). An UpdatePath commit at this
// tree size exercises filteredDirectPath's copath/direct-path computation
// with the correct width.
for (const cs of Object.keys(ciphersuites)) {
    test('Leaf-width computation in filteredDirectPath (4 leaves) ' + cs, async (t) => {
        try {
            await leafWidthUpdatePath(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function leafWidthUpdatePath (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    async function makeMember (name:string) {
        const credential:Credential = {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        }
        return generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime,
            [],
            impl,
        )
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const charlie = await makeMember('charlie')
    const dave = await makeMember('dave')

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }
    const addCharlieProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: charlie.publicPackage },
    }
    const addDaveProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: dave.publicPackage },
    }

    // Reach a 4-leaf tree (tree.length === 7).
    const addAllCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal, addCharlieProposal, addDaveProposal] },
    )

    aliceGroup = addAllCommitResult.newState

    let bobGroup = await joinGroup(
        addAllCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    let charlieGroup = await joinGroup(
        addAllCommitResult.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    let daveGroup = await joinGroup(
        addAllCommitResult.welcome!,
        dave.publicPackage,
        dave.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    t.equal(aliceGroup.ratchetTree.length, 7, 'tree should have 7 nodes (4 leaves)')

    // Confirm this tree size actually exercises the divergence: the old,
    // buggy expression (tree.length / 2, non-integer) disagrees with the
    // correct leafWidth(tree.length) at this size.
    const buggyLeafWidth = nodeToLeafIndex(toNodeIndex(aliceGroup.ratchetTree.length))
    const correctLeafWidth = leafWidth(aliceGroup.ratchetTree.length)
    t.ok(buggyLeafWidth !== correctLeafWidth,
        'tree.length / 2 should differ from leafWidth(tree.length) at this size')
    t.equal(correctLeafWidth, 4, 'leafWidth(7) should be 4')

    // An empty-proposal commit still requires an UpdatePath (US-001), which
    // exercises filteredDirectPath's leaf-width computation at this tree size.
    const updatePathCommitResult = await createCommit({
        state: aliceGroup,
        cipherSuite: impl,
    })

    if (updatePathCommitResult.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }

    aliceGroup = updatePathCommitResult.newState

    const bobProcessResult = await processPrivateMessage(
        bobGroup,
        updatePathCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )
    bobGroup = bobProcessResult.newState

    const charlieProcessResult = await processPrivateMessage(
        charlieGroup,
        updatePathCommitResult.commit.privateMessage,
        makePskIndex(charlieGroup, {}),
        impl,
    )
    charlieGroup = charlieProcessResult.newState

    const daveProcessResult = await processPrivateMessage(
        daveGroup,
        updatePathCommitResult.commit.privateMessage,
        makePskIndex(daveGroup, {}),
        impl,
    )
    daveGroup = daveProcessResult.newState

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator, 'bob should match')
    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator, 'charlie should match')
    t.deepEqual(daveGroup.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator, 'dave should match')

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await checkHpkeKeysMatch(charlieGroup, impl, t)
    await checkHpkeKeysMatch(daveGroup, impl, t)

    await testEveryoneCanMessageEveryone(
        [aliceGroup, bobGroup, charlieGroup, daveGroup], impl, t)
}
