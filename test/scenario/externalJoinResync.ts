import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/clientState.js'
import { createGroupInfoWithExternalPubAndRatchetTree, joinGroupExternal, createCommit } from '../../src/createCommit.js'
import { processPublicMessage } from '../../src/processMessages.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName, ciphersuites } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/keyMatch.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/defaultCapabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`External join Resync ${cs}`, async (t) => {
        await externalJoinResyncTest(cs as CiphersuiteName, t)
    })
}

async function externalJoinResyncTest (cipherSuite: CiphersuiteName, t: any) {
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
            ratchetTreeExtension: true,
        },
    )

    aliceGroup = addBobAndCharlieCommitResult.newState

    let bobGroup = await joinGroup(
    addBobAndCharlieCommitResult.welcome!,
    bob.publicPackage,
    bob.privatePackage,
    emptyPskIndex,
    impl,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob should have matching epoch authenticator')

    let charlieGroup = await joinGroup(
    addBobAndCharlieCommitResult.welcome!,
    charlie.publicPackage,
    charlie.privatePackage,
    emptyPskIndex,
    impl,
    )

    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'charlie should have matching epoch authenticator')

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(charlieGroup, [], impl)

    const charlieResyncCommitResult = await joinGroupExternal(
        groupInfo,
        charlie.publicPackage,
        charlie.privatePackage,
        true,
        impl,
    )

    charlieGroup = charlieResyncCommitResult.newState

    const aliceProcessCharlieResyncResult = await processPublicMessage(
        aliceGroup,
        charlieResyncCommitResult.publicMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    aliceGroup = aliceProcessCharlieResyncResult.newState

    const bobProcessCharlieResyncResult = await processPublicMessage(
        bobGroup,
        charlieResyncCommitResult.publicMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = bobProcessCharlieResyncResult.newState

    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'charlie should have matching epoch authenticator with alice after resync')
    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, bobGroup.keySchedule.epochAuthenticator, 'charlie should have matching epoch authenticator with bob after resync')

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await checkHpkeKeysMatch(charlieGroup, impl, t)
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup, charlieGroup], impl, t)
}
