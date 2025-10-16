import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { createProposal } from '../../src/createMessage.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/keyMatch.js'
import { cannotMessageAnymore, testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/defaultCapabilities.js'
import type { WireformatName } from '../../src/wireformat.js'
import { processMessage } from '../../src/processMessages.js'
import { acceptAll } from '../../src/incomingMessageAction.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Leave Proposal ' + cs, async (t) => {
        await leaveProposal(t, cs as CiphersuiteName, true)
        await leaveProposal(t, cs as CiphersuiteName, false)
    })
}

async function leaveProposal (t: any, cipherSuite: CiphersuiteName, publicMessage: boolean) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const preferredWireformat: WireformatName = publicMessage ? 'mls_public_message' : 'mls_private_message'
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
            wireAsPublicMessage: publicMessage,
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

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'should match')

    let charlieGroup = await joinGroup(
    addBobAndCharlieCommitResult.welcome!,
    charlie.publicPackage,
    charlie.privatePackage,
    emptyPskIndex,
    impl,
    )

    t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'should match')

    const leaveProposal: Proposal = {
        proposalType: 'remove',
        remove: { removed: aliceGroup.privatePath.leafIndex },
    }

    const createLeaveProposalResult = await createProposal(aliceGroup, publicMessage, leaveProposal, impl)

    aliceGroup = createLeaveProposalResult.newState

    if (createLeaveProposalResult.message.wireformat !== preferredWireformat) { throw new Error(`Expected ${preferredWireformat} message`) }

    const bobProcessProposalResult = await processMessage(
        createLeaveProposalResult.message,
        bobGroup,
        emptyPskIndex,
        acceptAll,
        impl,
    )

    bobGroup = bobProcessProposalResult.newState

    const charlieProcessProposalResult = await processMessage(
        createLeaveProposalResult.message,
        charlieGroup,
        emptyPskIndex,
        acceptAll,
        impl,
    )

    charlieGroup = charlieProcessProposalResult.newState

    // bob commits to alice leaving
    const bobCommitResult = await createCommit(
        {
            state: bobGroup,
            cipherSuite: impl,
        },
        {
            wireAsPublicMessage: publicMessage,
            ratchetTreeExtension: false,
        },
    )

    bobGroup = bobCommitResult.newState

    if (bobCommitResult.commit.wireformat !== preferredWireformat) { throw new Error(`Expected ${preferredWireformat} message`) }

    const aliceProcessCommitResult = await processMessage(
        bobCommitResult.commit,
        aliceGroup,
        emptyPskIndex,
        acceptAll,
        impl,
    )
    aliceGroup = aliceProcessCommitResult.newState

    const charlieProcessCommitResult = await processMessage(
        bobCommitResult.commit,
        charlieGroup,
        emptyPskIndex,
        acceptAll,
        impl,
    )
    charlieGroup = charlieProcessCommitResult.newState

    t.deepEqual(bobGroup.unappliedProposals, {}, 'bob should have no unapplied proposals')
    t.deepEqual(charlieGroup.unappliedProposals, {}, 'charlie should have no unapplied proposals')
    t.deepEqual(aliceGroup.groupActiveState, { kind: 'removedFromGroup' }, 'should match')

    await cannotMessageAnymore(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await checkHpkeKeysMatch(charlieGroup, impl, t)
    await testEveryoneCanMessageEveryone([bobGroup, charlieGroup], impl, t)
}
