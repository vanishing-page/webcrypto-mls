import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { processPrivateMessage } from '../../src/processMessages.js'
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
    test('3-party join ' + cs, async (t) => {
        await threePartyJoin(t, cs as CiphersuiteName)
    })
}

async function threePartyJoin (t: any, cipherSuite: CiphersuiteName) {
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

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob epochAuthenticator should match')

    const addCharlieProposal: ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: charlie.publicPackage,
        },
    }

    const addCharlieCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addCharlieProposal],
        },
    )

    aliceGroup = addCharlieCommitResult.newState

    if (addCharlieCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processAddCharlieResult = await processPrivateMessage(
        bobGroup,
        addCharlieCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = processAddCharlieResult.newState

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob epochAuthenticator should match after charlie added')

    const charlieGroup = await joinGroup(
    addCharlieCommitResult.welcome!,
    charlie.publicPackage,
    charlie.privatePackage,
    emptyPskIndex,
    impl,
    aliceGroup.ratchetTree,
    )

    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'charlie epochAuthenticator should match')

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await checkHpkeKeysMatch(charlieGroup, impl, t)
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup, charlieGroup], impl, t)
}
