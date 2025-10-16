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
    test(`External join ${cs}`, async (t) => {
        await externalJoin(cs as CiphersuiteName, t)
    })
}

async function externalJoin (cipherSuite: CiphersuiteName, t: any) {
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

    const addBobCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addBobProposal],
        },
    )

    aliceGroup = addBobCommitResult.newState

    let bobGroup = await joinGroup(
    addBobCommitResult.welcome!,
    bob.publicPackage,
    bob.privatePackage,
    emptyPskIndex,
    impl,
    aliceGroup.ratchetTree,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob should have matching epoch authenticator')

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(aliceGroup, [], impl)

    const charlieJoinGroupCommitResult = await joinGroupExternal(
        groupInfo,
        charlie.publicPackage,
        charlie.privatePackage,
        false,
        impl,
    )

    const charlieGroup = charlieJoinGroupCommitResult.newState

    const aliceProcessCharlieJoinResult = await processPublicMessage(
        aliceGroup,
        charlieJoinGroupCommitResult.publicMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    aliceGroup = aliceProcessCharlieJoinResult.newState

    const bobProcessCharlieJoinResult = await processPublicMessage(
        bobGroup,
        charlieJoinGroupCommitResult.publicMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = bobProcessCharlieJoinResult.newState

    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'charlie should have matching epoch authenticator with alice')
    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, bobGroup.keySchedule.epochAuthenticator, 'charlie should have matching epoch authenticator with bob')

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await checkHpkeKeysMatch(charlieGroup, impl, t)
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup, charlieGroup], impl, t)
}
