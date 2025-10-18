import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { processPrivateMessage } from '../../src/processMessages.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/keyMatch.js'
import { cannotMessageAnymore, testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/defaultCapabilities.js'
import { UsageError as _UsageError } from '../../src/mlsError.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Remove ' + cs, async (t) => {
        await remove(t, cs as CiphersuiteName)
    })
}

async function remove (t: any, cipherSuite: CiphersuiteName) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
    const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const charlieCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('charlie') }
    const charlie = await generateKeyPackage(charlieCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const addBobProposal: ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: bob.publicPackage,
        },
    }

    const addCharlieProposal: ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: charlie.publicPackage,
        },
    }

    const addBobAndCharlieCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addBobProposal, addCharlieProposal],
        },
    )

    aliceGroup = addBobAndCharlieCommitResult.newState

    let bobGroup = await joinGroup(
    addBobAndCharlieCommitResult.welcome!,
    bob.publicPackage,
    bob.privatePackage,
    emptyPskIndex,
    impl,
    aliceGroup.ratchetTree,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'should match')

    let charlieGroup = await joinGroup(
    addBobAndCharlieCommitResult.welcome!,
    charlie.publicPackage,
    charlie.privatePackage,
    emptyPskIndex,
    impl,
    aliceGroup.ratchetTree,
    )

    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'should match')

    const removeBobProposal: ProposalRemove = {
        proposalType: 'remove',
        remove: {
            removed: bobGroup.privatePath.leafIndex,
        },
    }

    const removeBobCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [removeBobProposal],
        },
    )

    aliceGroup = removeBobCommitResult.newState

    if (removeBobCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const bobProcessCommitResult = await processPrivateMessage(
        bobGroup,
        removeBobCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    // bob is removed here
    bobGroup = bobProcessCommitResult.newState

    const charlieProcessCommitResult = await processPrivateMessage(
        charlieGroup,
        removeBobCommitResult.commit.privateMessage,
        makePskIndex(charlieGroup, {}),
        impl,
    )

    charlieGroup = charlieProcessCommitResult.newState

    t.deepEqual(bobGroup.groupActiveState, { kind: 'removedFromGroup' }, 'should match')

    // creating a message will fail now
    await t.throws(async () => {
        await createCommit({
            state: bobGroup,
            cipherSuite: impl,
        })
    }, 'should throw UsageError when removed from group')

    await cannotMessageAnymore(bobGroup, impl, t)

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(charlieGroup, impl, t)
    await testEveryoneCanMessageEveryone([aliceGroup, charlieGroup], impl, t)
}
