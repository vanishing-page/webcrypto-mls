import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createGroupInfoWithExternalPub,
    createCommit
} from '../../src/create-commit.js'
import {
    processPrivateMessage,
    processPublicMessage
} from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/key-match.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { ExternalSender } from '../../src/external-sender.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { Extension } from '../../src/extension.js'
import { proposeExternal } from '../../src/external-proposal.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`External Proposal ${cs}`, async (t) => {
        try {
            await externalProposalTest(cs as CiphersuiteName, t)
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function externalProposalTest (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(
        bobCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const charlieCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('charlie')
    }
    const charlie = await generateKeyPackage(
        charlieCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const groupId = new TextEncoder().encode('group1')

    const externalSender:ExternalSender = {
        credential: charlieCredential,
        signaturePublicKey: charlie.publicPackage.leafNode.signaturePublicKey,
    }

    const extension:Extension = {
        extensionType: 'external_senders',
        extensionData: encodeExternalSenders([externalSender]),
    }

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [extension], impl)

    const addBobProposal:ProposalAdd = {
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

    // external pub not really necessary here
    const groupInfo = await createGroupInfoWithExternalPub(aliceGroup, [], impl)

    const removeBobProposal:Proposal = {
        proposalType: 'remove',
        remove: {
            removed: 1,
        },
    }

    const addCharlieProposal = await proposeExternal(
        groupInfo,
        removeBobProposal,
        charlie.publicPackage.leafNode.signaturePublicKey,
        charlie.privatePackage.signaturePrivateKey,
        impl,
    )

    if (addCharlieProposal.wireformat !== 'mls_public_message') throw new Error('Expected public message')

    const aliceProcessCharlieProposalResult = await processPublicMessage(
        aliceGroup,
        addCharlieProposal.publicMessage,
        emptyPskIndex,
        impl,
    )

    aliceGroup = aliceProcessCharlieProposalResult.newState

    const bobProcessCharlieProposalResult = await processPublicMessage(
        bobGroup,
        addCharlieProposal.publicMessage,
        emptyPskIndex,
        impl,
    )

    bobGroup = bobProcessCharlieProposalResult.newState

    const removeBobCommitResult = await createCommit({
        state: aliceGroup,
        cipherSuite: impl,
    })

    aliceGroup = removeBobCommitResult.newState

    if (removeBobCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processRemoveBobResult = await processPrivateMessage(
        bobGroup,
        removeBobCommitResult.commit.privateMessage,
        emptyPskIndex,
        impl,
    )

    bobGroup = processRemoveBobResult.newState

    t.equal(bobGroup.groupActiveState.kind, 'removedFromGroup', 'bob should be removed from group')

    await checkHpkeKeysMatch(aliceGroup, impl, t)
}
